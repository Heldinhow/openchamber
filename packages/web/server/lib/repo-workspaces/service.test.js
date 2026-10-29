import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfigFile, writeConfig } from '../opencode/shared.js';
import { createWorkspaceService, WorkspaceRequestError } from './service.js';

let root;
let dataDir;
let projectsRoot;

const makeFolder = (name) => {
  const folder = path.join(projectsRoot, name);
  fs.mkdirSync(folder, { recursive: true });
  return fs.realpathSync(folder);
};

const legacyWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectIds: z.array(z.string()).optional(),
  repos: z.array(z.object({ projectId: z.string() })).optional(),
});

const sanitizeWorkspaces = (value) => {
  if (!Array.isArray(value)) return undefined;
  return {
    workspaces: value.flatMap((entry) => {
      const parsed = legacyWorkspaceSchema.safeParse(entry);
      if (!parsed.success) return [];
      const ids = parsed.data.projectIds ?? parsed.data.repos?.map((repo) => repo.projectId) ?? [];
      return ids.length > 0 ? [{ id: parsed.data.id, name: parsed.data.name, projectIds: [...new Set(ids)] }] : [];
    }),
    discarded: 0,
  };
};

const realDirectories = async (candidate) => {
  try {
    const stats = await fs.promises.stat(candidate);
    if (!stats.isDirectory()) return { ok: false, error: 'Specified path is not a directory' };
    return { ok: true, directory: await fs.promises.realpath(candidate) };
  } catch (error) {
    return { ok: false, error: error?.code === 'ENOENT' ? 'Directory not found' : 'Failed to validate directory' };
  }
};

const snapshot = (directory) => {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      entries.push(path.relative(directory, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(directory);
  return entries.sort();
};

const createService = (initialSettings = {}) => {
  const state = {
    settings: {
      projects: [],
      activeProjectId: null,
      ...initialSettings,
    },
  };
  let uuid = 0;
  const dependencies = {
    readSettings: vi.fn(async () => JSON.parse(JSON.stringify(state.settings))),
    persistSettings: vi.fn(async (changes) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      state.settings = { ...state.settings, ...changes };
      return state.settings;
    }),
    sanitizeProjects: (value) => (Array.isArray(value) ? value : undefined),
    sanitizeRepoWorkspaces: sanitizeWorkspaces,
    validateDirectoryPath: vi.fn(realDirectories),
    fsPromises: fs.promises,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    readConfigFile,
    writeConfig,
    openchamberDataDir: dataDir,
  };
  return { service: createWorkspaceService(dependencies), dependencies, state };
};

const readWorkspaceConfig = (workspaceId) => JSON.parse(fs.readFileSync(
  path.join(dataDir, 'workspaces', workspaceId, '.opencode', 'opencode.json'),
  'utf8',
));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-workspace-'));
  dataDir = path.join(root, 'data');
  projectsRoot = path.join(root, 'projects');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace service: create', () => {
  it('stores the name and folder order and writes absolute references with edit allow rules', async () => {
    const api = makeFolder('api');
    const web = makeFolder('web');
    const { service, state } = createService();

    const result = await service.create({
      name: 'Shop',
      folders: [{ path: api }, { path: web }],
    });

    expect(result.configError).toBeNull();
    expect(result.workspace.id).toMatch(/^ws_/);
    expect(result.workspace.directory).toBe(path.join(dataDir, 'workspaces', result.workspace.id));
    expect(result.workspace.projects.map((entry) => entry.project.path)).toEqual([api, web]);
    expect(state.settings.workspaces).toEqual([{
      id: result.workspace.id,
      name: 'Shop',
      projectIds: result.workspace.projects.map((entry) => entry.projectId),
    }]);
    expect(state.settings.activeProjectId).toBeNull();
    expect(state.settings.projects.map((project) => project.path)).toEqual([api, web]);

    const config = readWorkspaceConfig(result.workspace.id);
    expect(config.references).toEqual({
      api: { path: api, description: 'api' },
      web: { path: web, description: 'web' },
    });
    expect(config.permissions).toEqual([
      { action: 'edit', resource: `${api}/*`, effect: 'allow' },
      { action: 'edit', resource: `${web}/*`, effect: 'allow' },
    ]);
  });

  it('reuses a registered project and a shared project without copying it', async () => {
    const shared = makeFolder('shared');
    const first = createService({
      projects: [{ id: 'p_shared', path: shared, label: 'Shared' }],
      activeProjectId: 'p_shared',
    });

    const one = await first.service.create({ name: 'One', folders: [{ projectId: 'p_shared' }] });
    const two = await first.service.create({ name: 'Two', folders: [{ path: shared }, { path: makeFolder('other') }] });

    expect(one.workspace.projects[0].projectId).toBe('p_shared');
    expect(two.workspace.projects[0].projectId).toBe('p_shared');
    expect(first.state.settings.projects).toHaveLength(2);
    expect(first.state.settings.activeProjectId).toBe('p_shared');
  });

  it('names references from labels with suffixes', async () => {
    const one = makeFolder('one');
    const two = makeFolder('two');
    const { service } = createService({
      projects: [
        { id: 'p_one', path: one, label: 'App' },
        { id: 'p_two', path: two, label: 'App' },
      ],
    });

    const result = await service.create({
      name: 'Shop',
      folders: [{ path: one }, { path: two }],
    });

    expect(result.workspace.projects.map((entry) => entry.projectId)).toEqual(['p_one', 'p_two']);
    expect(Object.keys(readWorkspaceConfig(result.workspace.id).references)).toEqual(['App', 'App-2']);
  });

  it('rejects a duplicate folder instead of silently dropping it', async () => {
    const one = makeFolder('one');
    const { service, dependencies } = createService({
      projects: [{ id: 'p_one', path: one, label: 'One' }],
    });

    await expect(service.create({
      name: 'Shop',
      folders: [{ path: one }, { projectId: 'p_one' }],
    })).rejects.toMatchObject({
      status: 422,
      fields: { 'folders[1].projectId': 'This project is already in the workspace' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('rejects a missing folder before anything is saved', async () => {
    const { service, dependencies } = createService();

    await expect(service.create({
      name: 'Shop',
      folders: [{ path: path.join(projectsRoot, 'gone') }],
    })).rejects.toMatchObject({
      status: 422,
      fields: { 'folders[0].path': 'Directory not found' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('rejects an unknown project id and a malformed payload', async () => {
    const { service, dependencies } = createService();

    await expect(service.create({ name: 'Shop', folders: [{ projectId: 'gone' }] }))
      .rejects.toMatchObject({ status: 422, fields: { 'folders[0].projectId': 'Project not found' } });
    await expect(service.create({ name: '', folders: [] }))
      .rejects.toMatchObject({ status: 422, fields: { name: 'Name is required', folders: 'At least one folder is required' } });
    await expect(service.create({ name: 'Shop', folders: [{ path: '/a', projectId: 'b' }] }))
      .rejects.toBeInstanceOf(WorkspaceRequestError);
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('never writes inside a member repository', async () => {
    const api = makeFolder('api');
    fs.writeFileSync(path.join(api, 'README.md'), '# API');
    fs.mkdirSync(path.join(api, '.opencode'));
    fs.writeFileSync(path.join(api, '.opencode', 'opencode.json'), '{"references":{}}');
    const before = snapshot(api);
    const { service } = createService();

    await service.create({ name: 'Shop', folders: [{ path: api }] });

    expect(snapshot(api)).toEqual(before);
  });

  it('keeps concurrent saves from dropping each other', async () => {
    const { service, state } = createService();
    const first = makeFolder('first');
    const second = makeFolder('second');

    await Promise.all([
      service.create({ name: 'First', folders: [{ path: first }] }),
      service.create({ name: 'Second', folders: [{ path: second }] }),
    ]);

    expect(state.settings.workspaces.map((workspace) => workspace.name).sort()).toEqual(['First', 'Second']);
  });
});

describe('workspace service: list and update', () => {
  it('reads legacy primary-based settings in repo order and creates its neutral config', async () => {
    const api = makeFolder('api');
    const web = makeFolder('web');
    const before = [snapshot(api), snapshot(web)];
    const { service, dependencies, state } = createService({
      projects: [{ id: 'p_api', path: api }, { id: 'p_web', path: web }],
      workspaces: [{
        id: 'ws_legacy',
        name: 'Legacy',
        primaryProjectId: 'p_api',
        repos: [
          { projectId: 'p_web', alias: 'web', description: 'Web', branch: 'main' },
          { projectId: 'p_api', alias: 'api', description: 'API', branch: 'main' },
        ],
        createdRefs: ['api'],
        editRules: [{ alias: 'api', resource: `${api}/*`, effect: 'allow' }],
      }],
      activeWorkspaceId: 'ws_legacy',
    });

    const result = await service.list();

    expect(result.workspaces[0].projects.map((entry) => entry.projectId)).toEqual(['p_web', 'p_api']);
    // The neutral directory did not exist yet; reading the workspace creates it
    // from the stored project order instead of reporting a config error.
    expect(result.workspaces[0].configError).toBeNull();
    expect(result.workspaces[0].directory).toBe(path.join(dataDir, 'workspaces', 'ws_legacy'));
    expect(readWorkspaceConfig('ws_legacy').references).toEqual({
      web: { path: web, description: 'web' },
      api: { path: api, description: 'api' },
    });
    expect([snapshot(api), snapshot(web)]).toEqual(before);
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(state.settings.workspaces[0].primaryProjectId).toBe('p_api');
  });

  it('discards a stored id that cannot name a directory', async () => {
    const api = makeFolder('api');
    const { service, dependencies } = createService({
      projects: [{ id: 'p_api', path: api }],
      workspaces: [{
        id: '../../../escape',
        name: 'Escape',
        projectIds: ['p_api'],
      }],
    });

    const result = await service.list();

    expect(result.workspaces).toEqual([]);
    expect(result.discarded).toBe(1);
    await expect(service.update('../../../escape', {
      name: 'Escape',
      folders: [{ projectId: 'p_api' }],
    })).rejects.toMatchObject({ status: 404 });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('keeps a project that left the catalog as missing and still lists the others', async () => {
    const api = makeFolder('api');
    const web = makeFolder('web');
    const { service, state } = createService();

    const created = await service.create({ name: 'Shop', folders: [{ path: api }, { path: web }] });
    state.settings.projects = state.settings.projects.filter((project) => project.path !== web);

    const result = await service.list();
    const workspace = result.workspaces[0];

    expect(workspace.id).toBe(created.workspace.id);
    expect(workspace.projects.map((entry) => [entry.projectId, entry.missing])).toEqual([
      [created.workspace.projects[0].projectId, false],
      [created.workspace.projects[1].projectId, true],
    ]);
    expect(workspace.configError).toBeNull();
  });

  it('keeps a malformed neutral config and reports it without overwriting', async () => {
    const api = makeFolder('api');
    const { service } = createService();
    const created = await service.create({ name: 'Shop', folders: [{ path: api }] });
    const configPath = path.join(created.workspace.directory, '.opencode', 'opencode.json');
    fs.writeFileSync(configPath, '{ not json');

    const result = await service.list();

    expect(result.workspaces[0].configError?.path).toBe(configPath);
    expect(result.workspaces[0].projects).toHaveLength(1);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ not json');
  });

  it('saves an edit under the same id and directory and updates references in place', async () => {
    const api = makeFolder('api');
    const web = makeFolder('web');
    const { service } = createService();
    const created = await service.create({ name: 'Shop', folders: [{ path: api }, { path: web }] });

    const edited = await service.update(created.workspace.id, {
      name: 'Shop renamed',
      folders: [{ path: web }],
    });

    expect(edited.workspace.id).toBe(created.workspace.id);
    expect(edited.workspace.directory).toBe(created.workspace.directory);
    expect(edited.workspace.name).toBe('Shop renamed');
    expect(edited.workspace.projects.map((entry) => entry.project.path)).toEqual([web]);
    const config = readWorkspaceConfig(created.workspace.id);
    expect(Object.values(config.references).map((entry) => entry.path)).toEqual([web]);
    expect(config.permissions).toEqual([{ action: 'edit', resource: `${web}/*`, effect: 'allow' }]);
  });

  it('keeps a missing project id on edit when the row was already stored', async () => {
    const api = makeFolder('api');
    const { service, state } = createService();
    const created = await service.create({ name: 'Shop', folders: [{ path: api }] });
    const missingId = 'p_gone';
    state.settings.projects = [];
    state.settings.workspaces[0].projectIds = [created.workspace.projects[0].projectId, missingId];

    const edited = await service.update(created.workspace.id, {
      name: 'Shop',
      folders: [{ projectId: created.workspace.projects[0].projectId }, { projectId: missingId }],
    });

    expect(edited.workspace.projects.map((entry) => entry.missing)).toEqual([true, true]);
    expect(state.settings.workspaces[0].projectIds).toEqual([created.workspace.projects[0].projectId, missingId]);
  });

  it('answers 404 for an unknown workspace', async () => {
    const { service, dependencies } = createService();
    await expect(service.update('ws_missing', { name: 'Shop', folders: [{ path: projectsRoot }] }))
      .rejects.toMatchObject({ status: 404 });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('keeps the workspace when the neutral config cannot be written', async () => {
    const api = makeFolder('api');
    const state = { settings: { projects: [], workspaces: [] } };
    const failing = createWorkspaceService({
      readSettings: async () => state.settings,
      persistSettings: async (changes) => { state.settings = { ...state.settings, ...changes }; },
      sanitizeProjects: (value) => value,
      sanitizeRepoWorkspaces: sanitizeWorkspaces,
      validateDirectoryPath: realDirectories,
      fsPromises: fs.promises,
      crypto: { randomUUID: () => 'uuid-failing' },
      readConfigFile,
      writeConfig: vi.fn(() => { throw new Error('EACCES'); }),
      openchamberDataDir: dataDir,
    });

    const result = await failing.create({ name: 'Shop', folders: [{ path: api }] });

    expect(result.configError?.path).toContain(path.join('workspaces', result.workspace.id));
    expect(state.settings.workspaces).toHaveLength(1);
  });

  it('does not treat an unreadable settings document as no workspaces', async () => {
    const { service } = createService();
    const failing = createWorkspaceService({
      readSettings: async () => { throw new Error('settings unreadable'); },
      persistSettings: vi.fn(),
      sanitizeProjects: (value) => value,
      sanitizeRepoWorkspaces: (value) => value,
      validateDirectoryPath: realDirectories,
      fsPromises: fs.promises,
      crypto: { randomUUID: () => 'uuid-1' },
      readConfigFile,
      writeConfig,
      openchamberDataDir: dataDir,
    });

    await expect(failing.list()).rejects.toThrow('settings unreadable');
    await expect(service.list()).resolves.toEqual({ workspaces: [], discarded: 0 });
  });
});
