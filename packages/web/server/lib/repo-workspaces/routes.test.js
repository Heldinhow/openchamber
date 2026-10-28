import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerWorkspaceRoutes } from './routes.js';

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
});
