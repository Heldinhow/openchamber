/**
 * Multi-repo workspaces: the one owner that reads and writes `workspaces` and
 * `activeWorkspaceId` in the persisted settings document. It resolves projects
 * against the current catalog and registers a folder that is not a project yet
 * through the existing add-project path, never by writing settings itself.
 *
 * It also owns the primary's OpenCode `references`: each expected alias is
 * classified against the project config (ownership) and the merged layers
 * (conflict), and written only through the shared config writer.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';
import { resolveProjectForDirectory } from '../projects/add-project.js';

// Same OpenCode reference-key rule as the settings parser: no whitespace,
// `/`, backtick or comma, and no leading `@`.
const WORKSPACE_ALIAS_PATTERN = /^[^\s/`,@][^\s/`,]*$/;
const WORKSPACE_ID_PREFIX = 'ws_';
// A path in a `.code-workspace` is either a local path or a URI. Only `file:`
// URIs name a local folder; anything else (`vscode-remote:`, `ssh:`) is skipped.
const FOLDER_URI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export class WorkspaceRequestError extends Error {
  constructor(status, message, { fields = null, configError = null, conflict = null, importError = null } = {}) {
    super(message);
    this.name = 'WorkspaceRequestError';
    this.status = status;
    this.fields = fields;
    this.configError = configError;
    this.conflict = conflict;
    this.importError = importError;
  }
}

const expandHome = (value, homeDirectory) => {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDirectory, value.slice(2));
  return value;
};

/** The dialog's alias rule, so an imported alias is one the form accepts. */
const aliasBaseForFolder = (folderPath) => path.basename(folderPath)
  .replace(/[^A-Za-z0-9._-]+/g, '-')
  .replace(/^[^A-Za-z0-9]+/, '')
  .replace(/[-.]+$/, '') || 'repo';

const nextFolderAlias = (base, takenAliases) => {
  let alias = base;
  let suffix = 2;
  while (takenAliases.has(alias)) {
    alias = `${base}-${suffix}`;
    suffix += 1;
  }
  return alias;
};

const invalid = (fields) => new WorkspaceRequestError(422, 'Workspace is invalid', { fields });

const createRepoSchema = z.object({
  alias: z.string({ error: 'Alias is required' }).trim().min(1, 'Alias is required').regex(
    WORKSPACE_ALIAS_PATTERN,
    'Alias must not contain spaces, "/", "`" or ",", or start with "@"',
  ),
  projectId: z.string({ error: 'Project id must be text' }).trim().min(1, 'Project id must not be empty').optional(),
  path: z.string({ error: 'Folder path must be text' }).trim().min(1, 'Folder path must not be empty').optional(),
  branch: z.string({ error: 'Branch must be a string' }).optional(),
  primary: z.boolean({ error: 'Primary must be true or false' }).optional(),
});

const confirmRefsSchema = z.array(
  z.string({ error: 'Confirmed aliases must be text' }).trim().min(1, 'Confirmed aliases must not be empty'),
).optional();

const workspacePayloadSchema = z.object({
  name: z.string({ error: 'Name is required' }).trim().min(1, 'Name is required'),
  repos: z.array(createRepoSchema, { error: 'At least one repository is required' }).min(1, 'At least one repository is required'),
  // Aliases the user explicitly allowed to overwrite an existing entry.
  confirmRefs: confirmRefsSchema,
});

const validateWorkspacePayload = (payload, ctx) => {
  if (payload.repos.length === 0) return;
  const aliases = new Set();
  let primaries = 0;
  payload.repos.forEach((repo, index) => {
    if (aliases.has(repo.alias)) {
      ctx.addIssue({ code: 'custom', path: ['repos', index, 'alias'], message: 'Alias must be unique within the workspace' });
    }
    aliases.add(repo.alias);

    const hasProjectId = repo.projectId !== undefined;
    const hasPath = repo.path !== undefined;
    if (hasProjectId === hasPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['repos', index, 'path'],
        message: hasProjectId ? 'Provide either a project id or a folder path, not both' : 'A registered project or a folder path is required',
      });
    }

    if (repo.primary === true) primaries += 1;
  });
  if (primaries !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['primary'],
      message: primaries === 0 ? 'Select the primary repository' : 'Exactly one repository must be primary',
    });
  }
};

const createWorkspaceSchema = workspacePayloadSchema.superRefine(validateWorkspacePayload);

// Edit adds the aliases whose owned reference this workspace keeps when their
// repo leaves; everything else about the payload is the create shape.
const updateWorkspaceSchema = workspacePayloadSchema.extend({
  keepRefs: confirmRefsSchema,
}).superRefine(validateWorkspacePayload);

const activatePayloadSchema = z.object({
  id: z.union([z.string({ error: 'Workspace id is required' }).trim().min(1, 'Workspace id is required'), z.null()], {
    error: 'Workspace id is required',
  }),
});

const activeWorkspaceIdSchema = z.union([z.null(), z.string().trim().min(1)]);

const removeWorkspaceSchema = z.object({
  removeCreatedRefs: z.boolean({ error: 'Remove references must be true or false' }).optional(),
  // Aliases the user explicitly allowed removing after editing the entry.
  confirmRefs: confirmRefsSchema,
});

const retryRefsSchema = z.object({
  aliases: z.array(z.string({ error: 'Aliases must be text' }).trim().min(1, 'Aliases must not be empty')).optional(),
  confirmRefs: confirmRefsSchema,
});

const importPayloadSchema = z.object({
  path: z.string({ error: 'Workspace file path is required' }).trim().min(1, 'Workspace file path is required'),
});

const configTargetPayloadSchema = z.object({
  path: z.string({ error: 'Folder path is required' }).trim().min(1, 'Folder path is required'),
});

// The file is untyped JSONC: a folder without a string path is ignored, and a
// document without a `folders` array is not a workspace file.
const importFolderSchema = z.object({ path: z.string() });
const importDocumentSchema = z.object({ folders: z.array(z.unknown()) });

/** `['repos', 0, 'alias']` → `repos[0].alias`, the key a form can point at. */
const fieldKey = (segments) => segments.reduce(
  (key, segment) => (Number.isInteger(segment) ? `${key}[${segment}]` : (key ? `${key}.${segment}` : `${segment}`)),
  '',
);

const validationFields = (error) => {
  const fields = {};
  for (const issue of error.issues) {
    const key = fieldKey(issue.path) || 'workspace';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
};

const parseInput = (schema, payload) => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw invalid(validationFields(parsed.error));
  }
  return parsed.data;
};

/** Structural validation only; nothing is resolved or registered here. */
const parseCreatePayload = (payload) => parseInput(createWorkspaceSchema, payload);

const resolveRepos = async ({
  repos,
  primaryIndex,
  projects,
  fsPromises,
  validateDirectoryPath,
  retainedProjects = new Map(),
}) => {
  const fields = {};
  const seenProjectIds = new Set();
  const resolved = [];
  let nextProjects = projects;

  for (const [index, repo] of repos.entries()) {
    const field = `repos[${index}]`;
    let project = null;

    if (repo.projectId) {
      project = nextProjects.find((candidate) => candidate.id === repo.projectId) || null;
      if (!project) {
        // A project that left the catalog while it is already in this workspace
        // stays in the edit payload untouched, and keeps reading as missing.
        const retained = retainedProjects.get(repo.projectId) ?? null;
        if (!retained) {
          fields[`${field}.projectId`] = 'Project not found';
          continue;
        }
        if (seenProjectIds.has(retained.projectId)) {
          fields[`${field}.projectId`] = 'Repository is already in this workspace';
          continue;
        }
        seenProjectIds.add(retained.projectId);
        resolved.push({
          projectId: retained.projectId,
          alias: repo.alias,
          description: retained.description ?? '',
          branch: repo.branch ?? retained.branch ?? '',
        });
        continue;
      }
    } else {
      const added = await resolveProjectForDirectory({
        requestedPath: repo.path,
        create: false,
        readExistingProjects: async () => nextProjects,
        fsPromises,
        validateDirectoryPath,
      });
      if (!added.ok) {
        fields[`${field}.path`] = added.error || 'Folder is not available';
        continue;
      }
      nextProjects = added.projects;
      project = added.project;
    }

    if (seenProjectIds.has(project.id)) {
      fields[`${field}.projectId`] = 'Repository is already in this workspace';
      continue;
    }
    seenProjectIds.add(project.id);

    resolved.push({
      projectId: project.id,
      alias: repo.alias,
      // The reference description comes from the project label in v1.
      description: project.label ?? '',
      branch: repo.branch ?? '',
    });
  }

  if (Object.keys(fields).length > 0) {
    throw invalid(fields);
  }

  return {
    repos: resolved,
    primaryProjectId: resolved[primaryIndex].projectId,
    projects: nextProjects,
  };
};

// Config is untyped JSONC: parse the `references` section at this boundary
// instead of trusting its shape downstream.
const referencesSchema = z.record(z.string(), z.unknown());
const referenceEntrySchema = z.union([
  z.string().transform((value) => ({ path: value, description: '' })),
  z.object({
    path: z.string().nullable().catch(null),
    description: z.string().catch(''),
  }),
]);

const referencesOf = (config) => {
  const parsed = referencesSchema.safeParse(config?.references);
  return parsed.success ? parsed.data : null;
};

const layerDefinesAlias = (config, alias) => {
  const references = referencesOf(config);
  return references !== null && Object.hasOwn(references, alias);
};

/** A config entry as `{ path, description }`; null when the value is not an object or string. */
const currentReferenceValue = (value) => {
  const parsed = referenceEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const referenceMatches = (current, expected) => (
  current !== null
  && current.path !== null
  && path.isAbsolute(current.path)
  && path.resolve(current.path) === expected.path
  && current.description === expected.description
);

const describeReference = (reference, state) => ({
  alias: reference.alias,
  // The written value: absolute and normalized, so it never depends on the
  // config file's directory.
  path: reference.path,
  description: reference.description,
  status: state.status,
  owned: reference.owned,
  current: state.current,
});

const expectedReferences = (workspace, projectsById) => workspace.repos
  .filter((repo) => repo.projectId !== workspace.primaryProjectId)
  .map((repo) => {
    const project = projectsById.get(repo.projectId) ?? null;
    return {
      alias: repo.alias,
      description: repo.description ?? '',
      owned: workspace.createdRefs.includes(repo.alias),
      project,
      path: project ? path.resolve(project.path) : null,
    };
  });

/** Every expected reference in one state, for a read that could not classify any. */
const expectedRefsInState = (workspace, projects, status) => expectedReferences(
  workspace,
  new Map(projects.map((project) => [project.id, project])),
).map((reference) => describeReference(reference, { status, current: null }));

/**
 * The value in effect for an alias that is not in the project layer. Custom
 * config sits above the project files, then the lower project layers from
 * highest to lowest, then the global user files.
 */
const outsideReferenceValue = (alias, layers, lowerConfigs) => {
  if (layerDefinesAlias(layers.customConfig, alias)) {
    return currentReferenceValue(referencesOf(layers.customConfig)[alias]);
  }
  for (let index = lowerConfigs.length - 1; index >= 0; index -= 1) {
    const config = lowerConfigs[index][1];
    if (layerDefinesAlias(config, alias)) {
      return currentReferenceValue(referencesOf(config)[alias]);
    }
  }
  return currentReferenceValue(referencesOf(layers.mergedConfig)?.[alias]);
};

/**
 * The project layer owns the entry, every other layer reveals an alias this
 * workspace would shadow. A missing project entry is `missing`; an entry only
 * in another layer is `outside`, including one defined below `.opencode/`.
 */
const classifyReference = (reference, layers, lower = null) => {
  const lowerConfigs = lower?.configs ?? [];
  const projectReferences = referencesOf(layers.projectConfig);
  const inProject = projectReferences !== null && Object.hasOwn(projectReferences, reference.alias);
  const inOtherLayer = [
    layers.userConfig,
    layers.userOverrideConfig,
    layers.customConfig,
    ...lowerConfigs.map(([, config]) => config),
  ].some((layer) => layerDefinesAlias(layer, reference.alias));

  if (inProject && inOtherLayer) {
    return {
      status: 'overridden',
      current: currentReferenceValue(projectReferences[reference.alias]),
    };
  }
  if (inProject) {
    const current = currentReferenceValue(projectReferences[reference.alias]);
    return { status: referenceMatches(current, reference) ? 'ok' : 'different', current };
  }
  if (inOtherLayer) {
    return {
      status: 'outside',
      current: outsideReferenceValue(reference.alias, layers, lowerConfigs),
    };
  }
  return { status: 'missing', current: null };
};

/**
 * Reads the primary's config once and classifies every expected reference.
 * Any layer parse error makes the conflict state untrustworthy, so every ref is
 * `unknown` and the first error is reported once.
 */
const readWorkspaceRefs = ({
  workspace,
  projectsById,
  readConfigLayers,
  getLayerError,
  getProjectConfigPath,
  readLowerConfigs,
}) => {
  const primaryProject = projectsById.get(workspace.primaryProjectId) ?? null;
  const expected = expectedReferences(workspace, projectsById);

  if (!primaryProject) {
    // Without the primary there is no config to read; its refs read as missing
    // instead of failing the whole workspace.
    return {
      refs: expected.map((reference) => describeReference(reference, { status: 'missing', current: null })),
      error: null,
    };
  }

  const layers = readConfigLayers(primaryProject.path);
  const projectConfigPath = getProjectConfigPath(primaryProject.path);
  const lower = readLowerConfigs(primaryProject.path, projectConfigPath);
  // A malformed `references` section is a read error too: its shape cannot be
  // classified any more than a file that did not parse.
  const readError = getLayerError(layers, projectConfigPath) ?? configReadError(layers, lower);
  const error = readError ? { path: readError.path, message: readError.message } : null;

  const refs = expected.map((reference) => {
    if (readError) {
      return describeReference(reference, { status: 'unknown', current: null });
    }
    if (!reference.project) {
      return describeReference(reference, { status: 'missing', current: null });
    }
    return describeReference(reference, classifyReference(reference, layers, lower));
  });

  return { refs, error };
};

const REFS_DIR = '.opencode';
const REFS_FILE = 'opencode.json';

/** Always the `.opencode/` layer; the root file is never a write target. */
const refsConfigPath = (projectPath) => path.resolve(projectPath, REFS_DIR, REFS_FILE);

/**
 * Project config files below the write target, lowest priority first. OpenCode
 * loads all of them under `.opencode/opencode.json`, but `readConfigLayers`
 * parses only the project's current highest-priority file, so the service reads
 * the remaining layers here. The shared reader is untouched.
 */
const LOWER_PROJECT_CONFIG_FILES = [
  ['opencode.json'],
  ['opencode.jsonc'],
  [REFS_DIR, 'opencode.jsonc'],
];

/**
 * Reads the project layers the shared reader skipped. A missing file reads as
 * `{}`; a malformed one becomes the same `{ path, message }` config error as a
 * failed layer, never a silent omission.
 */
const lowerProjectConfigs = (projectPath, projectConfigPath, readConfigFile) => {
  const current = projectConfigPath ? path.resolve(projectConfigPath) : null;
  const configs = [];
  for (const segments of LOWER_PROJECT_CONFIG_FILES) {
    const filePath = path.resolve(projectPath, ...segments);
    // `readConfigLayers` already parsed this layer as `projectConfig`.
    if (filePath === current) continue;
    try {
      configs.push([filePath, readConfigFile(filePath)]);
    } catch (error) {
      return {
        configs,
        error: { path: filePath, message: error?.message || 'The OpenCode configuration could not be read' },
      };
    }
  }
  return { configs, error: null };
};

/**
 * The dialog needs to warn when the `.opencode/` layer overrides a root config.
 * The root file is reported whenever it exists, including when the write target
 * already exists and `getProjectConfigPath` no longer points at it. `.jsonc` is
 * checked first because OpenCode loads it after `.json`, so it is the file that
 * wins when both exist. Only a missing file means there is nothing to warn
 * about; any other stat error still names the candidate, which may exist and be
 * shadowed by the new layer.
 */
const describeConfigTarget = async (projectPath, fsPromises) => {
  const root = path.resolve(projectPath);
  let rootConfigPath = null;
  for (const file of ['opencode.jsonc', 'opencode.json']) {
    const candidate = path.join(root, file);
    try {
      if ((await fsPromises.stat(candidate)).isFile()) {
        rootConfigPath = candidate;
        break;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        rootConfigPath = candidate;
        break;
      }
    }
  }
  return { path: refsConfigPath(projectPath), rootConfigPath };
};

/** A parsed config whose `references` key is not an object cannot be merged safely. */
const invalidReferencesSection = (layers, extraLayers = []) => {
  const candidates = [
    [layers.paths?.userPath, layers.userConfig],
    [layers.paths?.userOverridePath, layers.userOverrideConfig],
    [layers.paths?.projectPath, layers.projectConfig],
    [layers.paths?.customPath, layers.customConfig],
    ...extraLayers,
  ];
  for (const [filePath, config] of candidates) {
    if (filePath && config && config.references !== undefined && referencesOf(config) === null) {
      return { path: filePath, message: 'The "references" section must be an object' };
    }
  }
  return null;
};

const configReadError = (layers, lower = null) => {
  const failedLayer = layers.layerErrors?.[0] ?? lower?.error ?? null;
  if (failedLayer) {
    return { path: failedLayer.path, message: failedLayer.message };
  }
  return invalidReferencesSection(layers, lower?.configs ?? []);
};

const configErrorResponse = (configError) => new WorkspaceRequestError(
  422,
  'OpenCode configuration cannot be read',
  { configError },
);

const conflictResponse = (alias, current) => new WorkspaceRequestError(
  409,
  'Reference alias is already in use',
  { conflict: { alias, path: current?.path ?? null } },
);

/**
 * An owned entry the workspace can no longer locate: writing the workspace
 * would leave that entry in the old config with no owner.
 */
const unverifiableRemovalResponse = (alias) => new WorkspaceRequestError(
  409,
  'An owned reference cannot be verified for removal',
  { conflict: { alias, path: null } },
);

export const createWorkspaceService = (dependencies) => {
  const {
    readSettings,
    persistSettings,
    sanitizeProjects,
    sanitizeRepoWorkspaces,
    validateDirectoryPath,
    fsPromises,
    crypto,
    readConfigLayers,
    readConfigFile,
    writeConfig,
    getLayerError,
    getProjectConfigPath,
    homeDirectory = os.homedir(),
  } = dependencies;

  const storedWorkspaces = (value) => sanitizeRepoWorkspaces(value)?.workspaces ?? [];

  // create/update/remove/activate read the settings document and persist a new
  // snapshot built from it; a lost update here would drop a workspace. The
  // whole section runs through this queue.
  let settingsQueue = Promise.resolve();
  const withSettingsLock = (operation) => {
    const run = settingsQueue.then(operation, operation);
    settingsQueue = run.catch(() => {});
    return run;
  };

  // Every config read-modify-write runs through this queue. Two requests then
  // re-read the file the previous one wrote instead of overwriting each other.
  // Lock order is settings first, refs second; nothing takes them the other way.
  let refsQueue = Promise.resolve();
  const withRefsLock = (operation) => {
    const run = refsQueue.then(operation, operation);
    refsQueue = run.catch(() => {});
    return run;
  };

  const primaryProjectOf = (workspace, projects) => {
    const primary = projects.find((project) => project.id === workspace.primaryProjectId) ?? null;
    if (!primary) {
      throw invalid({ id: 'The workspace primary project is not available' });
    }
    return primary;
  };

  // The layers `readConfigLayers` does not parse because the write target exists.
  const readLowerConfigs = (primaryPath, projectConfigPath = getProjectConfigPath(primaryPath)) => (
    lowerProjectConfigs(primaryPath, projectConfigPath, readConfigFile)
  );

  const assertWritableReference = async (reference) => {
    if (!reference.project) {
      throw invalid({ [`refs.${reference.alias}.path`]: 'Repository folder is not available' });
    }
    const validated = await validateDirectoryPath(reference.project.path);
    if (!validated.ok) {
      throw invalid({ [`refs.${reference.alias}.path`]: validated.error || 'Repository folder is not available' });
    }
  };

  /**
   * One alias per write, re-reading the target each time: an alias that fails
   * keeps its failure to itself and the next alias still writes. Callers hold
   * the queue.
   */
  const writeReferences = async ({ primaryPath, references, confirmRefs }) => {
    const targetPath = refsConfigPath(primaryPath);
    const results = [];

    for (const reference of references) {
      try {
        const layers = readConfigLayers(primaryPath);
        const lower = readLowerConfigs(primaryPath);
        const configError = configReadError(layers, lower);
        if (configError) {
          results.push({ alias: reference.alias, status: 'failed', message: configError.message });
          continue;
        }

        const state = classifyReference(reference, layers, lower);
        if (state.status === 'ok') {
          results.push({ alias: reference.alias, status: 'unchanged' });
          continue;
        }
        if (state.status !== 'missing' && !confirmRefs.has(reference.alias)) {
          results.push({
            alias: reference.alias,
            status: 'failed',
            message: 'The alias is defined elsewhere and was not confirmed for overwrite',
          });
          continue;
        }

        const config = readConfigFile(targetPath);
        const value = referencesOf(config);
        if (config.references !== undefined && value === null) {
          results.push({ alias: reference.alias, status: 'failed', message: 'The "references" section must be an object' });
          continue;
        }
        const next = {
          ...config,
          references: {
            ...(value ?? {}),
            [reference.alias]: { path: reference.path, description: reference.description },
          },
        };
        await writeConfig(next, targetPath);
        results.push({ alias: reference.alias, status: 'written' });
      } catch {
        results.push({ alias: reference.alias, status: 'failed', message: 'Failed to write the reference' });
      }
    }

    return results;
  };

  const refsFor = (workspace, projects) => readWorkspaceRefs({
    workspace,
    projectsById: new Map(projects.map((project) => [project.id, project])),
    readConfigLayers,
    getLayerError,
    getProjectConfigPath,
    readLowerConfigs,
  });

  /**
   * A read after the workspace is already saved, or one workspace inside the
   * list: an unexpected IO error (EACCES and the like, which `readConfigLayers`
   * does not turn into a layer error) must not undo a successful write or hide
   * the other workspaces. The refs then read `unknown` with the primary's
   * target config path.
   */
  const safeRefsFor = (workspace, projects) => {
    try {
      return refsFor(workspace, projects);
    } catch (error) {
      const primary = projects.find((project) => project.id === workspace.primaryProjectId) ?? null;
      return {
        refs: expectedRefsInState(workspace, projects, 'unknown'),
        error: {
          path: primary ? refsConfigPath(primary.path) : null,
          message: error?.message || 'The OpenCode configuration could not be read',
        },
      };
    }
  };

  /**
   * The dialog reads the exact target before the user submits; the row may be a
   * folder that is not a project yet, so this never touches settings. A config
   * it cannot parse is a 422, the same shape as every other flow.
   */
  const configTarget = async (payload) => {
    const { path: requestedPath } = parseInput(configTargetPayloadSchema, payload);
    if (!path.isAbsolute(requestedPath)) {
      throw invalid({ path: 'Folder path must be absolute' });
    }
    const validated = await validateDirectoryPath(requestedPath);
    if (!validated.ok) {
      throw invalid({ path: validated.error || 'Folder is not available' });
    }
    const folderPath = validated.directory ?? requestedPath;
    const layers = readConfigLayers(folderPath);
    const lower = readLowerConfigs(folderPath);
    const configError = getLayerError(layers, getProjectConfigPath(folderPath))
      ?? configReadError(layers, lower);
    if (configError) throw configErrorResponse(configError);
    return describeConfigTarget(folderPath, fsPromises);
  };

  const list = async () => {
    const settings = await readSettings();
    const parsed = sanitizeRepoWorkspaces(settings.workspaces);
    const activeWorkspaceId = activeWorkspaceIdSchema.safeParse(settings.activeWorkspaceId);
    const projects = sanitizeProjects(settings.projects) || [];
    const projectsById = new Map(projects.map((project) => [project.id, project]));

    const workspaces = (parsed?.workspaces ?? []).map((workspace) => {
      // The edit dialog reads any workspace's references, so every entry
      // carries its own state.
      const { refs, error: refsError } = safeRefsFor(workspace, projects);
      return {
        ...workspace,
        repos: workspace.repos.map((repo) => {
          const project = projectsById.get(repo.projectId) || null;
          return {
            ...repo,
            missing: project === null,
            project: project ? { id: project.id, path: project.path, label: project.label ?? '' } : null,
          };
        }),
        refs,
        refsError,
      };
    });
    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId.data) ?? null;

    return {
      workspaces,
      activeWorkspaceId: activeWorkspaceId.success ? activeWorkspaceId.data : null,
      // Invalid entries are dropped from this read only; the file is untouched.
      discarded: parsed?.discarded ?? 0,
      refs: activeWorkspace?.refs ?? [],
      refsError: activeWorkspace?.refsError ?? null,
    };
  };

  /**
   * Reads a `.code-workspace` into the dialog's draft. It never writes: no
   * workspace, project or config is touched, and the user still has to submit
   * the form.
   */
  const importDraft = async (payload) => {
    const { path: requestedPath } = parseInput(importPayloadSchema, payload);
    const filePath = path.resolve(expandHome(requestedPath, homeDirectory));

    let content;
    try {
      content = await fsPromises.readFile(filePath, 'utf8');
    } catch {
      throw new WorkspaceRequestError(
        422,
        'Workspace file cannot be read',
        { importError: { reason: 'unreadable' } },
      );
    }

    const parseErrors = [];
    const document = importDocumentSchema.safeParse(parseJsonc(content, parseErrors, { allowTrailingComma: true }));
    if (parseErrors.length > 0 || !document.success) {
      throw new WorkspaceRequestError(
        422,
        'Workspace file is not valid JSON',
        { importError: { reason: 'invalid-json' } },
      );
    }

    const fileDirectory = path.dirname(filePath);
    const folders = [];
    const seenPaths = new Set();
    const takenAliases = new Set();

    for (const entry of document.data.folders) {
      const folder = importFolderSchema.safeParse(entry);
      if (!folder.success) continue;
      const rawPath = folder.data.path.trim();
      if (!rawPath) continue;

      let folderPath;
      if (FOLDER_URI_PATTERN.test(rawPath)) {
        let url = null;
        try {
          url = new URL(rawPath);
        } catch {
          // Not a local path either way; report it as a skipped folder.
        }
        if (!url || url.protocol !== 'file:') {
          folders.push({ path: rawPath, alias: '', primary: false, error: 'unsupported' });
          continue;
        }
        try {
          folderPath = fileURLToPath(url);
        } catch {
          folders.push({ path: rawPath, alias: '', primary: false, error: 'unsupported' });
          continue;
        }
      } else {
        folderPath = path.resolve(fileDirectory, expandHome(rawPath, homeDirectory));
      }

      // A symlink and its target are the same folder; a missing folder keeps
      // the normalized path so duplicates in the file still collapse.
      let dedupeKey = folderPath;
      try {
        dedupeKey = await fsPromises.realpath(folderPath);
      } catch {
        // Keep the normalized path.
      }
      if (seenPaths.has(dedupeKey)) continue;
      seenPaths.add(dedupeKey);

      const alias = nextFolderAlias(aliasBaseForFolder(folderPath), takenAliases);
      takenAliases.add(alias);
      folders.push({ path: folderPath, alias, primary: false, error: null });
    }

    const primary = folders.find((folder) => folder.error === null);
    if (primary) primary.primary = true;

    const basename = path.basename(filePath);
    return {
      name: path.basename(filePath, path.extname(filePath)) || basename,
      folders,
    };
  };

  const createWorkspace = async (payload) => {
    const { name, repos: entries, confirmRefs = [] } = parseCreatePayload(payload);
    const confirmed = new Set(confirmRefs);
    const primaryIndex = entries.findIndex((repo) => repo.primary === true);
    const settings = await readSettings();
    const projects = sanitizeProjects(settings.projects) || [];
    const { repos, primaryProjectId, projects: nextProjects } = await resolveRepos({
      repos: entries,
      primaryIndex,
      projects,
      fsPromises,
      validateDirectoryPath,
    });

    const workspace = {
      id: `${WORKSPACE_ID_PREFIX}${crypto.randomUUID()}`,
      name,
      primaryProjectId,
      repos,
      createdRefs: [],
    };

    // Validate the config and every target before anything is written. A broken
    // layer or an unreachable folder must leave no workspace behind either.
    const primary = primaryProjectOf(workspace, nextProjects);
    // Read before the write: once the target exists, the root file is no
    // longer what `getProjectConfigPath` reports.
    const configTarget = await describeConfigTarget(primary.path, fsPromises);
    const layers = readConfigLayers(primary.path);
    const lower = readLowerConfigs(primary.path);
    const configError = configReadError(layers, lower);
    if (configError) throw configErrorResponse(configError);

    const projectsById = new Map(nextProjects.map((project) => [project.id, project]));
    const references = expectedReferences(workspace, projectsById);
    const toWrite = [];
    for (const reference of references) {
      await assertWritableReference(reference);
      const state = classifyReference(reference, layers, lower);
      if (state.status === 'ok') continue;
      if (state.status !== 'missing' && !confirmed.has(reference.alias)) {
        throw conflictResponse(reference.alias, state.current);
      }
      toWrite.push(reference);
    }
    // Only what this workspace writes is its own; an identical entry that was
    // already there belongs to the user.
    workspace.createdRefs = toWrite.map((reference) => reference.alias);

    const changes = {
      workspaces: [...storedWorkspaces(settings.workspaces), workspace],
      activeWorkspaceId: workspace.id,
      // The existing activation path: the primary becomes the active project.
      activeProjectId: primaryProjectId,
    };
    if (nextProjects !== projects) {
      // A folder registered by this request lands with the workspace, so a
      // failed settings write leaves neither of them behind.
      changes.projects = nextProjects;
    }

    await persistSettings(changes);

    // Best effort: the workspace is already saved, so one failed alias is a
    // pending reference, never a lost workspace.
    const writeResults = toWrite.length > 0
      ? await withRefsLock(() => writeReferences({ primaryPath: primary.path, references: toWrite, confirmRefs: confirmed }))
      : [];
    const writeByAlias = new Map(writeResults.map((result) => [result.alias, result]));
    const refWrites = references.map((reference) => (
      writeByAlias.get(reference.alias) ?? { alias: reference.alias, status: 'unchanged' }
    ));

    const { refs, error: refsError } = safeRefsFor(workspace, nextProjects);
    return {
      workspace,
      refs,
      refWrites,
      refsError,
      configTarget,
    };
  };

  // The read of the settings snapshot and every write derived from it are one
  // critical section; the reference writes inside it take the refs queue second.
  const create = (payload) => withSettingsLock(() => createWorkspace(payload));

  const retryRefs = async (workspaceId, payload = {}) => {
    const { aliases, confirmRefs = [] } = parseInput(retryRefsSchema, payload ?? {});
    const confirmed = new Set(confirmRefs);
    const settings = await readSettings();
    const workspace = storedWorkspaces(settings.workspaces)
      .find((candidate) => candidate.id === workspaceId) || null;
    if (!workspace) {
      throw new WorkspaceRequestError(404, 'Workspace not found');
    }

    const projects = sanitizeProjects(settings.projects) || [];
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const primary = primaryProjectOf(workspace, projects);
    const configTarget = await describeConfigTarget(primary.path, fsPromises);
    const layers = readConfigLayers(primary.path);
    const lower = readLowerConfigs(primary.path);
    const configError = configReadError(layers, lower);
    if (configError) throw configErrorResponse(configError);

    const references = expectedReferences(workspace, projectsById);
    const byAlias = new Map(references.map((reference) => [reference.alias, reference]));
    let selected;
    if (aliases) {
      for (const alias of aliases) {
        const reference = byAlias.get(alias);
        if (!reference) throw invalid({ aliases: `Unknown reference alias "${alias}"` });
        if (!reference.owned) throw invalid({ aliases: `The alias "${alias}" is not owned by this workspace` });
      }
      selected = aliases.map((alias) => byAlias.get(alias));
    } else {
      // Pending means an owned reference the last attempt did not write. An
      // alias the user added or edited elsewhere is not pending.
      selected = references.filter((reference) => (
        reference.owned && reference.path !== null && classifyReference(reference, layers, lower).status === 'missing'
      ));
    }

    const toWrite = [];
    for (const reference of selected) {
      const state = classifyReference(reference, layers, lower);
      if (state.status === 'ok') continue;
      if (state.status !== 'missing' && !confirmed.has(reference.alias)) {
        throw conflictResponse(reference.alias, state.current);
      }
      await assertWritableReference(reference);
      toWrite.push(reference);
    }

    const writeResults = toWrite.length > 0
      ? await withRefsLock(() => writeReferences({ primaryPath: primary.path, references: toWrite, confirmRefs: confirmed }))
      : [];
    const writeByAlias = new Map(writeResults.map((result) => [result.alias, result]));
    const refWrites = selected.map((reference) => (
      writeByAlias.get(reference.alias) ?? { alias: reference.alias, status: 'unchanged' }
    ));

    const { refs, error: refsError } = safeRefsFor(workspace, projects);
    return {
      refs,
      refWrites,
      refsError,
      configTarget,
    };
  };

  /**
   * The removal helper ticket 07 calls. Ownership is `createdRefs` only, and an
   * entry is removed only from this workspace's target file. A user-edited
   * entry needs an explicit confirmation, like an overwrite. All removals land
   * in one write, so a failed write removes nothing.
   */
  const removeCreatedRefs = async ({ workspace, aliases = workspace.createdRefs, confirmRefs = [] }) => {
    const confirmed = new Set(confirmRefs);
    const settings = await readSettings();
    const projects = sanitizeProjects(settings.projects) || [];
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const primary = primaryProjectOf(workspace, projects);
    const references = new Map(expectedReferences(workspace, projectsById).map((reference) => [reference.alias, reference]));

    return withRefsLock(async () => {
      // Removal only reads and writes the target layer. The lower project files
      // classify aliases on read, but nothing here classifies: a malformed one
      // must not block deleting the entry this workspace wrote.
      const layers = readConfigLayers(primary.path);
      const layersError = configReadError(layers);
      if (layersError) throw configErrorResponse(layersError);

      const targetPath = refsConfigPath(primary.path);
      let targetConfig;
      try {
        targetConfig = readConfigFile(targetPath);
      } catch (error) {
        throw configErrorResponse({ path: targetPath, message: error.message });
      }
      const targetReferences = referencesOf(targetConfig);
      if (targetConfig.references !== undefined && targetReferences === null) {
        throw configErrorResponse({ path: targetPath, message: 'The "references" section must be an object' });
      }

      const removable = [];
      const refWrites = [];
      let blockedAlias = null;
      for (const alias of aliases) {
        const reference = references.get(alias) ?? null;
        if (!workspace.createdRefs.includes(alias)) {
          // A user reference is never part of this workspace's removals.
          refWrites.push({ alias, status: 'skipped' });
          continue;
        }
        if (!targetReferences || !Object.hasOwn(targetReferences, alias)) {
          refWrites.push({ alias, status: 'absent' });
          continue;
        }
        if (!reference || reference.path === null) {
          // The workspace no longer knows which value it wrote; never guess.
          // The whole request is blocked, not just this alias, so the other
          // owned entries are not deleted while this one is left behind.
          refWrites.push({ alias, status: 'skipped' });
          blockedAlias ??= alias;
          continue;
        }

        const current = currentReferenceValue(targetReferences[alias]);
        if (!referenceMatches(current, reference) && !confirmed.has(alias)) {
          throw conflictResponse(alias, current);
        }
        removable.push(alias);
        refWrites.push({ alias, status: 'removed' });
      }

      if (blockedAlias) {
        // Nothing was written, so no alias is reported as removed.
        return {
          removed: [],
          refWrites: refWrites.map((write) => (
            write.status === 'removed' ? { alias: write.alias, status: 'skipped' } : write
          )),
          removedEntries: {},
          path: targetPath,
          blockedAlias,
        };
      }

      if (removable.length > 0) {
        const nextReferences = { ...targetReferences };
        const removedEntries = {};
        for (const alias of removable) {
          removedEntries[alias] = targetReferences[alias];
          delete nextReferences[alias];
        }
        try {
          await writeConfig({ ...targetConfig, references: nextReferences }, targetPath);
        } catch {
          throw new WorkspaceRequestError(
            409,
            'Failed to remove workspace references',
            { conflict: { aliases: removable, path: targetPath } },
          );
        }
        return { removed: removable, refWrites, removedEntries, path: targetPath, blockedAlias: null };
      }

      return { removed: [], refWrites, removedEntries: {}, path: targetPath, blockedAlias: null };
    });
  };

  /**
   * Edit in the contract order: validate and register folders, remove the
   * owned references that leave, save the workspace, then write the new
   * references best effort. A failed removal aborts before the save, so the
   * workspace never points at a half-edited config.
   */
  const updateWorkspace = async (workspaceId, payload) => {
    const {
      name,
      repos: entries,
      confirmRefs = [],
      keepRefs = [],
    } = parseInput(updateWorkspaceSchema, payload);
    const confirmed = new Set(confirmRefs);
    const kept = new Set(keepRefs);

    const settings = await readSettings();
    const stored = storedWorkspaces(settings.workspaces);
    const existing = stored.find((candidate) => candidate.id === workspaceId) || null;
    if (!existing) {
      throw new WorkspaceRequestError(404, 'Workspace not found');
    }

    const projects = sanitizeProjects(settings.projects) || [];
    const projectIds = new Set(projects.map((project) => project.id));
    const retainedProjects = new Map(
      existing.repos
        .filter((repo) => !projectIds.has(repo.projectId))
        .map((repo) => [repo.projectId, repo]),
    );
    const primaryIndex = entries.findIndex((repo) => repo.primary === true);
    const { repos, primaryProjectId, projects: nextProjects } = await resolveRepos({
      repos: entries,
      primaryIndex,
      projects,
      fsPromises,
      validateDirectoryPath,
      retainedProjects,
    });

    const workspace = { ...existing, name, primaryProjectId, repos };
    const nextProjectsById = new Map(nextProjects.map((project) => [project.id, project]));
    const nextReferences = expectedReferences(workspace, nextProjectsById);
    const nextPrimary = primaryProjectOf(workspace, nextProjects);
    // Read before any write: the root file stops being what
    // `getProjectConfigPath` reports once `.opencode/` exists.
    const configTarget = await describeConfigTarget(nextPrimary.path, fsPromises);

    const oldProjectsById = new Map(projects.map((project) => [project.id, project]));
    const oldReferences = expectedReferences(existing, oldProjectsById);
    const oldReferenceByAlias = new Map(oldReferences.map((reference) => [reference.alias, reference]));
    const nextAliases = new Set(nextReferences.map((reference) => reference.alias));
    const primaryChanged = existing.primaryProjectId !== primaryProjectId;
    // A new primary means a new config file: every owned entry lives in the old
    // primary, so each one is removed there even when its repo stays a
    // secondary. Otherwise the old file keeps copies nothing can remove.
    const leavingAliases = oldReferences
      .filter((reference) => (
        reference.owned
        && !kept.has(reference.alias)
        && (primaryChanged || !nextAliases.has(reference.alias))
      ))
      .map((reference) => reference.alias);
    const oldPrimary = oldProjectsById.get(existing.primaryProjectId) ?? null;

    // Preflight the new primary and every new reference before removing
    // anything. A conflict found after the removal would leave the old config
    // edited with the workspace still unchanged.
    const layers = readConfigLayers(nextPrimary.path);
    const lower = readLowerConfigs(nextPrimary.path);
    const configError = configReadError(layers, lower);
    if (configError) throw configErrorResponse(configError);

    const toWrite = [];
    for (const reference of nextReferences) {
      // A repo whose project is gone has no folder to validate or write; it
      // keeps reading as `missing`.
      if (!reference.project) continue;
      await assertWritableReference(reference);
      const state = classifyReference(reference, layers, lower);
      if (state.status === 'ok') continue;
      // An owned entry that still is exactly what the old workspace wrote can
      // change with the workspace itself; only a hand-edited entry needs a
      // confirmation, because the user's value would be lost.
      const previous = oldReferenceByAlias.get(reference.alias) ?? null;
      // The same expected entry in another layer is not this workspace's to
      // rewrite, and rewriting it would not change what is in effect.
      const unchanged = previous !== null
        && previous.path === reference.path
        && previous.description === reference.description;
      if (unchanged && (state.status === 'outside' || state.status === 'overridden')) continue;
      const stillWorkspaceOwned = state.status === 'different'
        && previous?.owned === true
        && referenceMatches(state.current, previous);
      if (state.status !== 'missing' && !confirmed.has(reference.alias) && !stillWorkspaceOwned) {
        throw conflictResponse(reference.alias, state.current);
      }
      // The writer repeats this classification, so the auto-allowed case has
      // to travel with the request as a confirmation.
      if (stillWorkspaceOwned) confirmed.add(reference.alias);
      toWrite.push(reference);
    }

    // Without the old primary there is no config to edit; its references are
    // already unreachable and the new set simply stops owning them.
    const removal = leavingAliases.length > 0 && oldPrimary
      ? await removeCreatedRefs({ workspace: existing, aliases: leavingAliases, confirmRefs })
      : null;
    if (removal?.blockedAlias) {
      // The removal helper wrote nothing; abort before the workspace changes.
      throw unverifiableRemovalResponse(removal.blockedAlias);
    }

    const retainedOwned = existing.createdRefs.filter((alias) => nextAliases.has(alias));
    workspace.createdRefs = [...new Set([...retainedOwned, ...toWrite.map((reference) => reference.alias)])];

    const changes = {
      workspaces: stored.map((candidate) => (candidate.id === workspace.id ? workspace : candidate)),
    };
    if (nextProjects !== projects) {
      changes.projects = nextProjects;
    }

    await persistWorkspaceChange(changes, removal);

    const writeResults = toWrite.length > 0
      ? await withRefsLock(() => writeReferences({ primaryPath: nextPrimary.path, references: toWrite, confirmRefs: confirmed }))
      : [];
    const writeByAlias = new Map(writeResults.map((result) => [result.alias, result]));
    const refWrites = nextReferences.map((reference) => (
      writeByAlias.get(reference.alias) ?? { alias: reference.alias, status: 'unchanged' }
    ));

    const { refs, error: refsError } = safeRefsFor(workspace, nextProjects);
    return {
      workspace,
      refs,
      refWrites,
      refsError,
      configTarget,
    };
  };

  const update = (workspaceId, payload) => withSettingsLock(() => updateWorkspace(workspaceId, payload));

  /**
   * A settings write that fails after a successful removal leaves a workspace
   * pointing at entries it no longer expects; put them back before reporting.
   * A restore that cannot write is reported by its caller, never swallowed.
   */
  const restoreRemovedEntries = async (removal) => {
    if (!removal || Object.keys(removal.removedEntries).length === 0) return;
    await withRefsLock(async () => {
      const config = readConfigFile(removal.path);
      const current = referencesOf(config) ?? {};
      await writeConfig(
        { ...config, references: { ...current, ...removal.removedEntries } },
        removal.path,
      );
    });
  };

  /**
   * Saves the workspace, rolling back the removals when that fails. If the
   * rollback fails too, the config no longer matches the unchanged workspace,
   * so that is the error the caller gets: a 500 naming the config file.
   */
  const persistWorkspaceChange = async (changes, removal) => {
    try {
      await persistSettings(changes);
    } catch (error) {
      try {
        await restoreRemovedEntries(removal);
      } catch {
        throw new WorkspaceRequestError(
          500,
          'Failed to restore workspace references',
          {
            configError: {
              path: removal.path,
              message: 'The settings write failed and the removed references could not be restored',
            },
          },
        );
      }
      throw error;
    }
  };

  /**
   * Delete in the contract order: remove the owned references first, then drop
   * the workspace and clear the pointer when it was the active one. A failed
   * removal answers `removed: false` with the alias and leaves settings alone.
   */
  const removeWorkspace = async (workspaceId, payload = {}) => {
    const {
      removeCreatedRefs: alsoRemoveRefs = false,
      confirmRefs = [],
    } = parseInput(removeWorkspaceSchema, payload ?? {});
    const settings = await readSettings();
    const stored = storedWorkspaces(settings.workspaces);
    const workspace = stored.find((candidate) => candidate.id === workspaceId) || null;
    if (!workspace) {
      throw new WorkspaceRequestError(404, 'Workspace not found');
    }

    const projects = sanitizeProjects(settings.projects) || [];
    let removal = null;
    if (alsoRemoveRefs && workspace.createdRefs.length > 0) {
      try {
        removal = await removeCreatedRefs({ workspace, confirmRefs });
      } catch (error) {
        if (!(error instanceof WorkspaceRequestError)) throw error;
        // Config unreadable, a hand-edited entry, or a failed write: the
        // workspace stays exactly where it was.
        return {
          removed: false,
          refs: safeRefsFor(workspace, projects).refs,
          failedAlias: error.conflict?.alias ?? error.conflict?.aliases?.[0] ?? null,
          configError: error.configError,
        };
      }
      // An owned alias whose entry cannot be verified blocked the whole
      // removal, so the file is untouched; the workspace must stay so the
      // alias is not orphaned without an owner.
      if (removal.blockedAlias) {
        return {
          removed: false,
          refs: safeRefsFor(workspace, projects).refs,
          failedAlias: removal.blockedAlias,
          configError: null,
        };
      }
    }

    const changes = {
      workspaces: stored.filter((candidate) => candidate.id !== workspace.id),
    };
    if (settings.activeWorkspaceId === workspace.id) {
      changes.activeWorkspaceId = null;
    }

    await persistWorkspaceChange(changes, removal);

    return { removed: true, refs: [], failedAlias: null, configError: null };
  };

  const remove = (workspaceId, payload) => withSettingsLock(() => removeWorkspace(workspaceId, payload));

  const activateWorkspace = async (payload) => {
    const { id: requestedId } = parseInput(activatePayloadSchema, payload);
    const settings = await readSettings();
    if (requestedId === null) {
      // Clears the filter only; projects, sessions and config stay untouched.
      await persistSettings({ activeWorkspaceId: null });
      return { activeWorkspaceId: null };
    }

    const workspace = storedWorkspaces(settings.workspaces)
      .find((candidate) => candidate.id === requestedId) || null;
    if (!workspace) {
      throw new WorkspaceRequestError(404, 'Workspace not found');
    }

    const projects = sanitizeProjects(settings.projects) || [];
    if (!projects.some((project) => project.id === workspace.primaryProjectId)) {
      throw invalid({ id: 'The workspace primary project is not available' });
    }

    await persistSettings({
      activeWorkspaceId: workspace.id,
      activeProjectId: workspace.primaryProjectId,
    });
    return { activeWorkspaceId: workspace.id };
  };

  const activate = (payload) => withSettingsLock(() => activateWorkspace(payload));

  return { list, importDraft, configTarget, create, update, activate, remove, retryRefs, removeCreatedRefs };
};
