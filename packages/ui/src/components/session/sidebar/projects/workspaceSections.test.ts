import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from '../types';
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

const workspace = (id: string) => ({ id, name: id.toUpperCase(), directory: `/data/workspaces/${id}` });

describe('buildWorkspaceSidebarSections', () => {
  test('keeps the workspace order and lists only its own sessions', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_one'), workspace('ws_two'), workspace('ws_empty')],
      sessionsByWorkspace: new Map([
        ['ws_one', [session('one-a')]],
        ['ws_two', [session('two-a'), session('two-b')]],
      ]),
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
      buildNode: (entry) => ({ session: entry, children: [], worktree: null }),
      query: 'login',
    });

    expect(sections.map((section) => section.workspace.id)).toEqual(['ws_one']);
    expect(sections[0].nodes.map((entry) => entry.session.id)).toEqual(['one-a']);
  });

  test('a search keeps the branches leading to a nested match', () => {
    const sections = buildWorkspaceSidebarSections({
      workspaces: [workspace('ws_one')],
      sessionsByWorkspace: new Map([['ws_one', [session('root', 'Root')]]]),
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
});
