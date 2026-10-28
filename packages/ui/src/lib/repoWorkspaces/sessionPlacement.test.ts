import { describe, expect, test } from 'bun:test';
import { repoWorkspaceSessionPlacement, type RepoWorkspaceSessionWorkspace } from './sessionPlacement';

const workspace = (overrides: Partial<RepoWorkspaceSessionWorkspace> = {}): RepoWorkspaceSessionWorkspace => ({
  primaryProjectId: 'p_api',
  repos: [
    { projectId: 'p_api', project: { path: '/shop/api' } },
    { projectId: 'p_web', project: { path: '/shop/web' } },
    { projectId: 'p_shared', project: { path: '/shop/shared' } },
  ],
  ...overrides,
});

describe('repoWorkspaceSessionPlacement', () => {
  test('a session in the primary repo is primary', () => {
    expect(repoWorkspaceSessionPlacement(workspace(), '/shop/api')).toBe('primary');
    expect(repoWorkspaceSessionPlacement(workspace(), '/shop/api/')).toBe('primary');
    expect(repoWorkspaceSessionPlacement(workspace(), '/shop/api/packages/ui')).toBe('primary');
  });

  test('a session in another repo of the workspace is secondary', () => {
    expect(repoWorkspaceSessionPlacement(workspace(), '/shop/web')).toBe('secondary');
    expect(repoWorkspaceSessionPlacement(workspace(), '/shop/web/src')).toBe('secondary');
  });

  test('a repo nested under the primary stays secondary', () => {
    const nested = workspace({
      repos: [
        { projectId: 'p_api', project: { path: '/shop' } },
        { projectId: 'p_web', project: { path: '/shop/web' } },
      ],
    });
    expect(repoWorkspaceSessionPlacement(nested, '/shop/web')).toBe('secondary');
    expect(repoWorkspaceSessionPlacement(nested, '/shop/web/src')).toBe('secondary');
    expect(repoWorkspaceSessionPlacement(nested, '/shop/api')).toBe('primary');
  });

  test('a project nested under a workspace repo but not in the workspace stays outside', () => {
    const nested = workspace({
      repos: [
        { projectId: 'p_api', project: { path: '/shop' } },
        { projectId: 'p_web', project: { path: '/shop/web' } },
      ],
    });
    const projects = [
      { id: 'p_api', path: '/shop' },
      { id: 'p_web', path: '/shop/web' },
      { id: 'p_docs', path: '/shop/docs' },
    ];
    expect(repoWorkspaceSessionPlacement(nested, '/shop/docs', projects)).toBe('outside');
    expect(repoWorkspaceSessionPlacement(nested, '/shop/api', projects)).toBe('primary');
  });

  test('a session outside every repo, or with no workspace, is outside', () => {
    expect(repoWorkspaceSessionPlacement(workspace(), '/other/project')).toBe('outside');
    expect(repoWorkspaceSessionPlacement(workspace(), '/shop/web-other')).toBe('outside');
    expect(repoWorkspaceSessionPlacement(null, '/shop/api')).toBe('outside');
    expect(repoWorkspaceSessionPlacement(workspace(), null)).toBe('outside');
  });

  test('a missing project never matches and does not break the others', () => {
    const missing = workspace({
      repos: [
        { projectId: 'p_api', project: { path: '/shop/api' } },
        { projectId: 'p_gone', project: null },
      ],
    });
    expect(repoWorkspaceSessionPlacement(missing, '/shop/api')).toBe('primary');
    expect(repoWorkspaceSessionPlacement(missing, '/shop/gone')).toBe('outside');
  });
});
