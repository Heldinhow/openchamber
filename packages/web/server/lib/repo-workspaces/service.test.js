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
const { readConfigLayers, readConfigFile, writeConfig, getLayerError, getProjectConfigPath } = await import('../opencode/shared.js');

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
  const state = { projectConfig: {}, writes: [] };
  const layers = () => ({
    ...emptyLayers(),
    projectConfig: state.projectConfig,
    mergedConfig: state.projectConfig,
  });
  const dependencies = {
    readSettings: vi.fn(async () => ({ projects, workspaces: [], activeWorkspaceId: null })),
    persistSettings: vi.fn(async (changes) => changes),
    sanitizeProjects: (value) => (Array.isArray(value) ? value : undefined),
    sanitizeRepoWorkspaces: (value) => (Array.isArray(value) ? { workspaces: value, discarded: 0 } : undefined),
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    fsPromises: { mkdir: vi.fn(async () => undefined) },
    crypto: { randomUUID: () => 'fixed-uuid' },
    readConfigLayers: vi.fn(layers),
    readConfigFile: vi.fn(() => state.projectConfig),
    writeConfig: vi.fn(async (config) => {
      state.projectConfig = config;
      state.writes.push(config);
    }),
    getLayerError: vi.fn(() => null),
    getProjectConfigPath: vi.fn((directory) => path.join(directory, '.opencode', 'opencode.json')),
    ...overrides,
  };
  return { service: createWorkspaceService(dependencies), dependencies, state };
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

  it('reports an unreadable config as unknown for one workspace without hiding the others', async () => {
    const brokenConfigPath = path.join('/repos/broken', '.opencode', 'opencode.json');
    const { service } = createService({
      readSettings: vi.fn(async () => ({
        projects: [...projects, { id: 'broken', path: '/repos/broken', label: 'Broken' }],
        workspaces: [
          workspace(),
          workspace({
            id: 'ws_2',
            name: 'Broken Platform',
            primaryProjectId: 'broken',
            repos: [
              { projectId: 'broken', alias: 'broken', description: 'Broken', branch: '' },
              { projectId: 'web', alias: 'web', description: '', branch: '' },
            ],
          }),
        ],
        activeWorkspaceId: 'ws_1',
      })),
      readConfigLayers: vi.fn((directory) => {
        if (directory === '/repos/broken') {
          const error = new Error(`EACCES: permission denied, open '${brokenConfigPath}'`);
          error.code = 'EACCES';
          throw error;
        }
        return { ...emptyLayers(), projectConfig: {}, mergedConfig: {} };
      }),
    });

    const result = await service.list();

    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0].refsError).toBeNull();
    expect(result.workspaces[1].refs).toEqual([
      { alias: 'web', path: '/repos/web', description: '', status: 'unknown', owned: false, current: null },
    ]);
    expect(result.workspaces[1].refsError).toEqual({
      path: brokenConfigPath,
      message: expect.stringContaining('EACCES'),
    });
    expect(result.refsError).toBeNull();
  });
});

describe('workspace service: create', () => {
  it('stores the workspace and its pointer in one write, then writes the secondary reference', async () => {
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
        createdRefs: ['web'],
      },
      refs: [
        {
          alias: 'web',
          path: '/repos/web',
          description: '',
          status: 'ok',
          owned: true,
          current: { path: '/repos/web', description: '' },
        },
      ],
      refWrites: [{ alias: 'web', status: 'written' }],
      refsError: null,
      configTarget: { path: '/repos/api/.opencode/opencode.json', rootConfigPath: null },
    });
    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
    expect(dependencies.persistSettings).toHaveBeenCalledWith({
      workspaces: [result.workspace],
      activeWorkspaceId: 'ws_fixed-uuid',
      activeProjectId: 'api',
    });
    expect(dependencies.writeConfig).toHaveBeenCalledWith(
      { references: { web: { path: '/repos/web', description: '' } } },
      '/repos/api/.opencode/opencode.json',
    );
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

  it('keeps both workspaces when two creates read the settings document at once', async () => {
    let saved = { projects, workspaces: [], activeWorkspaceId: null };
    const readSettings = vi.fn(async () => saved);
    const persistSettings = vi.fn(async (changes) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      saved = { ...saved, ...changes };
      return changes;
    });
    let sequence = 0;
    const { service } = createService({
      readSettings,
      persistSettings,
      crypto: { randomUUID: () => `uuid-${++sequence}` },
    });

    await Promise.all([
      service.create(validPayload),
      service.create({
        name: 'Docs Platform',
        repos: [
          { projectId: 'api', alias: 'api', primary: true },
          { projectId: 'web', alias: 'docs' },
        ],
      }),
    ]);

    expect(saved.workspaces.map((workspace) => workspace.name)).toEqual(['Shop Platform', 'Docs Platform']);
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

  it('returns unknown refs instead of failing a saved create when the config cannot be re-read', async () => {
    let reads = 0;
    const { service, dependencies } = createService({
      readConfigLayers: vi.fn(() => {
        reads += 1;
        if (reads > 2) throw new Error('EACCES: permission denied');
        return { ...emptyLayers(), projectConfig: {}, mergedConfig: {} };
      }),
    });

    const result = await service.create(validPayload);

    expect(result.refWrites).toEqual([{ alias: 'web', status: 'written' }]);
    expect(result.refs).toEqual([
      { alias: 'web', path: '/repos/web', description: '', status: 'unknown', owned: true, current: null },
    ]);
    expect(result.refsError).toEqual({
      path: '/repos/api/.opencode/opencode.json',
      message: 'EACCES: permission denied',
    });
    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
  });
});

describe('workspace service: import', () => {
  const importService = (content, overrides = {}) => createService({
    homeDirectory: '/home/ada',
    fsPromises: {
      readFile: vi.fn(async () => content),
      realpath: vi.fn(async (value) => value),
    },
    ...overrides,
  });

  const workspaceFile = (folders) => JSON.stringify({ folders });

  it('drafts the name, resolves relative folders from the file and proposes the first as primary', async () => {
    const { service, dependencies } = importService(workspaceFile([
      { path: './api' },
      { path: 'web' },
      { path: '../shared' },
    ]));

    await expect(service.importDraft({ path: '/work/shop.code-workspace' })).resolves.toEqual({
      name: 'shop',
      folders: [
        { path: '/work/api', alias: 'api', primary: true, error: null },
        { path: '/work/web', alias: 'web', primary: false, error: null },
        { path: '/shared', alias: 'shared', primary: false, error: null },
      ],
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
    expect(dependencies.validateDirectoryPath).not.toHaveBeenCalled();
    expect(dependencies.readSettings).not.toHaveBeenCalled();
  });

  it('expands ~ and removes duplicate folders by normalized path and realpath', async () => {
    const { service } = importService('', {
      fsPromises: {
        readFile: vi.fn(async () => workspaceFile([
          { path: '~/src/web' },
          { path: '~/src/./web' },
          { path: '/link/api' },
          { path: '/real/api' },
        ])),
        realpath: vi.fn(async (value) => (value === '/link/api' ? '/real/api' : value)),
      },
    });

    const draft = await service.importDraft({ path: '/work/shop.code-workspace' });

    expect(draft.folders).toEqual([
      { path: '/home/ada/src/web', alias: 'web', primary: true, error: null },
      { path: '/link/api', alias: 'api', primary: false, error: null },
    ]);
  });

  it('suffixes repeated aliases with -2 and -3', async () => {
    const { service } = importService(workspaceFile([
      { path: '/repos/web' },
      { path: '/other/web' },
      { path: '/third/web' },
      { path: '/repos/Web App' },
    ]));

    const draft = await service.importDraft({ path: '/work/shop.code-workspace' });

    expect(draft.folders.map((folder) => folder.alias)).toEqual(['web', 'web-2', 'web-3', 'Web-App']);
  });

  it('reports a non-file URI per folder and keeps the local folders', async () => {
    const { service, dependencies } = importService(workspaceFile([
      { path: 'vscode-remote://ssh-remote+host/work/api' },
      { path: './api' },
    ]));

    await expect(service.importDraft({ path: '/work/shop.code-workspace' })).resolves.toEqual({
      name: 'shop',
      folders: [
        { path: 'vscode-remote://ssh-remote+host/work/api', alias: '', primary: false, error: 'unsupported' },
        { path: '/work/api', alias: 'api', primary: true, error: null },
      ],
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('rejects an unreadable file without exposing its content', async () => {
    const { service, dependencies } = importService('', {
      fsPromises: {
        readFile: vi.fn(async () => { throw new Error('permission denied with secret-content'); }),
        realpath: vi.fn(async (value) => value),
      },
    });

    await expect(service.importDraft({ path: '/work/shop.code-workspace' })).rejects.toMatchObject({
      status: 422,
      importError: { reason: 'unreadable' },
      message: 'Workspace file cannot be read',
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON without exposing its content', async () => {
    const { service } = importService('{\n  "folders": [{ "path": "/secret/token" }');

    const error = await service.importDraft({ path: '/work/shop.code-workspace' }).catch((reason) => reason);

    expect(error).toMatchObject({
      status: 422,
      importError: { reason: 'invalid-json' },
      message: 'Workspace file is not valid JSON',
    });
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain('folders');
  });

  it('requires a file path', async () => {
    const { service, dependencies } = importService(workspaceFile([]));

    await expect(service.importDraft({})).rejects.toMatchObject({
      status: 422,
      fields: { path: 'Workspace file path is required' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
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
  readConfigFile,
  writeConfig: vi.fn(writeConfig),
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

  it('answers unknown for every ref when the references section is not an object', async () => {
    const root = caseRoot('invalid-references');
    const primary = projectAt(root, 'primary', 'Primary');
    const web = projectAt(root, 'web', 'Web');
    const file = writeProjectConfig(primary, JSON.stringify({ references: [] }));
    const stored = workspace({
      primaryProjectId: 'primary',
      repos: [
        { projectId: 'primary', alias: 'primary', description: 'Primary', branch: '' },
        { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
      ],
    });
    const { service } = fixtureService({
      projects: [primary, web],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.list();

    expect(result.refs).toEqual([
      { alias: 'web', path: path.resolve(web.path), description: 'Web', status: 'unknown', owned: false, current: null },
    ]);
    expect(result.refsError).toEqual({ path: file, message: 'The "references" section must be an object' });
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

  it('does not claim an identical reference that was already there', async () => {
    const root = caseRoot('create-existing-exact');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const projectConfig = JSON.stringify({
      references: { web: { path: web.path, description: 'Web' } },
    });
    const file = writeProjectConfig(api, projectConfig);
    const { service, dependencies } = fixtureService({ projects: [api, web], workspaces: [], activeWorkspaceId: null });

    const result = await service.create({
      name: 'Shop Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { projectId: 'web', alias: 'web' },
      ],
    });

    expect(result.workspace.createdRefs).toEqual([]);
    expect(result.refWrites).toEqual([{ alias: 'web', status: 'unchanged' }]);
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
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(projectConfig);
  });
});

const createPayloadWith = (primary, secondaries) => ({
  name: 'Shop Platform',
  repos: [
    { projectId: primary.id, alias: primary.id, primary: true },
    ...secondaries.map((project) => ({ projectId: project.id, alias: project.id })),
  ],
});

const storedWorkspaceFor = (primary, secondaries, createdRefs) => workspace({
  primaryProjectId: primary.id,
  createdRefs,
  repos: [
    { projectId: primary.id, alias: primary.id, description: primary.label, branch: '' },
    ...secondaries.map((project) => ({
      projectId: project.id,
      alias: project.id,
      description: project.label,
      branch: '',
    })),
  ],
});

describe('workspace service: list reference states per workspace', () => {
  it('returns each workspace its own refs beside the active top-level ones', async () => {
    const root = caseRoot('list-per-workspace');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    writeProjectConfig(api, JSON.stringify({
      references: { web: { path: path.resolve(web.path), description: 'Web' } },
    }));
    writeProjectConfig(docs, JSON.stringify({
      references: { api: { path: '/somewhere/api', description: 'Old API' } },
    }));
    const active = storedWorkspaceFor(api, [web], ['web']);
    const other = workspace({
      id: 'ws_2',
      name: 'Docs Platform',
      primaryProjectId: 'docs',
      repos: [
        { projectId: 'docs', alias: 'docs', description: 'Docs', branch: '' },
        { projectId: 'api', alias: 'api', description: 'API', branch: '' },
      ],
      createdRefs: [],
    });
    const { service } = fixtureService({
      projects: [api, web, docs],
      workspaces: [active, other],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.list();

    expect(result.refs.map((reference) => [reference.alias, reference.status])).toEqual([['web', 'ok']]);
    expect(result.workspaces[0].refs).toEqual(result.refs);
    expect(result.workspaces[1].refs).toEqual([
      {
        alias: 'api',
        path: path.resolve(api.path),
        description: 'API',
        status: 'different',
        owned: false,
        current: { path: '/somewhere/api', description: 'Old API' },
      },
    ]);
    expect(result.workspaces[1].refsError).toBeNull();
  });

  it('reports a parse error on its own workspace without hiding another workspace', async () => {
    const root = caseRoot('list-per-workspace-error');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    writeProjectConfig(api, JSON.stringify({
      references: { web: { path: path.resolve(web.path), description: 'Web' } },
    }));
    const brokenFile = writeProjectConfig(docs, '{\n  "references": {');
    const active = storedWorkspaceFor(api, [web], ['web']);
    const broken = { ...storedWorkspaceFor(docs, [api], []), id: 'ws_2' };
    const { service } = fixtureService({
      projects: [api, web, docs],
      workspaces: [active, broken],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.list();

    expect(result.refs.map((reference) => [reference.alias, reference.status])).toEqual([['web', 'ok']]);
    expect(result.refsError).toBeNull();
    expect(result.workspaces[1].refs.map((reference) => [reference.alias, reference.status])).toEqual([['api', 'unknown']]);
    expect(result.workspaces[1].refsError).toMatchObject({ path: brokenFile });
  });
});

describe('workspace service: write references', () => {
  it('writes a missing secondary reference into the .opencode layer, preserving comments and foreign keys', async () => {
    const root = caseRoot('write-create');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const file = writeProjectConfig(api, `{
  // hand-written project config
  "$schema": "https://opencode.ai/config.json",
  "keybinds": { "leader": "ctrl+x" },
  "references": {
    "docs": { "path": "/somewhere/docs", "description": "Docs" }
  }
}`);
    const { service } = fixtureService({ projects: [api, web], workspaces: [], activeWorkspaceId: null });

    const result = await service.create(createPayloadWith(api, [web]));

    expect(result.workspace.createdRefs).toEqual(['web']);
    expect(result.refWrites).toEqual([{ alias: 'web', status: 'written' }]);
    expect(result.refs).toEqual([
      {
        alias: 'web',
        path: path.resolve(web.path),
        description: 'Web',
        status: 'ok',
        owned: true,
        current: { path: path.resolve(web.path), description: 'Web' },
      },
    ]);
    expect(result.configTarget).toEqual({
      path: path.join(api.path, '.opencode', 'opencode.json'),
      rootConfigPath: null,
    });

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('// hand-written project config');
    expect(raw).toContain('"$schema"');
    expect(raw).toContain('"keybinds"');
    expect(raw).toContain('/somewhere/docs');
    expect(readConfigFile(file).references).toEqual({
      docs: { path: '/somewhere/docs', description: 'Docs' },
      web: { path: path.resolve(web.path), description: 'Web' },
    });
  });

  it('always targets the .opencode layer and reports the root config it starts to override', async () => {
    const root = caseRoot('write-root-warning');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const rootConfig = path.join(api.path, 'opencode.json');
    const rootContent = JSON.stringify({ keybinds: { leader: 'ctrl+x' } }, null, 2);
    fs.writeFileSync(rootConfig, rootContent);
    const { service } = fixtureService({ projects: [api, web], workspaces: [], activeWorkspaceId: null });

    const result = await service.create(createPayloadWith(api, [web]));

    const target = path.join(api.path, '.opencode', 'opencode.json');
    expect(result.configTarget).toEqual({ path: target, rootConfigPath: rootConfig });
    expect(fs.readFileSync(rootConfig, 'utf8')).toBe(rootContent);
    expect(readConfigFile(target)).toEqual({
      references: { web: { path: path.resolve(web.path), description: 'Web' } },
    });
  });

  it('refuses an alias already defined in the project layer without writing anything', async () => {
    const root = caseRoot('write-conflict-project');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const file = writeProjectConfig(api, JSON.stringify({
      references: { web: { path: '/somewhere/else', description: 'Old web' } },
    }));
    const before = fs.readFileSync(file, 'utf8');
    const { service, dependencies } = fixtureService({ projects: [api, web], workspaces: [], activeWorkspaceId: null });

    await expect(service.create(createPayloadWith(api, [web]))).rejects.toMatchObject({
      status: 409,
      conflict: { alias: 'web', path: '/somewhere/else' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses an alias defined only in the user layer', async () => {
    const root = caseRoot('write-conflict-user');
    const api = projectAt(root, 'api', 'API');
    const outside = projectAt(root, 'outside', 'Outside');
    const { service, dependencies } = fixtureService({ projects: [api, outside], workspaces: [], activeWorkspaceId: null });

    await expect(service.create({
      name: 'Shop Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { projectId: 'outside', alias: 'user-only' },
      ],
    })).rejects.toMatchObject({
      status: 409,
      conflict: { alias: 'user-only', path: '/outside/user-repo' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('overwrites a conflicting alias only with an explicit confirmation', async () => {
    const root = caseRoot('write-confirmed');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const file = writeProjectConfig(api, JSON.stringify({
      references: { web: { path: '/somewhere/else', description: 'Old web' } },
    }));
    const { service } = fixtureService({ projects: [api, web], workspaces: [], activeWorkspaceId: null });

    const result = await service.create({
      ...createPayloadWith(api, [web]),
      confirmRefs: ['web'],
    });

    expect(result.workspace.createdRefs).toEqual(['web']);
    expect(result.refWrites).toEqual([{ alias: 'web', status: 'written' }]);
    expect(readConfigFile(file).references.web).toEqual({
      path: path.resolve(web.path),
      description: 'Web',
    });
  });

  it('blocks before creating anything when the config cannot be parsed', async () => {
    const root = caseRoot('write-unreadable');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const file = writeProjectConfig(api, '{\n  "references": {');
    const { service, dependencies } = fixtureService({ projects: [api, web], workspaces: [], activeWorkspaceId: null });

    const error = await service.create(createPayloadWith(api, [web])).catch((caught) => caught);

    expect(error).toMatchObject({ status: 422 });
    expect(error.configError).toMatchObject({ path: file });
    expect(error.configError.message).toMatch(/invalid JSONC/);
    expect(error.configError.message).not.toContain('references');
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "references": {');
  });

  it('rejects a secondary folder that is not readable', async () => {
    const root = caseRoot('write-bad-path');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const { service, dependencies } = fixtureService(
      { projects: [api, web], workspaces: [], activeWorkspaceId: null },
      {
        validateDirectoryPath: vi.fn(async (directory) => (
          directory === web.path ? { ok: false, error: 'Access to directory denied' } : { ok: true, directory }
        )),
      },
    );

    await expect(service.create(createPayloadWith(api, [web]))).rejects.toMatchObject({
      status: 422,
      fields: { 'refs.web.path': 'Access to directory denied' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
  });

  it('keeps the workspace when one alias fails and still writes the others', async () => {
    const root = caseRoot('write-partial');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    const target = path.join(api.path, '.opencode', 'opencode.json');
    const { service, dependencies } = fixtureService(
      { projects: [api, web, docs], workspaces: [], activeWorkspaceId: null },
      {
        writeConfig: vi.fn(async (config, file) => {
          if (Object.hasOwn(config.references, 'web')) {
            const error = new Error('permission denied');
            error.code = 'EACCES';
            throw error;
          }
          writeConfig(config, file);
        }),
      },
    );

    const result = await service.create(createPayloadWith(api, [web, docs]));

    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
    expect(result.workspace.createdRefs).toEqual(['web', 'docs']);
    expect(result.refWrites).toEqual([
      { alias: 'web', status: 'failed', message: 'Failed to write the reference' },
      { alias: 'docs', status: 'written' },
    ]);
    expect(result.refs.map((reference) => [reference.alias, reference.status, reference.owned])).toEqual([
      ['web', 'missing', true],
      ['docs', 'ok', true],
    ]);
    expect(readConfigFile(target).references).toEqual({
      docs: { path: path.resolve(docs.path), description: 'Docs' },
    });
  });
});

describe('workspace service: retry references', () => {
  it('retries only pending aliases and never rewrites an ok reference', async () => {
    const root = caseRoot('retry-pending');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    const file = writeProjectConfig(api, JSON.stringify({
      references: { web: { path: path.resolve(web.path), description: 'Web' } },
    }));
    const stored = storedWorkspaceFor(api, [web, docs], ['web', 'docs']);
    const { service, dependencies } = fixtureService({
      projects: [api, web, docs],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.retryRefs('ws_1');

    expect(result.refWrites).toEqual([{ alias: 'docs', status: 'written' }]);
    expect(result.refs.map((reference) => [reference.alias, reference.status, reference.owned])).toEqual([
      ['web', 'ok', true],
      ['docs', 'ok', true],
    ]);
    expect(result.refsError).toBeNull();
    expect(dependencies.writeConfig).toHaveBeenCalledOnce();
    expect(readConfigFile(file).references).toEqual({
      web: { path: path.resolve(web.path), description: 'Web' },
      docs: { path: path.resolve(docs.path), description: 'Docs' },
    });
  });

  it('skips an explicit ok alias', async () => {
    const root = caseRoot('retry-ok');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    writeProjectConfig(api, JSON.stringify({
      references: { web: { path: path.resolve(web.path), description: 'Web' } },
    }));
    const stored = storedWorkspaceFor(api, [web], ['web']);
    const { service, dependencies } = fixtureService({
      projects: [api, web],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.retryRefs('ws_1', { aliases: ['web'] });

    expect(result.refWrites).toEqual([{ alias: 'web', status: 'unchanged' }]);
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
  });

  it('requires confirmation before retrying a user-edited alias', async () => {
    const root = caseRoot('retry-different');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    writeProjectConfig(api, JSON.stringify({
      references: { web: { path: '/user/edited', description: 'Edited' } },
    }));
    const stored = storedWorkspaceFor(api, [web], ['web']);
    const { service, dependencies } = fixtureService({
      projects: [api, web],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    await expect(service.retryRefs('ws_1', { aliases: ['web'] })).rejects.toMatchObject({
      status: 409,
      conflict: { alias: 'web', path: '/user/edited' },
    });
    expect(dependencies.writeConfig).not.toHaveBeenCalled();

    const result = await service.retryRefs('ws_1', { aliases: ['web'], confirmRefs: ['web'] });
    expect(result.refWrites).toEqual([{ alias: 'web', status: 'written' }]);
    expect(result.refs[0].status).toBe('ok');
  });

  it('refuses an alias outside the workspace or outside its ownership', async () => {
    const root = caseRoot('retry-invalid');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    writeProjectConfig(api, '{}');
    const stored = storedWorkspaceFor(api, [web], []);
    const { service } = fixtureService({
      projects: [api, web],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    await expect(service.retryRefs('ws_1', { aliases: ['nope'] })).rejects.toMatchObject({
      status: 422,
      fields: { aliases: 'Unknown reference alias "nope"' },
    });
    await expect(service.retryRefs('ws_1', { aliases: ['web'] })).rejects.toMatchObject({
      status: 422,
      fields: { aliases: 'The alias "web" is not owned by this workspace' },
    });
  });

  it('serializes concurrent saves without losing a reference', async () => {
    const root = caseRoot('retry-concurrent');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    const file = writeProjectConfig(api, JSON.stringify({
      references: { keep: { path: '/keep/this', description: 'Keep' } },
    }));
    const stored = storedWorkspaceFor(api, [web, docs], ['web', 'docs']);
    const slowWrite = vi.fn(async (config, filePath) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeConfig(config, filePath);
    });
    const { service } = fixtureService(
      { projects: [api, web, docs], workspaces: [stored], activeWorkspaceId: 'ws_1' },
      { writeConfig: slowWrite },
    );

    await Promise.all([
      service.retryRefs('ws_1', { aliases: ['web'] }),
      service.retryRefs('ws_1', { aliases: ['docs'] }),
    ]);

    expect(readConfigFile(file).references).toEqual({
      keep: { path: '/keep/this', description: 'Keep' },
      web: { path: path.resolve(web.path), description: 'Web' },
      docs: { path: path.resolve(docs.path), description: 'Docs' },
    });
    expect(slowWrite).toHaveBeenCalledTimes(2);
  });
});

describe('workspace service: remove created references', () => {
  const removalFixture = (name) => {
    const root = caseRoot(name);
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    const file = writeProjectConfig(api, JSON.stringify({
      references: {
        web: { path: path.resolve(web.path), description: 'Web' },
        docs: { path: '/user/docs', description: 'User docs' },
      },
    }));
    const projects = [api, web, docs];
    const stored = storedWorkspaceFor(api, [web, docs], ['web']);
    return { api, web, docs, projects, file, stored };
  };

  it('removes only an owned reference whose current value matches, leaving user references alone', async () => {
    const { file, projects, stored } = removalFixture('remove-owned');
    const { service } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    const result = await service.removeCreatedRefs({ workspace: stored });

    expect(result.removed).toEqual(['web']);
    expect(result.refWrites).toEqual([{ alias: 'web', status: 'removed' }]);
    expect(readConfigFile(file).references).toEqual({
      docs: { path: '/user/docs', description: 'User docs' },
    });
  });

  it('never removes a reference this workspace does not own', async () => {
    const { file, projects, stored } = removalFixture('remove-user');
    const { service, dependencies } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    const result = await service.removeCreatedRefs({ workspace: stored, aliases: ['docs'] });

    expect(result.removed).toEqual([]);
    expect(result.refWrites).toEqual([{ alias: 'docs', status: 'skipped' }]);
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
    expect(readConfigFile(file).references.docs).toEqual({ path: '/user/docs', description: 'User docs' });
  });

  it('requires confirmation before removing an owned reference the user edited', async () => {
    const { file, projects, stored } = removalFixture('remove-edited');
    const edited = {
      references: {
        web: { path: '/user/edited', description: 'Edited web' },
        docs: { path: '/user/docs', description: 'User docs' },
      },
    };
    fs.writeFileSync(file, JSON.stringify(edited));
    const { service, dependencies } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    await expect(service.removeCreatedRefs({ workspace: stored, aliases: ['web'] })).rejects.toMatchObject({
      status: 409,
      conflict: { alias: 'web', path: '/user/edited' },
    });
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
    expect(readConfigFile(file).references.web).toEqual(edited.references.web);

    const result = await service.removeCreatedRefs({
      workspace: stored,
      aliases: ['web'],
      confirmRefs: ['web'],
    });
    expect(result.removed).toEqual(['web']);
    expect(readConfigFile(file).references).toEqual({
      docs: { path: '/user/docs', description: 'User docs' },
    });
  });

  it('does nothing when the owned entry is already absent', async () => {
    const { file, projects, stored } = removalFixture('remove-absent');
    fs.writeFileSync(file, JSON.stringify({
      references: { docs: { path: '/user/docs', description: 'User docs' } },
    }));
    const { service, dependencies } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    const result = await service.removeCreatedRefs({ workspace: stored, aliases: ['web'] });

    expect(result.removed).toEqual([]);
    expect(result.refWrites).toEqual([{ alias: 'web', status: 'absent' }]);
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
  });

  it('answers 409 and leaves the file untouched when the removal write fails', async () => {
    const { api, file, projects, stored } = removalFixture('remove-write-fails');
    const before = fs.readFileSync(file, 'utf8');
    const { service } = fixtureService(
      { projects, workspaces: [stored], activeWorkspaceId: 'ws_1' },
      { writeConfig: vi.fn(async () => { throw new Error('permission denied'); }) },
    );

    await expect(service.removeCreatedRefs({
      workspace: stored,
      aliases: ['web'],
      confirmRefs: ['web'],
    })).rejects.toMatchObject({
      status: 409,
      conflict: { aliases: ['web'], path: path.join(api.path, '.opencode', 'opencode.json') },
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('workspace service: delete', () => {
  const deleteFixture = (name, createdRefs = ['web']) => {
    const root = caseRoot(name);
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    const file = writeProjectConfig(api, JSON.stringify({
      references: {
        web: { path: path.resolve(web.path), description: 'Web' },
        docs: { path: '/user/docs', description: 'User docs' },
      },
    }));
    const stored = storedWorkspaceFor(api, [web, docs], createdRefs);
    return { api, web, docs, file, projects: [api, web, docs], stored };
  };

  it('deletes the workspace and clears the pointer without touching config or projects', async () => {
    const { file, projects, stored } = deleteFixture('delete-last');
    const before = fs.readFileSync(file, 'utf8');
    const { service, dependencies } = fixtureService({
      projects,
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.remove('ws_1', {});

    expect(result).toEqual({ removed: true, refs: [], failedAlias: null, configError: null });
    expect(dependencies.persistSettings).toHaveBeenCalledWith({
      workspaces: [],
      activeWorkspaceId: null,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps another workspace active and never removes a user reference', async () => {
    const { file, projects, stored } = deleteFixture('delete-other-active');
    const other = workspace({ id: 'ws_2', name: 'Other' });
    const { service, dependencies } = fixtureService({
      projects,
      workspaces: [stored, other],
      activeWorkspaceId: 'ws_2',
    });

    await service.remove('ws_1', { removeCreatedRefs: true });

    expect(dependencies.persistSettings).toHaveBeenCalledWith({
      workspaces: [other],
    });
    expect(readConfigFile(file).references).toEqual({
      docs: { path: '/user/docs', description: 'User docs' },
    });
  });

  it('keeps the workspace when an owned removal fails and names the alias', async () => {
    const { file, projects, stored } = deleteFixture('delete-remove-fails');
    const before = fs.readFileSync(file, 'utf8');
    const { service, dependencies } = fixtureService(
      { projects, workspaces: [stored], activeWorkspaceId: 'ws_1' },
      { writeConfig: vi.fn(async () => { throw new Error('permission denied'); }) },
    );

    const result = await service.remove('ws_1', { removeCreatedRefs: true });

    expect(result.removed).toBe(false);
    expect(result.failedAlias).toBe('web');
    expect(result.refs.map((reference) => reference.alias)).toEqual(['web', 'docs']);
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps the workspace when an owned reference was hand-edited', async () => {
    const { file, projects, stored } = deleteFixture('delete-edited-owned', ['web']);
    const edited = { references: { web: { path: '/user/edited', description: 'Edited web' } } };
    fs.writeFileSync(file, JSON.stringify(edited));
    const { service, dependencies } = fixtureService({
      projects,
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.remove('ws_1', { removeCreatedRefs: true });

    expect(result).toMatchObject({ removed: false, failedAlias: 'web' });
    expect(result.refs).toContainEqual(expect.objectContaining({ alias: 'web', status: 'different' }));
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(readConfigFile(file).references.web).toEqual(edited.references.web);
  });

  it('leaves the config untouched when one owned alias cannot be verified', async () => {
    const root = caseRoot('delete-unverified');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const file = writeProjectConfig(api, JSON.stringify({
      references: {
        web: { path: path.resolve(web.path), description: 'Web' },
        gone: { path: '/gone/repo', description: 'Gone' },
      },
    }));
    const before = fs.readFileSync(file, 'utf8');
    const stored = workspace({
      primaryProjectId: 'api',
      repos: [
        { projectId: 'api', alias: 'api', description: 'API', branch: '' },
        { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
        { projectId: 'gone', alias: 'gone', description: 'Gone', branch: '' },
      ],
      createdRefs: ['web', 'gone'],
    });
    const { service, dependencies } = fixtureService({
      projects: [api, web],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.remove('ws_1', { removeCreatedRefs: true });

    expect(result).toMatchObject({ removed: false, failedAlias: 'gone', configError: null });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('removes a hand-edited owned reference when the request confirms it', async () => {
    const { file, projects, stored } = deleteFixture('delete-edited-confirmed', ['web']);
    const edited = { references: { web: { path: '/user/edited', description: 'Edited web' } } };
    fs.writeFileSync(file, JSON.stringify(edited));
    const { service, dependencies } = fixtureService({
      projects,
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.remove('ws_1', { removeCreatedRefs: true, confirmRefs: ['web'] });

    expect(result).toEqual({ removed: true, refs: [], failedAlias: null, configError: null });
    expect(readConfigFile(file).references).toEqual({});
    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
  });

  it('puts the removed references back when the settings write fails', async () => {
    const { file, projects, stored } = deleteFixture('delete-settings-fails');
    const { service } = fixtureService(
      { projects, workspaces: [stored], activeWorkspaceId: 'ws_1' },
      { persistSettings: vi.fn(async () => { throw new Error('Settings write failed'); }) },
    );

    await expect(service.remove('ws_1', { removeCreatedRefs: true })).rejects.toThrow('Settings write failed');

    expect(readConfigFile(file).references).toEqual({
      web: { path: path.resolve(projects[1].path), description: 'Web' },
      docs: { path: '/user/docs', description: 'User docs' },
    });
  });

  it('refuses an unknown workspace without writing', async () => {
    const { service, dependencies } = fixtureService({ projects, workspaces: [], activeWorkspaceId: null });

    await expect(service.remove('ws_missing', {})).rejects.toMatchObject({ status: 404 });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });
});

const updateFixture = (name) => {
  const root = caseRoot(name);
  const api = projectAt(root, 'api', 'API');
  const web = projectAt(root, 'web', 'Web');
  const docs = projectAt(root, 'docs', 'Docs');
  const file = writeProjectConfig(api, JSON.stringify({
    references: { web: { path: path.resolve(web.path), description: 'Web' } },
  }));
  const stored = storedWorkspaceFor(api, [web], ['web']);
  return { api, web, docs, file, projects: [api, web, docs], stored };
};

const updatePayloadWith = (primary, secondaries) => ({
  name: 'Shop Platform',
  repos: [
    { projectId: primary.id, alias: primary.id, primary: true },
    ...secondaries.map((project) => ({ projectId: project.id, alias: project.id })),
  ],
});

describe('workspace service: update', () => {
  it('switches the primary: the old one becomes a secondary reference, the new one stops being one', async () => {
    const { api, web, file, projects, stored } = updateFixture('update-primary');
    const { service, dependencies } = fixtureService({
      projects,
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.update('ws_1', updatePayloadWith(web, [api]));

    expect(result.workspace.primaryProjectId).toBe('web');
    expect(result.workspace.repos.map((repo) => repo.projectId)).toEqual(['web', 'api']);
    expect(result.workspace.createdRefs).toEqual(['api']);
    expect(readConfigFile(file).references).toEqual({});
    expect(readConfigFile(path.join(web.path, '.opencode', 'opencode.json')).references).toEqual({
      api: { path: path.resolve(api.path), description: 'API' },
    });
    expect(result.refWrites).toEqual([{ alias: 'api', status: 'written' }]);
    expect(result.refs.map((reference) => [reference.alias, reference.status])).toEqual([['api', 'ok']]);
    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
    expect(dependencies.persistSettings.mock.calls[0][0].workspaces[0].primaryProjectId).toBe('web');
  });

  it('removes every owned entry from the old primary when the primary changes', async () => {
    const root = caseRoot('update-primary-swap');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    const oldFile = writeProjectConfig(api, JSON.stringify({
      references: {
        web: { path: path.resolve(web.path), description: 'Web' },
        docs: { path: path.resolve(docs.path), description: 'Docs' },
      },
    }));
    const stored = storedWorkspaceFor(api, [web, docs], ['web', 'docs']);
    const { service } = fixtureService({
      projects: [api, web, docs],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.update('ws_1', updatePayloadWith(web, [api, docs]));

    expect(result.workspace.primaryProjectId).toBe('web');
    expect(result.workspace.createdRefs).toEqual(['docs', 'api']);
    expect(readConfigFile(oldFile).references).toEqual({});
    expect(readConfigFile(path.join(web.path, '.opencode', 'opencode.json')).references).toEqual({
      api: { path: path.resolve(api.path), description: 'API' },
      docs: { path: path.resolve(docs.path), description: 'Docs' },
    });
    expect(result.refWrites).toEqual([
      { alias: 'api', status: 'written' },
      { alias: 'docs', status: 'written' },
    ]);
  });

  it('aborts the primary swap when an owned entry cannot be removed, leaving both untouched', async () => {
    const root = caseRoot('update-primary-swap-fails');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const docs = projectAt(root, 'docs', 'Docs');
    const oldFile = writeProjectConfig(api, JSON.stringify({
      references: {
        web: { path: path.resolve(web.path), description: 'Web' },
        docs: { path: path.resolve(docs.path), description: 'Docs' },
      },
    }));
    const before = fs.readFileSync(oldFile, 'utf8');
    const stored = storedWorkspaceFor(api, [web, docs], ['web', 'docs']);
    const { service, dependencies } = fixtureService(
      { projects: [api, web, docs], workspaces: [stored], activeWorkspaceId: 'ws_1' },
      { writeConfig: vi.fn(async () => { throw new Error('permission denied'); }) },
    );

    await expect(service.update('ws_1', updatePayloadWith(web, [api, docs]))).rejects.toMatchObject({
      status: 409,
      conflict: { aliases: ['web', 'docs'], path: oldFile },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(fs.readFileSync(oldFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(web.path, '.opencode', 'opencode.json'))).toBe(false);
  });

  it('leaves an unchanged reference defined in another layer alone instead of refusing the edit', async () => {
    const root = caseRoot('update-layer-unchanged');
    const api = projectAt(root, 'api', 'API');
    const outside = projectAt(root, 'outside', 'Outside');
    const both = projectAt(root, 'both', 'Both');
    writeProjectConfig(api, JSON.stringify({
      references: { 'both-layers': { path: path.resolve(both.path), description: 'Both' } },
    }));
    const stored = workspace({
      primaryProjectId: 'api',
      repos: [
        { projectId: 'api', alias: 'api', description: 'API', branch: '' },
        { projectId: 'outside', alias: 'user-only', description: 'Outside', branch: '' },
        { projectId: 'both', alias: 'both-layers', description: 'Both', branch: '' },
      ],
      createdRefs: [],
    });
    const { service, dependencies } = fixtureService({
      projects: [api, outside, both],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.update('ws_1', {
      name: 'Renamed Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { projectId: 'outside', alias: 'user-only' },
        { projectId: 'both', alias: 'both-layers' },
      ],
    });

    expect(result.workspace.name).toBe('Renamed Platform');
    expect(result.refWrites).toEqual([
      { alias: 'user-only', status: 'unchanged' },
      { alias: 'both-layers', status: 'unchanged' },
    ]);
    expect(result.refs.map((reference) => [reference.alias, reference.status])).toEqual([
      ['user-only', 'outside'],
      ['both-layers', 'overridden'],
    ]);
    expect(dependencies.writeConfig).not.toHaveBeenCalled();
    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
  });

  it('still refuses a changed reference defined in another layer', async () => {
    const root = caseRoot('update-layer-changed');
    const api = projectAt(root, 'api', 'API');
    const outside = projectAt(root, 'outside', 'Outside');
    writeProjectConfig(api, '{}');
    const stored = workspace({
      primaryProjectId: 'api',
      repos: [
        { projectId: 'api', alias: 'api', description: 'API', branch: '' },
        { projectId: 'outside', alias: 'user-only', description: 'Outside', branch: '' },
      ],
      createdRefs: [],
    });
    const { service, dependencies } = fixtureService({
      projects: [api, outside],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    await expect(service.update('ws_1', {
      name: 'Shop Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { projectId: 'outside', alias: 'both-layers' },
      ],
    })).rejects.toMatchObject({
      status: 409,
      conflict: { alias: 'both-layers', path: '/outside/user-repo' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('renames an owned alias: removes the old reference and writes the new one', async () => {
    const { api, web, file, projects, stored } = updateFixture('update-alias');
    const { service } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    const result = await service.update('ws_1', {
      name: 'Shop Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { projectId: 'web', alias: 'webapp' },
      ],
    });

    expect(result.workspace.createdRefs).toEqual(['webapp']);
    expect(readConfigFile(file).references).toEqual({
      webapp: { path: path.resolve(web.path), description: 'Web' },
    });
    expect(result.refs.map((reference) => [reference.alias, reference.status, reference.owned]))
      .toEqual([['webapp', 'ok', true]]);
  });

  it('removes the owned reference of a repo that leaves the workspace', async () => {
    const { file, projects, stored } = updateFixture('update-remove');
    const { service } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    const result = await service.update('ws_1', {
      name: 'Shop Platform',
      repos: [{ projectId: 'api', alias: 'api', primary: true }],
    });

    expect(result.workspace.createdRefs).toEqual([]);
    expect(result.refs).toEqual([]);
    expect(readConfigFile(file).references).toEqual({});
  });

  it('keeps the owned reference when the user declines its removal', async () => {
    const { file, projects, stored } = updateFixture('update-keep');
    const { service } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    const result = await service.update('ws_1', {
      name: 'Shop Platform',
      repos: [{ projectId: 'api', alias: 'api', primary: true }],
      keepRefs: ['web'],
    });

    expect(result.workspace.createdRefs).toEqual([]);
    expect(readConfigFile(file).references.web).toEqual({
      path: path.resolve(projects[1].path),
      description: 'Web',
    });
  });

  it('changes an owned reference to a new value without confirmation while the entry is still the one it wrote', async () => {
    const { docs, file, projects, stored } = updateFixture('update-owned-change');
    const { service } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    const result = await service.update('ws_1', {
      name: 'Shop Platform',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { projectId: 'docs', alias: 'web' },
      ],
    });

    expect(result.workspace.createdRefs).toEqual(['web']);
    expect(result.refWrites).toEqual([{ alias: 'web', status: 'written' }]);
    expect(readConfigFile(file).references.web).toEqual({
      path: path.resolve(docs.path),
      description: 'Docs',
    });
  });

  it('refuses to remove a user-edited reference without confirmation and changes nothing', async () => {
    const { api, file, projects, stored } = updateFixture('update-remove-different');
    fs.writeFileSync(file, JSON.stringify({
      references: { web: { path: '/user/edited', description: 'Edited' } },
    }));
    const before = fs.readFileSync(file, 'utf8');
    const { service, dependencies } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    await expect(service.update('ws_1', {
      name: 'Shop Platform',
      repos: [{ projectId: 'api', alias: 'api', primary: true }],
    })).rejects.toMatchObject({
      status: 409,
      conflict: { alias: 'web', path: '/user/edited' },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    const result = await service.update('ws_1', {
      name: 'Shop Platform',
      repos: [{ projectId: 'api', alias: 'api', primary: true }],
      confirmRefs: ['web'],
    });
    expect(result.workspace.createdRefs).toEqual([]);
    expect(readConfigFile(file).references).toEqual({});
  });

  it('refuses to overwrite a user-edited reference without confirmation, then writes it when confirmed', async () => {
    const { file, projects, stored } = updateFixture('update-overwrite-different');
    fs.writeFileSync(file, JSON.stringify({
      references: { web: { path: '/user/edited', description: 'Edited' } },
    }));
    const { service } = fixtureService({ projects, workspaces: [stored], activeWorkspaceId: 'ws_1' });

    await expect(service.update('ws_1', updatePayloadWith(projects[0], [projects[1]]))).rejects.toMatchObject({
      status: 409,
      conflict: { alias: 'web', path: '/user/edited' },
    });

    const result = await service.update('ws_1', {
      ...updatePayloadWith(projects[0], [projects[1]]),
      confirmRefs: ['web'],
    });
    expect(result.refWrites).toEqual([{ alias: 'web', status: 'written' }]);
    expect(readConfigFile(file).references.web).toEqual({
      path: path.resolve(projects[1].path),
      description: 'Web',
    });
  });

  it('aborts the whole edit with 409 when the owned removal write fails, leaving the workspace as it was', async () => {
    const { file, projects, stored } = updateFixture('update-remove-fails');
    const before = fs.readFileSync(file, 'utf8');
    const { service, dependencies } = fixtureService(
      { projects, workspaces: [stored], activeWorkspaceId: 'ws_1' },
      { writeConfig: vi.fn(async () => { throw new Error('permission denied'); }) },
    );

    await expect(service.update('ws_1', {
      name: 'Shop Platform',
      repos: [{ projectId: 'api', alias: 'api', primary: true }],
    })).rejects.toMatchObject({
      status: 409,
      conflict: { aliases: ['web'] },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('aborts the whole edit with 409 when an owned entry can no longer be located', async () => {
    const root = caseRoot('update-remove-unverified');
    const api = projectAt(root, 'api', 'API');
    const web = projectAt(root, 'web', 'Web');
    const file = writeProjectConfig(api, JSON.stringify({
      references: {
        web: { path: path.resolve(web.path), description: 'Web' },
        gone: { path: '/gone/repo', description: 'Gone' },
      },
    }));
    const before = fs.readFileSync(file, 'utf8');
    const stored = workspace({
      primaryProjectId: 'api',
      repos: [
        { projectId: 'api', alias: 'api', description: 'API', branch: '' },
        { projectId: 'web', alias: 'web', description: 'Web', branch: '' },
        { projectId: 'gone', alias: 'gone', description: 'Gone', branch: '' },
      ],
      createdRefs: ['web', 'gone'],
    });
    const { service, dependencies } = fixtureService({
      projects: [api, web],
      workspaces: [stored],
      activeWorkspaceId: 'ws_1',
    });

    await expect(service.update('ws_1', {
      name: 'Shop Platform',
      repos: [{ projectId: 'api', alias: 'api', primary: true }],
    })).rejects.toMatchObject({
      status: 409,
      conflict: { alias: 'gone', path: null },
    });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps the saved workspace and reports a pending alias when a new reference write fails', async () => {
    const { api, docs, projects, stored, web } = updateFixture('update-write-fails');
    const target = path.join(api.path, '.opencode', 'opencode.json');
    const { service, dependencies } = fixtureService(
      { projects, workspaces: [stored], activeWorkspaceId: 'ws_1' },
      {
        writeConfig: vi.fn(async (config, file) => {
          if (Object.hasOwn(config.references, 'docs')) throw new Error('permission denied');
          writeConfig(config, file);
        }),
      },
    );

    const result = await service.update('ws_1', updatePayloadWith(api, [web, docs]));

    expect(dependencies.persistSettings).toHaveBeenCalledOnce();
    expect(result.workspace.createdRefs).toEqual(['web', 'docs']);
    expect(result.refWrites).toEqual([
      { alias: 'web', status: 'unchanged' },
      { alias: 'docs', status: 'failed', message: 'Failed to write the reference' },
    ]);
    expect(result.refs.map((reference) => [reference.alias, reference.status, reference.owned])).toEqual([
      ['web', 'ok', true],
      ['docs', 'missing', true],
    ]);
    expect(readConfigFile(target).references).toEqual({
      web: { path: path.resolve(web.path), description: 'Web' },
    });
  });

  it('puts the owned removals back when the settings write fails', async () => {
    const { file, projects, stored } = updateFixture('update-settings-fails');
    const { service } = fixtureService(
      { projects, workspaces: [stored], activeWorkspaceId: 'ws_1' },
      { persistSettings: vi.fn(async () => { throw new Error('Settings write failed'); }) },
    );

    await expect(service.update('ws_1', {
      name: 'Shop Platform',
      repos: [{ projectId: 'api', alias: 'api', primary: true }],
    })).rejects.toThrow('Settings write failed');
    expect(readConfigFile(file).references.web).toEqual({
      path: path.resolve(projects[1].path),
      description: 'Web',
    });
  });

  it('reports a failed restore when the settings write and the rollback both fail', async () => {
    const { api, projects, stored } = updateFixture('update-restore-fails');
    const target = path.join(api.path, '.opencode', 'opencode.json');
    let writes = 0;
    const { service } = fixtureService(
      { projects, workspaces: [stored], activeWorkspaceId: 'ws_1' },
      {
        persistSettings: vi.fn(async () => { throw new Error('Settings write failed'); }),
        writeConfig: vi.fn(async (config, file) => {
          writes += 1;
          if (writes > 1) throw new Error('permission denied with secret-content');
          writeConfig(config, file);
        }),
      },
    );

    const error = await service.update('ws_1', {
      name: 'Shop Platform',
      repos: [{ projectId: 'api', alias: 'api', primary: true }],
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      status: 500,
      configError: {
        path: target,
        message: 'The settings write failed and the removed references could not be restored',
      },
    });
    expect(error.message).not.toContain('secret-content');
  });

  it('keeps a repo whose project left the catalog when the form sends it back', async () => {
    const { file, projects, stored, web } = updateFixture('update-missing-repo');
    const withGone = {
      ...stored,
      repos: [
        ...stored.repos,
        { projectId: 'gone', alias: 'gone', description: 'Gone', branch: '' },
      ],
    };
    const { service } = fixtureService({
      projects,
      workspaces: [withGone],
      activeWorkspaceId: 'ws_1',
    });

    const result = await service.update('ws_1', {
      name: 'Shop Platform Renamed',
      repos: [
        { projectId: 'api', alias: 'api', primary: true },
        { projectId: 'web', alias: 'web' },
        { projectId: 'gone', alias: 'gone' },
      ],
    });

    expect(result.workspace.name).toBe('Shop Platform Renamed');
    expect(result.workspace.repos.map((repo) => repo.projectId)).toEqual(['api', 'web', 'gone']);
    expect(result.refs.map((reference) => [reference.alias, reference.status])).toEqual([
      ['web', 'ok'],
      ['gone', 'missing'],
    ]);
    expect(readConfigFile(file).references).toEqual({
      web: { path: path.resolve(web.path), description: 'Web' },
    });
  });
});
