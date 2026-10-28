import { describe, expect, test } from 'bun:test';
import { parseActiveWorkspaceId, parseProjects, parseRepoWorkspaces } from './parsers';

describe('parseProjects', () => {
  test('keeps per-project agent, model and thinking defaults across a settings round trip', () => {
    const projects = [
      { path: '/repo/app', label: 'App', defaultAgent: ' reviewer ', defaultModel: 'openai/gpt-5.6', defaultVariant: 'low' },
      { path: '/repo/lib', defaultAgent: ' ', defaultModel: '  ', defaultVariant: 42 },
      { path: '/repo/legacy' },
    ];
    const parsed = parseProjects(projects, { projects });

    expect(parsed?.map((project) => [project.path, project.defaultAgent, project.defaultModel, project.defaultVariant])).toEqual([
      ['/repo/app', 'reviewer', 'openai/gpt-5.6', 'low'],
      ['/repo/lib', undefined, undefined, undefined],
      ['/repo/legacy', undefined, undefined, undefined],
    ]);
    expect(parseProjects(parsed, { projects: parsed })).toEqual(parsed);
  });
});

describe('parseRepoWorkspaces', () => {
  const validWorkspace = {
    id: 'ws_shop',
    name: 'Shop Platform',
    primaryProjectId: 'proj_api',
    repos: [
      { projectId: 'proj_api', alias: 'api', description: 'API de checkout', branch: 'main' },
      { projectId: 'proj_web', alias: 'web', description: 'Frontend', branch: 'feat/tokens' },
    ],
    createdRefs: ['web'],
  };

  test('keeps valid entries and counts each rejected one', () => {
    const result = parseRepoWorkspaces([
      validWorkspace,
      { name: 'No id', primaryProjectId: 'p', repos: [{ projectId: 'p', alias: 'p' }] },
      { id: 'ws_no_name', primaryProjectId: 'p', repos: [{ projectId: 'p', alias: 'p' }] },
      { id: 'ws_no_repos', name: 'No repos', primaryProjectId: 'p', repos: [] },
      { id: 'ws_primary_outside', name: 'Primary outside', primaryProjectId: 'p', repos: [{ projectId: 'q', alias: 'q' }] },
      {
        id: 'ws_duplicate_alias',
        name: 'Duplicate alias',
        primaryProjectId: 'p',
        repos: [{ projectId: 'p', alias: 'same' }, { projectId: 'q', alias: 'same' }],
      },
      { id: 'ws_at_alias', name: 'At alias', primaryProjectId: 'p', repos: [{ projectId: 'p', alias: '@api' }] },
      { id: 'ws_space_alias', name: 'Space alias', primaryProjectId: 'p', repos: [{ projectId: 'p', alias: 'a pi' }] },
      validWorkspace,
    ], {});

    expect(result?.discarded).toBe(8);
    expect(result?.workspaces).toEqual([validWorkspace]);
  });

  test('keeps createdRefs only for existing secondary aliases', () => {
    const result = parseRepoWorkspaces([{
      ...validWorkspace,
      createdRefs: ['web', 'api', 'gone', 42, 'web'],
    }], {});

    expect(result?.workspaces[0]?.createdRefs).toEqual(['web']);
    expect(parseRepoWorkspaces([{ ...validWorkspace, createdRefs: undefined }], {})?.workspaces[0]?.createdRefs).toEqual([]);
  });

  test('does not invalidate a workspace for an unknown project id', () => {
    const result = parseRepoWorkspaces([{
      id: 'ws_missing_project',
      name: 'Missing project',
      primaryProjectId: 'proj_gone',
      repos: [{ projectId: 'proj_gone', alias: 'gone' }],
    }], {});

    expect(result?.discarded).toBe(0);
    expect(result?.workspaces[0]?.primaryProjectId).toBe('proj_gone');
  });

  test('rejects a non-array field instead of reading it as no workspaces', () => {
    expect(parseRepoWorkspaces('nope', {})).toBeUndefined();
    expect(parseRepoWorkspaces([], {})).toEqual({ workspaces: [], discarded: 0 });
  });
});

describe('parseActiveWorkspaceId', () => {
  test('keeps an id, clears with null, and rejects everything else', () => {
    expect(parseActiveWorkspaceId(' ws_shop ', {})).toBe('ws_shop');
    expect(parseActiveWorkspaceId(null, {})).toBeNull();
    expect(parseActiveWorkspaceId('', {})).toBeUndefined();
    expect(parseActiveWorkspaceId(42, {})).toBeUndefined();
  });
});
