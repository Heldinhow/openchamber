import { describe, expect, test } from 'bun:test';

import type { RepoWorkspaceResolved } from './client';
import { groupDraftTargetResults } from './draftTargetGroups';

const project = (id: string, label: string, path: string) => ({ id, label, path });

const workspace = (id: string, name: string, projectIds: string[]): RepoWorkspaceResolved => ({
  id,
  name,
  directory: `/data/workspaces/${id}`,
  projects: projectIds.map((projectId) => ({
    projectId,
    missing: false,
    project: { id: projectId, path: `/repos/${projectId}`, label: projectId },
  })),
  configError: null,
});

const projects = [
  project('p-chat', 'Chat', ''),
  project('p-api', 'API', '/repos/api'),
  project('p-web', 'Web client', '/repos/web'),
];
const workspaces = [
  workspace('ws-product', 'Product', ['p-api', 'p-web']),
  workspace('ws-infra', 'Infrastructure', ['p-api']),
  workspace('ws-design', 'Design', ['p-web']),
];

const group = (query: string) => groupDraftTargetResults(
  workspaces,
  projects,
  query,
  (entry) => [entry.label, entry.path],
  (entry) => entry.projects.map((member) => member.projectId),
);

describe('the new-session picker groups', () => {
  test('lists every workspace and project in their incoming order without a query', () => {
    const result = group('');

    expect(result.workspaces.map((entry) => entry.id)).toEqual(['ws-product', 'ws-infra', 'ws-design']);
    expect(result.projects.map((entry) => entry.id)).toEqual(['p-chat', 'p-api', 'p-web']);
  });

  test('matches a workspace by name', () => {
    const result = group('infra');

    expect(result.workspaces.map((entry) => entry.id)).toEqual(['ws-infra']);
    expect(result.projects).toEqual([]);
  });

  test('a project match surfaces every workspace containing that project', () => {
    const result = group('API');

    expect(result.projects.map((entry) => entry.id)).toEqual(['p-api']);
    expect(result.workspaces.map((entry) => entry.id)).toEqual(['ws-product', 'ws-infra']);
  });

  test('keeps a workspace that matches both by name and by a contained project once', () => {
    const result = group('web');

    expect(result.projects.map((entry) => entry.id)).toEqual(['p-web']);
    expect(result.workspaces.map((entry) => entry.id)).toEqual(['ws-product', 'ws-design']);
  });

  test('returns both groups empty when nothing matches', () => {
    const result = group('nothing-here');

    expect(result).toEqual({ workspaces: [], projects: [] });
  });
});
