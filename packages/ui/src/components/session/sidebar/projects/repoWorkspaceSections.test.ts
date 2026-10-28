import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import {
  nextActiveWorkspaceId,
  projectRepoWorkspaceSidebar,
  type RepoWorkspaceGit,
  type RepoWorkspaceSidebarProject,
  type RepoWorkspaceSummary,
} from './repoWorkspaceSections';

const project = (id: string): RepoWorkspaceSidebarProject => ({
  id,
  path: `/work/${id}`,
  normalizedPath: `/work/${id}`,
  label: `Project ${id}`,
});

// SAFETY: the projection only reads identity fields from sessions.
const session = (id: string): Session => ({
  id,
  title: id,
  directory: `/work/${id}`,
  time: { created: 1, updated: 1 },
} as Session);

const workspace = (
  repos: Array<{ projectId: string; alias: string; branch?: string }>,
  primaryProjectId: string,
): RepoWorkspaceSummary => ({
  id: 'ws_shop',
  name: 'Shop Platform',
  primaryProjectId,
  repos: repos.map((repo) => ({
    projectId: repo.projectId,
    alias: repo.alias,
    description: repo.alias,
    branch: repo.branch ?? '',
  })),
});

const git = (changes: number | null, branch: string | null = 'main'): RepoWorkspaceGit => ({
  isRepo: branch !== null || changes !== null,
  branch,
  changes,
});

describe('projectRepoWorkspaceSidebar', () => {
  test('without an active workspace the current grouping passes through', () => {
    const sessions = new Map([
      ['a', [session('session-a')]],
      ['b', [session('session-b')]],
    ]);
    const result = projectRepoWorkspaceSidebar({
      workspaces: [workspace([{ projectId: 'a', alias: 'api' }], 'a')],
      projects: [project('a'), project('b')],
      sessions,
      activeWorkspaceId: null,
      gitByProject: new Map([['a', git(2)]]),
    });

    expect(result.activeWorkspace).toBeNull();
    expect(result.sections.map((section) => section.project.id)).toEqual(['a', 'b']);
    expect(result.sections.map((section) => section.sessions.map((entry) => entry.id))).toEqual([
      ['session-a'],
      ['session-b'],
    ]);
    expect(result.sections.every((section) => (
      section.repo === null
      && section.showSessions
      && section.showNewSession
      && !section.primary
      && section.branchChip === null
      && section.git === null
      && !section.missing
    ))).toBe(true);
  });

  test('an active workspace filters to its repos in repos order', () => {
    const result = projectRepoWorkspaceSidebar({
      workspaces: [workspace([
        { projectId: 'c', alias: 'shared' },
        { projectId: 'a', alias: 'api' },
      ], 'a')],
      projects: [project('a'), project('b'), project('c')],
      sessions: new Map([
        ['a', [session('session-a')]],
        ['b', [session('session-b')]],
        ['c', [session('session-c')]],
      ]),
      activeWorkspaceId: 'ws_shop',
      gitByProject: new Map([['a', git(2)]]),
    });

    expect(result.activeWorkspace?.name).toBe('Shop Platform');
    expect(result.sections.map((section) => section.project.id)).toEqual(['c', 'a']);
    expect(result.sections.map((section) => section.primary)).toEqual([false, true]);
    expect(result.sections.map((section) => section.showSessions)).toEqual([false, true]);
    expect(result.sections.map((section) => section.showNewSession)).toEqual([false, true]);
    expect(result.sections[0]?.sessions).toEqual([]);
    expect(result.sections[1]?.sessions.map((entry) => entry.id)).toEqual(['session-a']);
  });

  test('the branch chip shows the saved snapshot only when it differs from main', () => {
    const result = projectRepoWorkspaceSidebar({
      workspaces: [workspace([
        { projectId: 'main', alias: 'main', branch: 'main' },
        { projectId: 'feature', alias: 'feature', branch: 'feat/tokens' },
        { projectId: 'unknown', alias: 'unknown', branch: '' },
        { projectId: 'padded', alias: 'padded', branch: ' main ' },
      ], 'main')],
      projects: [project('main'), project('feature'), project('unknown'), project('padded')],
      sessions: new Map(),
      activeWorkspaceId: 'ws_shop',
      gitByProject: new Map(),
    });

    expect(result.sections.map((section) => section.branchChip)).toEqual([
      null,
      'feat/tokens',
      null,
      null,
    ]);
  });

  test('git state and change count come from the existing per-project status', () => {
    const result = projectRepoWorkspaceSidebar({
      workspaces: [workspace([
        { projectId: 'a', alias: 'api' },
        { projectId: 'b', alias: 'web' },
        { projectId: 'c', alias: 'missing-status' },
      ], 'a')],
      projects: [project('a'), project('b'), project('c')],
      sessions: new Map(),
      activeWorkspaceId: 'ws_shop',
      gitByProject: new Map([
        ['a', git(2, 'main')],
        ['b', git(0, 'feat/tokens')],
      ]),
    });

    expect(result.sections.map((section) => section.git)).toEqual([
      { isRepo: true, branch: 'main', changes: 2 },
      { isRepo: true, branch: 'feat/tokens', changes: 0 },
      null,
    ]);
  });

  test('a repo whose project is gone keeps its row and does not drop the others', () => {
    const result = projectRepoWorkspaceSidebar({
      workspaces: [workspace([
        { projectId: 'gone', alias: 'docs' },
        { projectId: 'a', alias: 'api' },
      ], 'a')],
      projects: [project('a')],
      sessions: new Map([['a', [session('session-a')]]]),
      activeWorkspaceId: 'ws_shop',
      gitByProject: new Map(),
    });

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toMatchObject({
      missing: true,
      primary: false,
      showSessions: false,
      showNewSession: false,
      git: null,
      sessions: [],
    });
    expect(result.sections[0]?.project).toMatchObject({
      id: 'gone',
      label: 'docs',
      normalizedPath: '',
    });
    expect(result.sections[1]?.project.id).toBe('a');
    expect(result.sections[1]?.primary).toBe(true);
    expect(result.sections[1]?.sessions.map((entry) => entry.id)).toEqual(['session-a']);
  });

  test('a workspace with one repo works, and the only repo is primary', () => {
    const result = projectRepoWorkspaceSidebar({
      workspaces: [workspace([{ projectId: 'a', alias: 'api' }], 'a')],
      projects: [project('a'), project('b')],
      sessions: new Map([['a', [session('session-a')]]]),
      activeWorkspaceId: 'ws_shop',
      gitByProject: new Map([['a', git(0)]]),
    });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.primary).toBe(true);
    expect(result.sections[0]?.showSessions).toBe(true);
    expect(result.sections[0]?.sessions).toHaveLength(1);
  });

  test('an unknown active id falls back to the grouping of every project', () => {
    const result = projectRepoWorkspaceSidebar({
      workspaces: [workspace([{ projectId: 'a', alias: 'api' }], 'a')],
      projects: [project('a'), project('b')],
      sessions: new Map(),
      activeWorkspaceId: 'ws_other',
      gitByProject: new Map(),
    });

    expect(result.activeWorkspace).toBeNull();
    expect(result.sections.map((section) => section.project.id)).toEqual(['a', 'b']);
  });
});

describe('nextActiveWorkspaceId', () => {
  test('selecting the active workspace leaves the filter', () => {
    expect(nextActiveWorkspaceId('ws_shop', 'ws_shop')).toBeNull();
    expect(nextActiveWorkspaceId('ws_shop', 'ws_other')).toBe('ws_shop');
    expect(nextActiveWorkspaceId(null, 'ws_shop')).toBeNull();
  });
});
