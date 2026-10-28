import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerWorkspaceRoutes } from './routes.js';

const emptyLayers = () => ({
  userConfig: {},
  userOverrideConfig: {},
  projectConfig: {},
  customConfig: {},
  mergedConfig: {},
  paths: { userPath: null, userOverridePath: null, projectPath: null, customPath: null },
  layerErrors: [],
});

const createApp = (overrides = {}) => {
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  const state = { projectConfig: {} };
  const dependencies = {
    readSettings: vi.fn(async () => ({
      projects: [{ id: 'api', path: '/repos/api', label: 'API' }],
      workspaces: [],
      activeWorkspaceId: null,
    })),
    persistSettings: vi.fn(async (changes) => changes),
    sanitizeProjects: (value) => (Array.isArray(value) ? value : undefined),
    sanitizeRepoWorkspaces: (value) => (Array.isArray(value) ? { workspaces: value, discarded: 0 } : undefined),
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    fsPromises: { mkdir: vi.fn(async () => undefined) },
    crypto: { randomUUID: () => 'fixed-uuid' },
    readConfigLayers: vi.fn(() => ({
      ...emptyLayers(),
      projectConfig: state.projectConfig,
      mergedConfig: state.projectConfig,
    })),
    readConfigFile: vi.fn(() => state.projectConfig),
    writeConfig: vi.fn(async (config) => { state.projectConfig = config; }),
    getLayerError: vi.fn(() => null),
    getProjectConfigPath: vi.fn((directory) => path.join(directory, '.opencode', 'opencode.json')),
    ...overrides,
  };
  registerWorkspaceRoutes(app, dependencies);
  return { app, dependencies, state };
};

const validPayload = {
  name: 'Shop Platform',
  repos: [{ projectId: 'api', alias: 'api', primary: true }],
};

describe('workspace routes', () => {
  it('answers 422 with the field that failed', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .post('/api/workspaces')
      .send({ name: '', repos: [] })
      .expect(422);

    expect(response.body).toEqual({
      error: 'Workspace is invalid',
      fields: { name: 'Name is required', repos: 'At least one repository is required' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('imports a workspace file as a draft without writing settings', async () => {
    const { app, dependencies } = createApp({
      fsPromises: {
        readFile: vi.fn(async () => JSON.stringify({ folders: [{ path: '/repos/api' }] })),
        realpath: vi.fn(async (value) => value),
      },
    });

    const response = await request(app)
      .post('/api/workspaces/import')
      .send({ path: '/work/shop.code-workspace' })
      .expect(200);

    expect(response.body).toEqual({
      name: 'shop',
      folders: [{ path: '/repos/api', alias: 'api', primary: true, error: null }],
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('answers 422 with the import reason for a file that is not a workspace', async () => {
    const { app, dependencies } = createApp({
      fsPromises: {
        readFile: vi.fn(async () => '{ "folders": [ }'),
        realpath: vi.fn(async (value) => value),
      },
    });

    const response = await request(app)
      .post('/api/workspaces/import')
      .send({ path: '/work/shop.code-workspace' })
      .expect(422);

    expect(response.body).toEqual({
      error: 'Workspace file is not valid JSON',
      importError: { reason: 'invalid-json' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('answers 500 when the settings write fails', async () => {
    const { app } = createApp({
      persistSettings: vi.fn(async () => { throw new Error('write failed with /private/path'); }),
    });

    const response = await request(app)
      .post('/api/workspaces')
      .send(validPayload)
      .expect(500);

    expect(response.body).toEqual({ error: 'Failed to create workspace' });
  });

  it('answers an error instead of an empty list when settings cannot be read', async () => {
    const { app } = createApp({
      readSettings: vi.fn(async () => { throw new Error('Settings file is malformed'); }),
    });

    const response = await request(app).get('/api/workspaces').expect(500);

    expect(response.body).toEqual({ error: 'Failed to read workspaces' });
  });

  it('serializes the active workspace reference states and one config parse error', async () => {
    const projectConfigPath = '/repos/api/.opencode/opencode.json';
    const message = `OpenCode configuration at ${projectConfigPath} contains invalid JSONC and cannot be loaded safely`;
    const { app } = createApp({
      readSettings: vi.fn(async () => ({
        projects: [
          { id: 'api', path: '/repos/api', label: 'API' },
          { id: 'web', path: '/repos/web', label: 'Web' },
        ],
        workspaces: [{
          id: 'ws_1',
          name: 'Shop Platform',
          primaryProjectId: 'api',
          repos: [
            { projectId: 'api', alias: 'api', description: 'API', branch: '' },
            { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
          ],
          createdRefs: [],
        }],
        activeWorkspaceId: 'ws_1',
      })),
      readConfigLayers: vi.fn(() => ({
        ...emptyLayers(),
        paths: { userPath: null, userOverridePath: null, projectPath: projectConfigPath, customPath: null },
        layerErrors: [{ path: projectConfigPath, code: 'INVALID_JSONC', message }],
      })),
      getProjectConfigPath: vi.fn(() => projectConfigPath),
    });

    const response = await request(app).get('/api/workspaces').expect(200);

    expect(response.body.refs).toEqual([
      { alias: 'web', path: '/repos/web', description: 'Web', status: 'unknown', owned: false, current: null },
    ]);
    expect(response.body.refsError).toEqual({ path: projectConfigPath, message });
  });

  it('answers 409 with the conflicting alias and path', async () => {
    const { app, dependencies } = createApp({
      readSettings: vi.fn(async () => ({
        projects: [
          { id: 'api', path: '/repos/api', label: 'API' },
          { id: 'web', path: '/repos/web', label: 'Web' },
        ],
        workspaces: [],
        activeWorkspaceId: null,
      })),
      readConfigLayers: vi.fn(() => ({
        ...emptyLayers(),
        userConfig: { references: { web: { path: '/user/web', description: 'User' } } },
        mergedConfig: { references: { web: { path: '/user/web', description: 'User' } } },
      })),
    });

    const response = await request(app)
      .post('/api/workspaces')
      .send({
        name: 'Shop Platform',
        repos: [
          { projectId: 'api', alias: 'api', primary: true },
          { projectId: 'web', alias: 'web' },
        ],
      })
      .expect(409);

    expect(response.body).toEqual({
      error: 'Reference alias is already in use',
      conflict: { alias: 'web', path: '/user/web' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('answers 422 with the config path and parse message', async () => {
    const message = 'OpenCode configuration at /repos/api/.opencode/opencode.json contains invalid JSONC and cannot be loaded safely';
    const projectConfigPath = '/repos/api/.opencode/opencode.json';
    const { app, dependencies } = createApp({
      readConfigLayers: vi.fn(() => ({
        ...emptyLayers(),
        paths: { userPath: null, userOverridePath: null, projectPath: projectConfigPath, customPath: null },
        layerErrors: [{ path: projectConfigPath, code: 'INVALID_JSONC', message }],
      })),
    });

    const response = await request(app)
      .post('/api/workspaces')
      .send(validPayload)
      .expect(422);

    expect(response.body).toEqual({
      error: 'OpenCode configuration cannot be read',
      configError: { path: projectConfigPath, message },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('answers PATCH 409 with the alias when an owned removal needs confirmation', async () => {
    const projectConfig = {
      references: { web: { path: '/user/edited', description: 'Edited' } },
    };
    const { app, dependencies } = createApp({
      readSettings: vi.fn(async () => ({
        projects: [
          { id: 'api', path: '/repos/api', label: 'API' },
          { id: 'web', path: '/repos/web', label: 'Web' },
        ],
        workspaces: [{
          id: 'ws_1',
          name: 'Shop Platform',
          primaryProjectId: 'api',
          repos: [
            { projectId: 'api', alias: 'api', description: 'API', branch: '' },
            { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
          ],
          createdRefs: ['web'],
        }],
        activeWorkspaceId: 'ws_1',
      })),
      readConfigLayers: vi.fn(() => ({
        ...emptyLayers(),
        projectConfig,
        mergedConfig: projectConfig,
      })),
      readConfigFile: vi.fn(() => projectConfig),
    });

    const response = await request(app)
      .patch('/api/workspaces/ws_1')
      .send({
        name: 'Shop Platform',
        repos: [{ projectId: 'api', alias: 'api', primary: true }],
      })
      .expect(409);

    expect(response.body).toEqual({
      error: 'Reference alias is already in use',
      conflict: { alias: 'web', path: '/user/edited' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('retries pending references by workspace id', async () => {
    const { app, state } = createApp({
      readSettings: vi.fn(async () => ({
        projects: [{ id: 'api', path: '/repos/api', label: 'API' }],
        workspaces: [{
          id: 'ws_1',
          name: 'Shop Platform',
          primaryProjectId: 'api',
          repos: [{ projectId: 'api', alias: 'api', description: 'API', branch: '' }],
          createdRefs: [],
        }],
        activeWorkspaceId: 'ws_1',
      })),
    });

    const response = await request(app)
      .post('/api/workspaces/ws_1/refs/retry')
      .send({})
      .expect(200);

    expect(response.body.refs).toEqual([]);
    expect(response.body.configTarget.path).toBe('/repos/api/.opencode/opencode.json');
    expect(state.projectConfig).toEqual({});
  });

  it('deletes a workspace and answers the removal result', async () => {
    const { app, dependencies } = createApp({
      readSettings: vi.fn(async () => ({
        projects: [{ id: 'api', path: '/repos/api', label: 'API' }],
        workspaces: [{
          id: 'ws_1',
          name: 'Shop Platform',
          primaryProjectId: 'api',
          repos: [{ projectId: 'api', alias: 'api', description: 'API', branch: '' }],
          createdRefs: [],
        }],
        activeWorkspaceId: 'ws_1',
      })),
    });

    const response = await request(app)
      .delete('/api/workspaces/ws_1')
      .send({ removeCreatedRefs: false })
      .expect(200);

    expect(response.body).toEqual({ removed: true, refs: [], failedAlias: null, configError: null });
    expect(dependencies.persistSettings).toHaveBeenCalledWith({
      workspaces: [],
      activeWorkspaceId: null,
    });
  });

  it('answers removed false with the alias when an owned removal fails', async () => {
    const projectConfig = {
      references: { web: { path: '/repos/web', description: 'Web' } },
    };
    const { app, dependencies } = createApp({
      readSettings: vi.fn(async () => ({
        projects: [
          { id: 'api', path: '/repos/api', label: 'API' },
          { id: 'web', path: '/repos/web', label: 'Web' },
        ],
        workspaces: [{
          id: 'ws_1',
          name: 'Shop Platform',
          primaryProjectId: 'api',
          repos: [
            { projectId: 'api', alias: 'api', description: 'API', branch: '' },
            { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
          ],
          createdRefs: ['web'],
        }],
        activeWorkspaceId: 'ws_1',
      })),
      readConfigLayers: vi.fn(() => ({
        ...emptyLayers(),
        projectConfig,
        mergedConfig: projectConfig,
      })),
      readConfigFile: vi.fn(() => projectConfig),
      writeConfig: vi.fn(async () => { throw new Error('permission denied'); }),
    });

    const response = await request(app)
      .delete('/api/workspaces/ws_1')
      .send({ removeCreatedRefs: true })
      .expect(200);

    expect(response.body).toMatchObject({ removed: false, failedAlias: 'web', configError: null });
    expect(response.body.refs).toContainEqual(expect.objectContaining({ alias: 'web', status: 'ok' }));
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown workspace', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .delete('/api/workspaces/ws_missing')
      .send({})
      .expect(404);

    expect(response.body).toEqual({ error: 'Workspace not found' });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });
});
