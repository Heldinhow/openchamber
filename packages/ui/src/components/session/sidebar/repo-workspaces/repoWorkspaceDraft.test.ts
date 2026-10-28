import { describe, expect, test } from 'bun:test';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import {
  aliasForFolder,
  createPayloadFromDraft,
  diffRepoWorkspaceRefs,
  draftFromWorkspace,
  suggestedAlias,
  updatePayloadFromDraft,
  validateRepoWorkspaceDraft,
  type RepoWorkspaceDraft,
} from './repoWorkspaceDraft';

const row = (key: string, path: string, alias: string) => ({ key, path, alias });

const draft = (overrides: Partial<RepoWorkspaceDraft> = {}): RepoWorkspaceDraft => ({
  name: 'Shop Platform',
  rows: [row('a', '/repos/api', 'api'), row('b', '/repos/web', 'web')],
  primaryKey: 'a',
  ...overrides,
});

describe('workspace create draft', () => {
  test('a named workspace with a primary and unique aliases can submit', () => {
    expect(validateRepoWorkspaceDraft(draft()).canSubmit).toBe(true);
  });

  test('a single repository is allowed', () => {
    expect(validateRepoWorkspaceDraft(draft({ rows: [row('a', '/repos/api', 'api')] })).canSubmit).toBe(true);
  });

  test('no name or no repository blocks the save', () => {
    expect(validateRepoWorkspaceDraft(draft({ name: '  ' })).nameError).toBe(true);
    const empty = validateRepoWorkspaceDraft(draft({ rows: [], primaryKey: null }));
    expect(empty.primaryError).toBe(true);
    expect(empty.canSubmit).toBe(false);
  });

  test('a principal outside the rows blocks the save', () => {
    const result = validateRepoWorkspaceDraft(draft({ primaryKey: 'gone' }));
    expect(result.primaryError).toBe(true);
    expect(result.canSubmit).toBe(false);
  });

  test('an alias with a space, slash or leading @ is invalid', () => {
    for (const alias of ['web app', 'web/app', '@web', '']) {
      const result = validateRepoWorkspaceDraft(draft({ rows: [row('a', '/repos/api', alias)] }));
      expect(result.rows.a?.alias === 'invalid' || result.rows.a?.alias === 'required').toBe(true);
      expect(result.canSubmit).toBe(false);
    }
  });

  test('duplicate aliases and folders block the save', () => {
    const aliases = validateRepoWorkspaceDraft(draft({
      rows: [row('a', '/repos/api', 'app'), row('b', '/repos/web', 'app')],
    }));
    expect(aliases.rows.a?.alias).toBe('duplicate');
    expect(aliases.rows.b?.alias).toBe('duplicate');
    expect(aliases.canSubmit).toBe(false);

    const paths = validateRepoWorkspaceDraft(draft({
      rows: [row('a', '/repos/api', 'api'), row('b', '/repos/api/', 'web')],
    }));
    expect(paths.rows.b?.path).toBe('duplicate');
    expect(paths.canSubmit).toBe(false);
  });

  test('folder aliases are sanitized and deduped', () => {
    expect(aliasForFolder('/repos/my app', [])).toBe('my-app');
    expect(aliasForFolder('/repos/web', ['web', 'web-2'])).toBe('web-3');
    expect(aliasForFolder('/', [])).toBe('repo');
    expect(suggestedAlias('web', ['web', 'web-2'])).toBe('web-3');
  });

  test('the payload carries the picked path, branch and single primary', () => {
    const payload = createPayloadFromDraft(draft({ name: '  Shop  ' }), (path) => (path.endsWith('web') ? 'feat/tokens' : 'main'));
    expect(payload).toEqual({
      name: 'Shop',
      repos: [
        { alias: 'api', path: '/repos/api', branch: 'main', primary: true },
        { alias: 'web', path: '/repos/web', branch: 'feat/tokens', primary: false },
      ],
    });
  });

  test('the edit draft loads the saved repos, primary and branch snapshots', () => {
    const loaded = draftFromWorkspace(resolvedWorkspace);
    expect(loaded).toEqual({
      name: 'Shop Platform',
      primaryKey: 'repo-0',
      rows: [
        { key: 'repo-0', path: '/repos/api', alias: 'api', projectId: 'p_api', missing: false, branch: 'main' },
        { key: 'repo-1', path: '/repos/web', alias: 'web', projectId: 'p_web', missing: false, branch: 'feat/tokens' },
      ],
    });
  });

  test('the edit payload keeps project ids and the saved branch when git has no answer', () => {
    const payload = updatePayloadFromDraft(draftFromWorkspace(resolvedWorkspace), () => '', {
      confirmRefs: ['web'],
      keepRefs: ['api'],
    });
    expect(payload).toEqual({
      name: 'Shop Platform',
      repos: [
        { alias: 'api', projectId: 'p_api', branch: 'main', primary: true },
        { alias: 'web', projectId: 'p_web', branch: 'feat/tokens', primary: false },
      ],
      confirmRefs: ['web'],
      keepRefs: ['api'],
    });
  });

  test('the diff names removed, added and changed reference aliases', () => {
    const loaded = draftFromWorkspace(resolvedWorkspace);
    const removed = diffRepoWorkspaceRefs({
      workspace: resolvedWorkspace,
      draft: { ...loaded, rows: [loaded.rows[0]] },
      labels: new Map(),
    });
    expect(removed).toEqual({ removed: ['web'], added: [], changed: [] });

    const added = diffRepoWorkspaceRefs({
      workspace: resolvedWorkspace,
      draft: {
        ...loaded,
        rows: [...loaded.rows, { key: 'repo-2', path: '/repos/docs', alias: 'docs' }],
      },
      labels: new Map(),
    });
    expect(added).toEqual({ removed: [], added: ['docs'], changed: [] });

    const changed = diffRepoWorkspaceRefs({
      workspace: resolvedWorkspace,
      draft: loaded,
      labels: new Map([['/repos/web', 'Web app']]),
    });
    expect(changed).toEqual({ removed: [], added: [], changed: ['web'] });
  });
});

const resolvedWorkspace: RepoWorkspaceResolved = {
  id: 'ws_1',
  name: 'Shop Platform',
  primaryProjectId: 'p_api',
  createdRefs: ['web'],
  repos: [
    {
      projectId: 'p_api',
      alias: 'api',
      description: 'API',
      branch: 'main',
      missing: false,
      project: { id: 'p_api', path: '/repos/api', label: 'API' },
    },
    {
      projectId: 'p_web',
      alias: 'web',
      description: 'Web',
      branch: 'feat/tokens',
      missing: false,
      project: { id: 'p_web', path: '/repos/web', label: 'Web' },
    },
  ],
};
