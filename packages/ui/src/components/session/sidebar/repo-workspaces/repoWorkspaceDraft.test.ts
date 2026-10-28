import { describe, expect, test } from 'bun:test';
import {
  aliasForFolder,
  createPayloadFromDraft,
  suggestedAlias,
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
});
