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
    readConfigLayers: vi.fn(emptyLayers),
    getLayerError: vi.fn(() => null),
    getProjectConfigPath: vi.fn((directory) => path.join(directory, '.opencode', 'opencode.json')),
    ...overrides,
  };
  registerWorkspaceRoutes(app, dependencies);
  return { app, dependencies };
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
});
