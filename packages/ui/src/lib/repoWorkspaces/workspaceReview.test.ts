import { describe, expect, test } from 'bun:test';
import type { RepoWorkspaceRef, RepoWorkspaceResolved } from './client';
import {
  projectWorkspaceReview,
  type WorkspaceReviewGitReadout,
} from './workspaceReview';

const workspace = (repos: Array<{ projectId: string; alias: string; branch?: string; missing?: boolean }>, primaryProjectId = repos[0]?.projectId ?? 'api'): RepoWorkspaceResolved => ({
  id: 'ws_shop',
  name: 'Shop Platform',
  primaryProjectId,
  createdRefs: repos.filter((repo) => repo.projectId !== primaryProjectId).map((repo) => repo.alias),
  repos: repos.map((repo) => ({
    projectId: repo.projectId,
    alias: repo.alias,
    description: repo.alias,
    branch: repo.branch ?? '',
    missing: repo.missing ?? false,
    project: repo.missing
      ? null
      : { id: repo.projectId, path: `/shop/${repo.alias}`, label: repo.alias.toUpperCase() },
  })),
});

const ready = (
  current: string,
  files: Array<{ path: string; index: string; working_dir: string }> = [],
  ahead = 0,
  behind = 0,
): WorkspaceReviewGitReadout => ({
  state: 'ready',
  status: { current, ahead, behind, files },
});

const changed = (path: string) => ({
  path,
  index: ' ',
  working_dir: 'M',
});

const ref = (alias: string, status: RepoWorkspaceRef['status']): RepoWorkspaceRef => ({
  alias,
  path: `/shop/${alias}`,
  description: alias,
  status,
  owned: true,
  current: null,
});

describe('projectWorkspaceReview', () => {
  test('sums the changes of every readable repo', () => {
    const review = projectWorkspaceReview({
      workspace: workspace([
        { projectId: 'api', alias: 'api', branch: 'main' },
        { projectId: 'web', alias: 'web', branch: 'main' },
        { projectId: 'shared', alias: 'shared', branch: 'main' },
      ]),
      refs: [],
      gitByProject: new Map([
        ['api', ready('main', [changed('src/a.ts'), changed('src/b.ts')])],
        ['web', ready('main', [changed('app/routes.ts')])],
        ['shared', ready('main')],
      ]),
    });

    expect(review.totalChanges).toBe(3);
    expect(review.changesPartial).toBe(false);
    expect(review.loading).toBe(false);
    expect(review.repos.map((repo) => repo.git.state === 'ready' ? repo.git.changes : null)).toEqual([2, 1, 0]);
    expect(review.repos[0].git).toEqual({
      state: 'ready',
      branch: 'main',
      ahead: 0,
      behind: 0,
      changes: 2,
      files: [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: 'M' },
      ],
    });
  });

  test('a repo without git is a state, not zero silent changes', () => {
    const review = projectWorkspaceReview({
      workspace: workspace([
        { projectId: 'api', alias: 'api' },
        { projectId: 'docs', alias: 'docs' },
      ]),
      refs: [],
      gitByProject: new Map([
        ['api', ready('main', [changed('src/a.ts')])],
        ['docs', { state: 'not-git' }],
      ]),
    });

    expect(review.totalChanges).toBe(1);
    expect(review.changesPartial).toBe(false);
    expect(review.repos[1].git).toEqual({ state: 'not-git' });
  });

  test('a repo whose project is gone stays in its card and out of the total', () => {
    const review = projectWorkspaceReview({
      workspace: workspace([
        { projectId: 'api', alias: 'api' },
        { projectId: 'web', alias: 'web', missing: true },
      ]),
      refs: [ref('web', 'missing')],
      gitByProject: new Map([['api', ready('main', [changed('src/a.ts')])]]),
    });

    expect(review.totalChanges).toBe(1);
    expect(review.changesPartial).toBe(true);
    expect(review.repos[1]).toMatchObject({
      label: 'web',
      path: null,
      git: { state: 'missing' },
      reference: { alias: 'web', status: 'missing' },
    });
  });

  test('an error in one repo stays in its card and does not hide the others', () => {
    const review = projectWorkspaceReview({
      workspace: workspace([
        { projectId: 'api', alias: 'api' },
        { projectId: 'web', alias: 'web' },
      ]),
      refs: [],
      gitByProject: new Map([
        ['api', ready('main', [changed('src/a.ts')])],
        ['web', { state: 'error' }],
      ]),
    });

    expect(review.repos[0].git.state).toBe('ready');
    expect(review.repos[1].git).toEqual({ state: 'error' });
    expect(review.totalChanges).toBe(1);
    expect(review.changesPartial).toBe(true);
    expect(review.loading).toBe(false);
  });

  test('a repo still being read is not counted and is not a partial total', () => {
    const review = projectWorkspaceReview({
      workspace: workspace([{ projectId: 'api', alias: 'api' }]),
      refs: [],
      gitByProject: new Map([['api', { state: 'loading' }]]),
    });

    expect(review.totalChanges).toBe(0);
    expect(review.changesPartial).toBe(false);
    expect(review.loading).toBe(true);
    expect(review.repos[0].git).toEqual({ state: 'loading' });
  });

  test('a diverged branch is read from git and never replaces the snapshot', () => {
    const review = projectWorkspaceReview({
      workspace: workspace([{ projectId: 'api', alias: 'api', branch: 'main' }]),
      refs: [],
      gitByProject: new Map([['api', ready('feat/tokens', [], 2, 1)]]),
    });

    expect(review.repos[0]).toMatchObject({
      branchSnapshot: 'main',
      currentBranch: 'feat/tokens',
      branchDiverged: true,
      git: { state: 'ready', ahead: 2, behind: 1 },
    });

    const sameBranch = projectWorkspaceReview({
      workspace: workspace([{ projectId: 'api', alias: 'api', branch: 'main' }]),
      refs: [],
      gitByProject: new Map([['api', ready('main')]]),
    });
    expect(sameBranch.repos[0].branchDiverged).toBe(false);

    const noSnapshot = projectWorkspaceReview({
      workspace: workspace([{ projectId: 'api', alias: 'api' }]),
      refs: [],
      gitByProject: new Map([['api', ready('dev')]]),
    });
    expect(noSnapshot.repos[0].currentBranch).toBe('dev');
    expect(noSnapshot.repos[0].branchDiverged).toBe(false);
  });

  test('reference states belong to the secondary repos by alias', () => {
    const review = projectWorkspaceReview({
      workspace: workspace([
        { projectId: 'api', alias: 'api' },
        { projectId: 'web', alias: 'web' },
        { projectId: 'shared', alias: 'shared' },
      ]),
      refs: [ref('web', 'outside'), ref('shared', 'overridden')],
      gitByProject: new Map(),
    });

    expect(review.repos.map((repo) => repo.reference?.status ?? null)).toEqual([null, 'outside', 'overridden']);
  });
});
