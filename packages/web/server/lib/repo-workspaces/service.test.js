import { describe, expect, it, vi } from 'vitest';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createWorkspaceService } from './service.js';

const projects = [
  { id: 'api', path: '/repos/api', label: 'API' },
  { id: 'web', path: '/repos/web', label: '' },
];

const workspace = (overrides = {}) => ({
  id: 'ws_1',
  name: 'Shop Platform',
  primaryProjectId: 'api',
  repos: [
    { projectId: 'api', alias: 'api', description: 'API', branch: '' },
    { projectId: 'web', alias: 'web', description: '', branch: '' },
  ],
  createdRefs: [],
  ...overrides,
});

const createService = (overrides = {}) => {
  const dependencies = {
    readSettings: vi.fn(async () => ({ projects, workspaces: [], activeWorkspaceId: null })),
    persistSettings: vi.fn(async (changes) => changes),
    sanitizeProjects: (value) => (Array.isArray(value) ? value : undefined),
    sanitizeRepoWorkspaces: (value) => (Array.isArray(value) ? { workspaces: value, discarded: 0 } : undefined),
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    fsPromises: { mkdir: vi.fn(async () => undefined) },
    crypto: { randomUUID: () => 'fixed-uuid' },
    ...overrides,
  };
  return { service: createWorkspaceService(dependencies), dependencies };
};

const validPayload = {
  name: 'Shop Platform',
  repos: [
    { projectId: 'api', alias: 'api', primary: true },
    { projectId: 'web', alias: 'web', branch: 'feat/tokens' },
  ],
};

describe('workspace service: list', () => {
  it('resolves every project and marks a repo whose project is gone', async () => {
    const stored = workspace({
      repos: [
        { projectId: 'api', alias: 'api', description: 'API', branch: '' },
        { projectId: 'gone', alias: 'gone', description: '', branch: '' },
      ],
    });
    const { service } = createService({
      readSettings: vi.fn(async () => ({
        projects: [projects[0]],
        workspaces: [stored],
        activeWorkspaceId: 'ws_1',
      })),
    });

    const result = await service.list();

    expect(result.activeWorkspaceId).toBe('ws_1');
    expect(result.refs).toEqual([]);
    expect(result.discarded).toBe(0);
    expect(result.workspaces[0].repos).toEqual([
      {
        projectId: 'api',
        alias: 'api',
        description: 'API',
        branch: '',
        missing: false,
        project: { id: 'api', path: '/repos/api', label: 'API' },
      },
      {
        projectId: 'gone',
        alias: 'gone',
        description: '',
        branch: '',
        missing: true,
        project: null,
      },
    ]);
  });

  it('reports how many stored workspaces the parser discarded', async () => {
    const { service } = createService({
      readSettings: vi.fn(async () => ({ projects, workspaces: [{ bad: true }], activeWorkspaceId: null })),
      sanitizeRepoWorkspaces: vi.fn(() => ({ workspaces: [], discarded: 2 })),
    });

    await expect(service.list()).resolves.toMatchObject({ workspaces: [], discarded: 2, refs: [] });
  });

  it('fails instead of answering an empty list when settings cannot be read', async () => {
    const { service } = createService({
      readSettings: vi.fn(async () => { throw new Error('Settings file is malformed'); }),
    });

    await expect(service.list()).rejects.toThrow('Settings file is malformed');
  });
});

describe('workspace service: create', () => {
  it('stores the workspace and its pointer in one write and activates the primary', async () => {
    const { service, dependencies } = createService();

    const result = await service.create(validPayload);

    expect(result).toEqual({
      workspace: {
        id: 'ws_fixed-uuid',
        name: 'Shop Platform',
        primaryProjectId: 'api',
        repos: [
          { projectId: 'api', alias: 'api', description: 'API', branch: '' },
          { projectId: 'web', alias: 'web', description: '', branch: 'feat/tokens' },
        ],
        createdRefs: [],
      },
      refs: [],
    });
    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
    expect(dependencies.persistSettings).toHaveBeenCalledWith({
      workspaces: [result.workspace],
      activeWorkspaceId: 'ws_fixed-uuid',
      activeProjectId: 'api',
    });
  });

  it('keeps existing workspaces when it appends a new one', async () => {
    const existing = workspace({ id: 'ws_previous' });
    const { service, dependencies } = createService({
      readSettings: vi.fn(async () => ({ projects, workspaces: [existing], activeWorkspaceId: null })),
    });

    await service.create(validPayload);

    expect(dependencies.persistSettings.mock.calls[0][0].workspaces.map((entry) => entry.id))
      .toEqual(['ws_previous', 'ws_fixed-uuid']);
  });

  it('registers a folder that is not a project yet through the add-project path', async () => {
    const { service, dependencies } = createService();

    const result = await service.create({
      name: 'Shop Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { path: '/repos/shared', alias: 'shared' },
      ],
    });

    const sharedId = createProjectIdFromPath('/repos/shared');
    expect(dependencies.validateDirectoryPath).toHaveBeenCalledWith('/repos/shared');
    expect(result.workspace.repos[1]).toMatchObject({ projectId: sharedId, alias: 'shared' });
    expect(dependencies.persistSettings.mock.calls[0][0].projects.map((project) => project.path))
      .toEqual(['/repos/api', '/repos/web', '/repos/shared']);
  });

  it('registers nothing when the folder cannot be added', async () => {
    const { service, dependencies } = createService({
      validateDirectoryPath: vi.fn(async (directory) => (
        directory === '/repos/missing' ? { ok: false, error: 'Directory not found' } : { ok: true, directory }
      )),
    });

    await expect(service.create({
      name: 'Shop Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { path: '/repos/missing', alias: 'missing' },
      ],
    })).rejects.toMatchObject({
      status: 422,
      fields: { 'repos[1].path': 'Directory not found' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing name', { repos: [{ projectId: 'api', alias: 'api', primary: true }] }, { name: 'Name is required' }],
    ['no repositories', { name: 'Shop' }, { repos: 'At least one repository is required' }],
    ['a missing primary', { name: 'Shop', repos: [{ projectId: 'api', alias: 'api' }] }, { primary: 'Select the primary repository' }],
    ['two primaries', { name: 'Shop', repos: [{ projectId: 'api', alias: 'api', primary: true }, { projectId: 'web', alias: 'web', primary: true }] }, { primary: 'Exactly one repository must be primary' }],
    ['a duplicate alias', { name: 'Shop', repos: [{ projectId: 'api', alias: 'same', primary: true }, { projectId: 'web', alias: 'same' }] }, { 'repos[1].alias': 'Alias must be unique within the workspace' }],
    ['an invalid alias', { name: 'Shop', repos: [{ projectId: 'api', alias: '@api', primary: true }] }, { 'repos[0].alias': 'Alias must not contain spaces, "/", "`" or ",", or start with "@"' }],
    ['an unknown project', { name: 'Shop', repos: [{ projectId: 'gone', alias: 'gone', primary: true }] }, { 'repos[0].projectId': 'Project not found' }],
  ])('rejects %s with a field error', async (_label, payload, fields) => {
    const { service, dependencies } = createService();

    await expect(service.create(payload)).rejects.toMatchObject({ status: 422, fields });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('fails the whole create when settings cannot be written', async () => {
    const { service } = createService({
      persistSettings: vi.fn(async () => { throw new Error('Settings write failed'); }),
    });

    await expect(service.create(validPayload)).rejects.toThrow('Settings write failed');
  });
});

describe('workspace service: activate', () => {
  it('writes the pointer and the primary as the active project', async () => {
    const stored = workspace();
    const { service, dependencies } = createService({
      readSettings: vi.fn(async () => ({ projects, workspaces: [stored], activeWorkspaceId: null })),
    });

    await expect(service.activate({ id: 'ws_1' })).resolves.toEqual({ activeWorkspaceId: 'ws_1' });
    expect(dependencies.persistSettings).toHaveBeenCalledWith({
      activeWorkspaceId: 'ws_1',
      activeProjectId: 'api',
    });
  });

  it('clears the pointer without touching anything else', async () => {
    const { service, dependencies } = createService();

    await expect(service.activate({ id: null })).resolves.toEqual({ activeWorkspaceId: null });
    expect(dependencies.persistSettings).toHaveBeenCalledWith({ activeWorkspaceId: null });
    expect(dependencies.readSettings).toHaveBeenCalledOnce();
  });

  it('refuses an unknown workspace without writing', async () => {
    const { service, dependencies } = createService();

    await expect(service.activate({ id: 'ws_missing' })).rejects.toMatchObject({ status: 404 });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('refuses a workspace whose primary project is gone without writing', async () => {
    const stored = workspace({
      primaryProjectId: 'gone',
      repos: [{ projectId: 'gone', alias: 'gone', description: '', branch: '' }],
    });
    const { service, dependencies } = createService({
      readSettings: vi.fn(async () => ({ projects, workspaces: [stored], activeWorkspaceId: null })),
    });

    await expect(service.activate({ id: 'ws_1' })).rejects.toMatchObject({
      status: 422,
      fields: { id: 'The workspace primary project is not available' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('refuses a missing id without writing', async () => {
    const { service, dependencies } = createService();

    await expect(service.activate({})).rejects.toMatchObject({
      status: 422,
      fields: { id: 'Workspace id is required' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });
});
