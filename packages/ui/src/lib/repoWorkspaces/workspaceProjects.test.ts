import { describe, expect, test } from 'bun:test';

import type { GitStatus } from '@/lib/api/types';
import type { RepoWorkspaceResolved } from './client';
import { findRepoWorkspaceIn } from './catalog';
import {
  projectWorkspaceGitReadout,
  projectWorkspaceRows,
  type WorkspaceProjectDirectoryState,
} from './workspaceProjects';

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  ...overrides,
});

const workspace = (projects: RepoWorkspaceResolved['projects']): RepoWorkspaceResolved => ({
  id: 'ws_product',
  name: 'Product',
  directory: '/data/workspaces/ws_product',
  projects,
  configError: null,
});

const resolved = (id: string, path: string, label = ''): RepoWorkspaceResolved['projects'][number] => ({
  projectId: id,
  missing: false,
  project: { id, path, label },
});

const missing = (id: string): RepoWorkspaceResolved['projects'][number] => ({
  projectId: id,
  missing: true,
  project: null,
});

const directory = (value: boolean | null, gitStatus: GitStatus | null = null): WorkspaceProjectDirectoryState => ({
  isGitRepo: value,
  status: gitStatus,
});

describe('workspace project rows', () => {
  test('keeps workspace order and gives a missing project its own row', () => {
    const rows = projectWorkspaceRows(workspace([
      resolved('p_api', '/projects/api'),
      missing('p_gone'),
      resolved('p_web', '/projects/web', 'Web app'),
    ]));

    expect(rows).toEqual([
      { projectId: 'p_api', path: '/projects/api', label: 'api', missing: false },
      { projectId: 'p_gone', path: null, label: null, missing: true },
      { projectId: 'p_web', path: '/projects/web', label: 'Web app', missing: false },
    ]);
  });

  test('a normal project session has no workspace rows', () => {
    expect(projectWorkspaceRows(null)).toEqual([]);
    expect(findRepoWorkspaceIn([], '/projects/api')).toBeNull();
  });

  test('finds the workspace by its neutral directory only', () => {
    const product = workspace([]);

    expect(findRepoWorkspaceIn([product], '/data/workspaces/ws_product/')).toBe(product);
    expect(findRepoWorkspaceIn([product], '/projects/api')).toBeNull();
  });
});

describe('workspace project git readout', () => {
  test('a probe that has not answered is unknown, never a clean tree', () => {
    expect(projectWorkspaceGitReadout(undefined, false)).toEqual({ state: 'unknown' });
    expect(projectWorkspaceGitReadout(directory(null), false)).toEqual({ state: 'unknown' });
    expect(projectWorkspaceGitReadout(directory(true), false)).toEqual({ state: 'unknown' });
  });

  test('a failed read is distinct from unknown and from no git', () => {
    expect(projectWorkspaceGitReadout(undefined, true)).toEqual({ state: 'failed' });
    expect(projectWorkspaceGitReadout(directory(true), true)).toEqual({ state: 'failed' });
    expect(projectWorkspaceGitReadout(directory(false), true)).toEqual({ state: 'no-git' });
  });

  test('a clean tree reports zero changes only after a status arrived', () => {
    expect(projectWorkspaceGitReadout(directory(true, status()), false)).toEqual({
      state: 'ready',
      branch: 'main',
      changes: 0,
      additions: null,
      deletions: null,
    });
  });

  test('changes carry the file count and the additions/deletions when present', () => {
    const readout = projectWorkspaceGitReadout(directory(true, status({
      files: [
        { path: 'a.ts', index: 'M', working_dir: ' ' },
        { path: 'b.ts', index: '?', working_dir: '?' },
      ],
      diffStats: {
        staged: { 'a.ts': { insertions: 4, deletions: 1 } },
        working: { 'a.ts': { insertions: 2, deletions: 3 }, 'b.ts': { insertions: 6, deletions: 0 } },
      },
    })), false);

    expect(readout).toEqual({
      state: 'ready',
      branch: 'main',
      changes: 2,
      additions: 12,
      deletions: 4,
    });
  });

  test('a status without diff stats reports no numbers instead of zeroes', () => {
    const readout = projectWorkspaceGitReadout(directory(true, status({
      files: [{ path: 'a.ts', index: 'M', working_dir: ' ' }],
    })), false);

    expect(readout).toEqual({
      state: 'ready',
      branch: 'main',
      changes: 1,
      additions: null,
      deletions: null,
    });
  });

  test('a failed refresh keeps the status that already arrived', () => {
    const readout = projectWorkspaceGitReadout(directory(true, status({ current: 'feature/web' })), true);

    expect(readout.state).toBe('ready');
    if (readout.state === 'ready') expect(readout.branch).toBe('feature/web');
  });
});
