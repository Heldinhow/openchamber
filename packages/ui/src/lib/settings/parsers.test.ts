import { describe, expect, test } from 'bun:test';
import { parseProjects, parseRepoWorkspaces } from './parsers';

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
  test('keeps valid entries in stored order and counts each rejected one', () => {
    const result = parseRepoWorkspaces([
      { id: 'ws_shop', name: 'Shop', projectIds: ['p_web', 'p_api'] },
      { id: 'ws_123e4567-e89b-12d3-a456-426614174000', name: 'Legacy id', projectIds: ['p'] },
      { name: 'No id', projectIds: ['p'] },
      { id: '../escape', name: 'Escape', projectIds: ['p'] },
      { id: 'ws_noname', projectIds: ['p'] },
      { id: 'ws_noprojects', name: 'No projects', projectIds: [] },
      { id: 'ws_dupproject', name: 'Duplicate project', projectIds: ['p', 'p'] },
      { id: 'ws_badproject', name: 'Bad project', projectIds: [42] },
    ], {});

    expect(result?.discarded).toBe(5);
    expect(result?.workspaces).toEqual([
      { id: 'ws_shop', name: 'Shop', projectIds: ['p_web', 'p_api'] },
      { id: 'ws_123e4567-e89b-12d3-a456-426614174000', name: 'Legacy id', projectIds: ['p'] },
      { id: 'ws_dupproject', name: 'Duplicate project', projectIds: ['p'] },
    ]);
  });

  test('reads a legacy primary-based entry in repo order and drops its bookkeeping', () => {
    const result = parseRepoWorkspaces([{
      id: 'ws_legacy',
      name: 'Legacy',
      primaryProjectId: 'p_api',
      repos: [
        { projectId: 'p_web', alias: 'web', description: 'Web', branch: 'main' },
        { projectId: 'p_api', alias: 'api', description: 'API', branch: 'main' },
      ],
      createdRefs: ['api'],
      editRules: [{ alias: 'api', resource: '/repos/api/*', effect: 'allow' }],
    }], {});

    expect(result?.discarded).toBe(0);
    expect(result?.workspaces[0]).toEqual({
      id: 'ws_legacy',
      name: 'Legacy',
      projectIds: ['p_web', 'p_api'],
    });
  });

  test('does not invalidate a workspace for an unknown project id', () => {
    const result = parseRepoWorkspaces([{
      id: 'ws_missingproject',
      name: 'Missing project',
      projectIds: ['proj_gone'],
    }], {});

    expect(result?.discarded).toBe(0);
    expect(result?.workspaces[0]?.projectIds).toEqual(['proj_gone']);
  });

  test('rejects a non-array field instead of reading it as no workspaces', () => {
    expect(parseRepoWorkspaces('nope', {})).toBeUndefined();
    expect(parseRepoWorkspaces([], {})).toEqual({ workspaces: [], discarded: 0 });
  });
});
