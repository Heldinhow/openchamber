import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from '../types';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { buildWorkspaceSidebarSections } from './workspaceSections';

const session = (id: string, title = id, directory = '/workspaces/data'): Session => ({
  id,
  projectID: 'opencode-project',
  title,
  directory,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

const node = (id: string, title = id, children: SessionNode[] = []): SessionNode => ({
  session: session(id, title),
  children,
  worktree: null,
});

const workspace = (id: string, projects: string[] = []) => ({
  id,
  name: id.toUpperCase(),
  directory: `/data/workspaces/${id}`,
  projects: projects.map((label) => ({
    projectId: `path_${label}`,
    missing: false,
    project: { id: `path_${label}`, label, path: `/projects/${label}` },
  })),
});

describe('buildWorkspaceSidebarSections', () => {
  test('keeps the workspace order and lists only its own sessions', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_one'), workspace('ws_two'), workspace('ws_empty')],
      sessionsByWorkspace: new Map([
        ['ws_one', [session('one-a')]],
        ['ws_two', [session('two-a'), session('two-b')]],
      ]),
      nestedSessionIds: new Set(),
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: '',
    });

    expect(sections.map((section) => section.workspace.id)).toEqual(['ws_one', 'ws_two', 'ws_empty']);
    expect(sections.map((section) => section.nodes.map((entry) => entry.session.id))).toEqual([
      ['one-a'],
      ['two-a', 'two-b'],
      [],
    ]);
  });

  test('a workspace whose member project is missing keeps its row and sessions', () => {
    // The section is built from the neutral directory; the project catalog is
    // never consulted, so a missing member cannot remove the row.
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_one')],
      sessionsByWorkspace: new Map([['ws_one', [session('one-a')]]]),
      nestedSessionIds: new Set(),
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: '',
    });

    expect(sections.map((section) => section.workspace.id)).toEqual(['ws_one']);
    expect(sections[0].nodes.map((entry) => entry.session.id)).toEqual(['one-a']);
  });

  test('an empty workspace keeps its section without a search', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_one')],
      sessionsByWorkspace: new Map(),
      nestedSessionIds: new Set(),
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: '',
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].nodes).toEqual([]);
  });

  test('a search lists a workspace only when its sessions match', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_one'), workspace('ws_two')],
      sessionsByWorkspace: new Map([
        ['ws_one', [session('one-a', 'Fix login'), session('one-b', 'Unrelated')]],
        ['ws_two', [session('two-a', 'Docs')]],
      ]),
      nestedSessionIds: new Set(),
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: 'login',
    });

    expect(sections.map((section) => section.workspace.id)).toEqual(['ws_one']);
    expect(sections[0].nodes.map((entry) => entry.session.id)).toEqual(['one-a']);
    expect(sections[0].metadataMatch).toBeUndefined();
  });

  test('a workspace name match shows every session of the workspace', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_product'), workspace('ws_other')],
      sessionsByWorkspace: new Map([
        ['ws_product', [session('one-a', 'Fix login'), session('one-b', 'Unrelated')]],
        ['ws_other', [session('two-a', 'Product notes')]],
      ]),
      nestedSessionIds: new Set(),
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: 'ws_product',
    });

    expect(sections.map((section) => section.workspace.id)).toEqual(['ws_product']);
    expect(sections[0].nodes.map((entry) => entry.session.id)).toEqual(['one-a', 'one-b']);
    expect(sections[0].metadataMatch).toBe(true);
  });

  test('a member project match surfaces the workspace and its sessions', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_product', ['Repo A']), workspace('ws_other', ['Repo B'])],
      sessionsByWorkspace: new Map([
        ['ws_product', [session('one-a', 'Fix login')]],
        ['ws_other', [session('two-a', 'Docs')]],
      ]),
      nestedSessionIds: new Set(),
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: 'repo a',
    });

    expect(sections.map((section) => section.workspace.id)).toEqual(['ws_product']);
    expect(sections[0].nodes.map((entry) => entry.session.id)).toEqual(['one-a']);
    expect(sections[0].metadataMatch).toBe(true);
  });

  test('a missing project cannot match a search, and the workspace stays out of it', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [{
        id: 'ws_product',
        name: 'Product',
        directory: '/data/workspaces/ws_product',
        projects: [{ projectId: 'gone', project: null }],
      }],
      sessionsByWorkspace: new Map([['ws_product', [session('one-a', 'Fix login')]]]),
      nestedSessionIds: new Set(),
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: 'gone',
    });

    expect(sections).toEqual([]);
  });

  test('a search keeps the branches leading to a nested match', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_one')],
      sessionsByWorkspace: new Map([['ws_one', [session('root', 'Root')]]]),
      nestedSessionIds: new Set(),
      buildNode: () => ({
        session: session('root', 'Root'),
        children: [node('child', 'Fix login')],
        worktree: null,
      }),
      query: 'login',
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].nodes.map((entry) => entry.session.id)).toEqual(['root']);
    expect(sections[0].nodes[0].children.map((entry) => entry.session.id)).toEqual(['child']);
  });

  test('a workspace keeps its row and sessions when its member projects are missing', () => {
    const directory = '/data/workspaces/ws_product';
    const ownership = createSessionOwnershipIndex(
      [session('workspace-session', 'Plan the release', directory)],
      [],
      new Map(),
      false,
      [],
      [],
      [],
      [{ id: 'ws_product', directory }],
    );
    const sections = buildWorkspaceSidebarSections({
      workspaces: [{ id: 'ws_product', name: 'Product', directory }],
      sessionsByWorkspace: ownership.sessionsByWorkspace,
      nestedSessionIds: new Set(),
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: '',
    });

    expect(sections.map((section) => section.workspace.id)).toEqual(['ws_product']);
    expect(sections[0].nodes.map((entry) => entry.session.id)).toEqual(['workspace-session']);
  });

  test('a nested workspace session opens under its root only', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_one')],
      sessionsByWorkspace: new Map([['ws_one', [session('root'), session('child')]]]),
      nestedSessionIds: new Set(['child']),
      buildNode: (entry) => ({
        session: entry,
        children: entry.id === 'root' ? [node('child')] : [],
        worktree: null,
      }),
      query: '',
    });

    expect(sections[0].nodes.map((entry) => entry.session.id)).toEqual(['root']);
    expect(sections[0].nodes[0].children.map((entry) => entry.session.id)).toEqual(['child']);
  });
});
