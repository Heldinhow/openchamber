import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createWorkspaceService } from './service.js';

// The service reads config through injected functions; the fixture suite at the
// bottom injects the real ones from shared.js. Its global config directory is
// fixed when shared.js loads, so point it at a fixture folder first.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-refs-'));
const userConfigDir = path.join(fixtureRoot, 'user');
fs.mkdirSync(userConfigDir, { recursive: true });
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
process.env.OPENCODE_CONFIG_DIR = userConfigDir;
const { readConfigLayers, getLayerError, getProjectConfigPath } = await import('../opencode/shared.js');

const writeUserConfig = (content) => fs.writeFileSync(path.join(userConfigDir, 'opencode.jsonc'), content);
writeUserConfig(`{
  // The user's own layer; this service never edits it.
  "references": {
    "user-only": { "path": "/outside/user-repo", "description": "User repo" },
    "both-layers": { "path": "/outside/user-repo", "description": "User repo" }
  },
  "keybinds": { "leader": "ctrl+x" }
}`);

afterEach(() => {
  if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
});

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
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
    readConfigLayers: vi.fn(emptyLayers),
    getLayerError: vi.fn(() => null),
    getProjectConfigPath: vi.fn((directory) => path.join(directory, '.opencode', 'opencode.json')),
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
    expect(result.refs).toEqual([
      { alias: 'gone', path: null, description: '', status: 'missing', owned: false, current: null },
    ]);
    expect(result.refsError).toBeNull();
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
      refs: [
        { alias: 'web', path: '/repos/web', description: '', status: 'missing', owned: false, current: null },
      ],
      refsError: null,
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

// Real config layers: the user layer is fixed at module load above, the custom
// layer follows OPENCODE_CONFIG, and each test writes its own project config.
const caseRoot = (name) => {
  const root = path.join(fixtureRoot, 'cases', name);
  fs.mkdirSync(root, { recursive: true });
  return root;
};

const projectAt = (root, id, label = id) => {
  const directory = path.join(root, 'repos', id);
  fs.mkdirSync(directory, { recursive: true });
  return { id, path: directory, label };
};

const writeProjectConfig = (project, content) => {
  const directory = path.join(project.path, '.opencode');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'opencode.json');
  fs.writeFileSync(file, content);
  return file;
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = JSON.stringify(value, null, 2);
  fs.writeFileSync(file, content);
  return { file, content };
};

const fixtureService = (settings, overrides = {}) => createService({
  readSettings: vi.fn(async () => settings),
  readConfigLayers,
  getLayerError,
  getProjectConfigPath,
  ...overrides,
});

describe('workspace service: reference states', () => {
  it('classifies ok, missing and different from the project config without touching it', async () => {
    const root = caseRoot('states');
    const primary = projectAt(root, 'primary', 'Primary');
    const web = projectAt(root, 'web', 'Web app');
    const docs = projectAt(root, 'docs', 'Docs');
    const mobile = projectAt(root, 'mobile', 'Mobile');
    const projectConfig = `{
  // hand-written project config
  "$schema": "https://opencode.ai/config.json",
  "keybinds": { "leader": "ctrl+x" },
  "references": {
    "web": { "path": ${JSON.stringify(`${web.path}${path.sep}`)}, "description": "Web app" },
    "docs": { "path": ${JSON.stringify(path.join(root, 'elsewhere'))}, "description": "Docs" },
    "mobile": { "path": ${JSON.stringify(mobile.path)}, "description": "Old mobile" }
  }
}`;
    const file = writeProjectConfig(primary, projectConfig);
    const stored = workspace({
      primaryProjectId: 'primary',
      repos: [
        { projectId: 'primary', alias: 'primary', description: 'Primary', branch: '' },
        { projectId: 'web', alias: 'web', description: 'Web app', branch: '' },
        { projectId: 'docs', alias: 'docs', description: 'Docs', branch: '' },
        { projectId: 'mobile', alias: 'mobile', description: 'Mobile', branch: '' },
        { projectId: 'gone', alias: 'gone', description: 'Gone', branch: '' },
      ],
    });
    const { service } = fixtureService({
      projects: [primary, web, docs, mobile],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.list();

    expect(result.refs).toEqual([
      {
        alias: 'web',
        path: path.resolve(web.path),
        description: 'Web app',
        status: 'ok',
        owned: false,
        current: { path: `${web.path}${path.sep}`, description: 'Web app' },
      },
      {
        alias: 'docs',
        path: path.resolve(docs.path),
        description: 'Docs',
        status: 'different',
        owned: false,
        current: { path: path.join(root, 'elsewhere'), description: 'Docs' },
      },
      {
        alias: 'mobile',
        path: path.resolve(mobile.path),
        description: 'Mobile',
        status: 'different',
        owned: false,
        current: { path: mobile.path, description: 'Old mobile' },
      },
      { alias: 'gone', path: null, description: 'Gone', status: 'missing', owned: false, current: null },
    ]);
    expect(result.refsError).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(projectConfig);
  });

  it('marks an alias defined only in another layer outside, and one the project also defines overridden', async () => {
    const root = caseRoot('layers');
    const primary = projectAt(root, 'primary', 'Primary');
    const outside = projectAt(root, 'outside', 'Outside');
    const both = projectAt(root, 'both', 'Both');
    const custom = writeJson(path.join(root, 'custom', 'opencode.json'), {
      references: { 'both-layers': { path: '/custom/both', description: 'Custom value' } },
    });
    process.env.OPENCODE_CONFIG = custom.file;
    writeProjectConfig(primary, JSON.stringify({
      references: { 'both-layers': { path: '/project/both', description: 'Project value' } },
    }));
    const stored = workspace({
      primaryProjectId: 'primary',
      repos: [
        { projectId: 'primary', alias: 'primary', description: 'Primary', branch: '' },
        { projectId: 'outside', alias: 'user-only', description: 'Outside', branch: '' },
        { projectId: 'both', alias: 'both-layers', description: 'Both', branch: '' },
      ],
    });
    const { service } = fixtureService({
      projects: [primary, outside, both],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.list();

    expect(result.refs).toEqual([
      {
        alias: 'user-only',
        path: path.resolve(outside.path),
        description: 'Outside',
        status: 'outside',
        owned: false,
        current: { path: '/outside/user-repo', description: 'User repo' },
      },
      {
        alias: 'both-layers',
        path: path.resolve(both.path),
        description: 'Both',
        status: 'overridden',
        owned: false,
        current: { path: '/project/both', description: 'Project value' },
      },
    ]);
    expect(result.refsError).toBeNull();
    expect(custom.content).toContain('Custom value');
  });

  it('answers unknown for every ref, with one parse error, when a layer cannot be parsed', async () => {
    const root = caseRoot('unreadable');
    const primary = projectAt(root, 'primary', 'Primary');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    const file = writeProjectConfig(primary, '{\n  "references": {\n    "web": { "path": ');
    const stored = workspace({
      primaryProjectId: 'primary',
      repos: [
        { projectId: 'primary', alias: 'primary', description: 'Primary', branch: '' },
        { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
        { projectId: 'docs', alias: 'docs', description: 'Docs', branch: '' },
      ],
    });
    const { service } = fixtureService({
      projects: [primary, web, docs],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.list();

    expect(result.refs).toEqual([
      { alias: 'web', path: path.resolve(web.path), description: 'Web', status: 'unknown', owned: false, current: null },
      { alias: 'docs', path: path.resolve(docs.path), description: 'Docs', status: 'unknown', owned: false, current: null },
    ]);
    expect(result.refsError).toMatchObject({ path: file });
    expect(result.refsError.message).toMatch(/invalid JSONC/);
    expect(result.refsError.message).not.toContain('references');
    expect(Object.keys(result.refsError).sort()).toEqual(['message', 'path']);
  });

  it('classifies the refs as missing without reading config when the primary project is gone', async () => {
    const root = caseRoot('primary-gone');
    const web = projectAt(root, 'web', 'Web');
    const stored = workspace({
      primaryProjectId: 'gone',
      repos: [
        { projectId: 'gone', alias: 'main', description: '', branch: '' },
        { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
      ],
    });
    const readConfigLayersSpy = vi.fn(() => {
      throw new Error('config must not be read without a primary project');
    });
    const { service } = fixtureService(
      { projects: [web], workspaces: [stored], activeWorkspaceId: 'ws_1' },
      { readConfigLayers: readConfigLayersSpy },
    );

    const result = await service.list();

    expect(result.workspaces).toHaveLength(1);
    expect(result.refs).toEqual([
      { alias: 'web', path: path.resolve(web.path), description: 'Web', status: 'missing', owned: false, current: null },
    ]);
    expect(result.refsError).toBeNull();
    expect(readConfigLayersSpy).not.toHaveBeenCalled();
  });

  it('classifies a malformed entry as different without hiding the other refs', async () => {
    const root = caseRoot('malformed-entry');
    const primary = projectAt(root, 'primary', 'Primary');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    writeProjectConfig(primary, JSON.stringify({
      references: { web: 42, docs: { path: docs.path, description: 'Docs' } },
    }));
    const stored = workspace({
      primaryProjectId: 'primary',
      repos: [
        { projectId: 'primary', alias: 'primary', description: 'Primary', branch: '' },
        { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
        { projectId: 'docs', alias: 'docs', description: 'Docs', branch: '' },
      ],
    });
    const { service } = fixtureService({
      projects: [primary, web, docs],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.list();

    expect(result.refs.map((ref) => [ref.alias, ref.status])).toEqual([
      ['web', 'different'],
      ['docs', 'ok'],
    ]);
    expect(result.refs[0].current).toBeNull();
  });

  it('marks an expected alias owned only when createdRefs lists it', async () => {
    const root = caseRoot('ownership');
    const primary = projectAt(root, 'primary', 'Primary');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    writeProjectConfig(primary, JSON.stringify({
      references: {
        web: { path: web.path, description: 'Web' },
        docs: { path: docs.path, description: 'Docs' },
      },
    }));
    const stored = workspace({
      primaryProjectId: 'primary',
      createdRefs: ['web'],
      repos: [
        { projectId: 'primary', alias: 'primary', description: 'Primary', branch: '' },
        { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
        { projectId: 'docs', alias: 'docs', description: 'Docs', branch: '' },
      ],
    });
    const { service } = fixtureService({
      projects: [primary, web, docs],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.list();

    expect(result.refs.map((ref) => [ref.alias, ref.status, ref.owned])).toEqual([
      ['web', 'ok', true],
      ['docs', 'ok', false],
    ]);
  });

  it('returns the new workspace refs without owning them before ticket 05 writes', async () => {
    const root = caseRoot('create-refs');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const projectConfig = JSON.stringify({
      references: { web: { path: web.path, description: 'Web' } },
    });
    const file = writeProjectConfig(api, projectConfig);
    const { service } = fixtureService({ projects: [api, web], workspaces: [], activeWorkspaceId: null });

    const result = await service.create({
      name: 'Shop Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { projectId: 'web', alias: 'web' },
      ],
    });

    expect(result.workspace.createdRefs).toEqual([]);
    expect(result.refs).toEqual([
      {
        alias: 'web',
        path: path.resolve(web.path),
        description: 'Web',
        status: 'ok',
        owned: false,
        current: { path: web.path, description: 'Web' },
      },
    ]);
    expect(result.refsError).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(projectConfig);
  });
});
