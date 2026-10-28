import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';
import { registerWorkspaceRoutes } from './routes.js';

// The real directory rule, so a file or a symlink is checked against the disk
// rather than against a stub that always says yes.
const directoryRuntime = createProjectDirectoryRuntime({
  fsPromises: fs.promises,
  path,
  normalizeDirectoryPath: (value) => value,
  readSettingsFromDiskMigrated: async () => ({}),
  getReadSettingsFromDiskMigrated: () => async () => ({}),
  sanitizeProjects: (input) => input,
});

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
    readConfigFile: vi.fn((filePath) => (
      filePath === '/repos/api/.opencode/opencode.json' ? state.projectConfig : {}
    )),
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

  it('reads the config target for a folder that is not a project yet', async () => {
    const rootConfig = '/work/api/opencode.json';
    const { app } = createApp({
      fsPromises: {
        mkdir: vi.fn(async () => undefined),
        stat: vi.fn(async (filePath) => ({ isFile: () => filePath === rootConfig })),
      },
    });

    const response = await request(app)
      .get('/api/workspaces/config-target')
      .query({ path: '/work/api' })
      .expect(200);

    expect(response.body).toEqual({
      path: '/work/api/.opencode/opencode.json',
      rootConfigPath: rootConfig,
    });
  });

  it('answers 422 with the config path when the target cannot be read', async () => {
    const projectConfigPath = '/work/api/.opencode/opencode.json';
    const message = `OpenCode configuration at ${projectConfigPath} contains invalid JSONC and cannot be loaded safely`;
    const { app } = createApp({
      readConfigLayers: vi.fn(() => ({
        ...emptyLayers(),
        paths: { userPath: null, userOverridePath: null, projectPath: projectConfigPath, customPath: null },
        layerErrors: [{ path: projectConfigPath, code: 'INVALID_JSONC', message }],
      })),
      getProjectConfigPath: vi.fn(() => projectConfigPath),
    });

    const response = await request(app)
      .get('/api/workspaces/config-target')
      .query({ path: '/work/api' })
      .expect(422);

    expect(response.body).toEqual({
      error: 'OpenCode configuration cannot be read',
      configError: { path: projectConfigPath, message },
    });
  });

  it('refuses a relative config-target path without touching the disk', async () => {
    const { app, dependencies } = createApp({
      validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    });

    const response = await request(app)
      .get('/api/workspaces/config-target')
      .query({ path: 'relative/api' })
      .expect(422);

    expect(response.body).toEqual({
      error: 'Workspace is invalid',
      fields: { path: 'Folder path must be absolute' },
    });
    expect(dependencies.validateDirectoryPath).not.toHaveBeenCalled();
  });

  it('refuses a config-target path that is a file, not a directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-target-file-'));
    const filePath = path.join(root, 'api.json');
    fs.writeFileSync(filePath, '{}');
    const { app } = createApp({
      validateDirectoryPath: directoryRuntime.validateDirectoryPath,
      fsPromises: { stat: fs.promises.stat.bind(fs.promises) },
    });

    try {
      const response = await request(app)
        .get('/api/workspaces/config-target')
        .query({ path: filePath })
        .expect(422);

      expect(response.body).toEqual({
        error: 'Workspace is invalid',
        fields: { path: 'Specified path is not a directory' },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers the canonical path for a symlinked config-target directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-target-link-'));
    const real = path.join(root, 'repos', 'api');
    const link = path.join(root, 'api-link');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, link, 'dir');
    const { app } = createApp({
      validateDirectoryPath: directoryRuntime.validateDirectoryPath,
      fsPromises: { stat: fs.promises.stat.bind(fs.promises) },
    });

    try {
      const response = await request(app)
        .get('/api/workspaces/config-target')
        .query({ path: link })
        .expect(200);

      expect(response.body).toEqual({
        path: path.join(fs.realpathSync(real), '.opencode', 'opencode.json'),
        rootConfigPath: null,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      readConfigFile: vi.fn((filePath) => (
        filePath === '/repos/api/.opencode/opencode.json' ? projectConfig : {}
      )),
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

  it('answers PATCH 409 and keeps settings when an owned entry cannot be located', async () => {
    const projectConfig = {
      references: {
        web: { path: '/repos/web', description: 'Web' },
        gone: { path: '/gone/repo', description: 'Gone' },
      },
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
            { projectId: 'gone', alias: 'gone', description: 'Gone', branch: '' },
          ],
          createdRefs: ['web', 'gone'],
        }],
        activeWorkspaceId: 'ws_1',
      })),
      readConfigLayers: vi.fn(() => ({
        ...emptyLayers(),
        projectConfig,
        mergedConfig: projectConfig,
      })),
      readConfigFile: vi.fn((filePath) => (
        filePath === '/repos/api/.opencode/opencode.json' ? projectConfig : {}
      )),
    });

    const response = await request(app)
      .patch('/api/workspaces/ws_1')
      .send({
        name: 'Shop Platform',
        repos: [{ projectId: 'api', alias: 'api', primary: true }],
      })
      .expect(409);

    expect(response.body).toEqual({
      error: 'An owned reference cannot be verified for removal',
      conflict: { alias: 'gone', path: null },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('answers 500 with the config path when the settings write and the restore both fail', async () => {
    let storedConfig = { references: { web: { path: '/repos/web', description: 'Web' } } };
    let writes = 0;
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
          createdRefs: ['web'],
        }],
        activeWorkspaceId: 'ws_1',
      })),
      readConfigLayers: vi.fn(() => ({
        ...emptyLayers(),
        projectConfig: storedConfig,
        mergedConfig: storedConfig,
      })),
      readConfigFile: vi.fn((filePath) => (
        filePath === '/repos/api/.opencode/opencode.json' ? storedConfig : {}
      )),
      writeConfig: vi.fn(async (config) => {
        writes += 1;
        if (writes > 1) throw new Error('permission denied');
        storedConfig = config;
      }),
      persistSettings: vi.fn(async () => { throw new Error('Settings write failed'); }),
    });

    const response = await request(app)
      .patch('/api/workspaces/ws_1')
      .send({
        name: 'Shop Platform',
        repos: [{ projectId: 'api', alias: 'api', primary: true }],
      })
      .expect(500);

    expect(response.body).toEqual({
      error: 'Failed to restore workspace references',
      configError: {
        path: '/repos/api/.opencode/opencode.json',
        message: 'The settings write failed and the removed references could not be restored',
      },
    });
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
      readConfigFile: vi.fn((filePath) => (
        filePath === '/repos/api/.opencode/opencode.json' ? projectConfig : {}
      )),
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

  it('removes a hand-edited owned reference when DELETE confirms it', async () => {
    const { app, state, dependencies } = createApp({
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
    });
    state.projectConfig = { references: { web: { path: '/user/edited', description: 'Edited' } } };

    const refused = await request(app)
      .delete('/api/workspaces/ws_1')
      .send({ removeCreatedRefs: true })
      .expect(200);

    expect(refused.body).toMatchObject({ removed: false, failedAlias: 'web' });
    expect(state.projectConfig.references.web).toEqual({ path: '/user/edited', description: 'Edited' });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();

    const confirmed = await request(app)
      .delete('/api/workspaces/ws_1')
      .send({ removeCreatedRefs: true, confirmRefs: ['web'] })
      .expect(200);

    expect(confirmed.body).toMatchObject({ removed: true, failedAlias: null });
    expect(state.projectConfig.references).toEqual({});
    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
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
