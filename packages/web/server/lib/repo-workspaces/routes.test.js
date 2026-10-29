import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerWorkspaceRoutes } from './routes.js';

let root;
let dataDir;
let folder;

const createApp = (overrides = {}) => {
  const state = {
    settings: {
      projects: [],
      workspaces: [],
      activeProjectId: null,
    },
  };
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  const dependencies = {
    readSettings: vi.fn(async () => state.settings),
    persistSettings: vi.fn(async (changes) => {
      state.settings = { ...state.settings, ...changes };
      return state.settings;
    }),
    sanitizeProjects: (value) => (Array.isArray(value) ? value : undefined),
    sanitizeRepoWorkspaces: (value) => (Array.isArray(value) ? { workspaces: value, discarded: 0 } : undefined),
    validateDirectoryPath: vi.fn(async (candidate) => {
      const stats = await fs.promises.stat(candidate);
      return { ok: stats.isDirectory(), directory: await fs.promises.realpath(candidate) };
    }),
    fsPromises: fs.promises,
    crypto: { randomUUID: () => 'uuid-1' },
    readConfigFile: () => ({}),
    writeConfig: vi.fn(),
    openchamberDataDir: dataDir,
    ...overrides,
  };
  registerWorkspaceRoutes(app, dependencies);
  return { app, dependencies, state };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-workspace-routes-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const createdFolder = path.join(root, 'repo');
  fs.mkdirSync(createdFolder, { recursive: true });
  folder = fs.realpathSync(createdFolder);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace routes', () => {
  it('lists resolved workspaces', async () => {
    const { app } = createApp({
      readSettings: async () => ({
        projects: [{ id: 'p', path: folder, label: 'Repo' }],
        workspaces: [{ id: 'ws_1', name: 'Shop', projectIds: ['p'] }],
      }),
    });

    const response = await request(app).get('/api/workspaces').expect(200);

    expect(response.body.discarded).toBe(0);
    expect(response.body.workspaces[0]).toMatchObject({
      id: 'ws_1',
      name: 'Shop',
      directory: path.join(dataDir, 'workspaces', 'ws_1'),
      projects: [{ projectId: 'p', missing: false, project: { id: 'p', path: folder, label: 'Repo' } }],
    });
    expect(response.body.workspaces[0].configError).toEqual({
      path: path.join(dataDir, 'workspaces', 'ws_1', '.opencode', 'opencode.json'),
      message: 'Failed to read the workspace configuration',
    });
  });

  it('creates a workspace and answers 201', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .post('/api/workspaces')
      .send({ name: 'Shop', folders: [{ path: folder }] })
      .expect(201);

    expect(response.body.workspace.name).toBe('Shop');
    expect(response.body.workspace.projects[0].project.path).toBe(folder);
    expect(response.body.configError).toBeNull();
    expect(dependencies.persistSettings).toHaveBeenCalledWith(expect.objectContaining({
      projects: [expect.objectContaining({ path: folder })],
      workspaces: [expect.objectContaining({ name: 'Shop' })],
    }));
  });

  it('answers 422 with the field that failed and writes nothing', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .post('/api/workspaces')
      .send({ name: '', folders: [] })
      .expect(422);

    expect(response.body).toEqual({
      error: 'Workspace is invalid',
      fields: { name: 'Name is required', folders: 'At least one folder is required' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('edits a workspace and answers 404 for an unknown id', async () => {
    const { app, state } = createApp();
    state.settings.workspaces = [{ id: 'ws_1', name: 'Shop', projectIds: [] }];

    const response = await request(app)
      .patch('/api/workspaces/ws_1')
      .send({ name: 'Renamed', folders: [{ path: folder }] })
      .expect(200);

    expect(response.body.workspace.name).toBe('Renamed');
    await request(app)
      .patch('/api/workspaces/ws_missing')
      .send({ name: 'Renamed', folders: [{ path: folder }] })
      .expect(404);
  });

  it('keeps internal failures opaque', async () => {
    const { app } = createApp({ readSettings: async () => { throw new Error('disk content'); } });

    const response = await request(app).get('/api/workspaces').expect(500);

    expect(response.body).toEqual({ error: 'Failed to read workspaces' });
  });
});
