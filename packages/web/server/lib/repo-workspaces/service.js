/**
 * Multi-repo workspaces: the one owner that reads and writes `workspaces` and
 * `activeWorkspaceId` in the persisted settings document. It resolves projects
 * against the current catalog and registers a folder that is not a project yet
 * through the existing add-project path, never by writing settings itself.
 *
 * It also reads, but never writes, the primary's OpenCode `references`: each
 * expected alias is classified against the project config (ownership) and the
 * merged layers (conflict). Ticket 05 adds the write side.
 */
import path from 'node:path';
import { z } from 'zod';
import { resolveProjectForDirectory } from '../projects/add-project.js';

// Same OpenCode reference-key rule as the settings parser: no whitespace,
// `/`, backtick or comma, and no leading `@`.
const WORKSPACE_ALIAS_PATTERN = /^[^\s/`,@][^\s/`,]*$/;
const WORKSPACE_ID_PREFIX = 'ws_';

export class WorkspaceRequestError extends Error {
  constructor(status, message, fields = null) {
    super(message);
    this.name = 'WorkspaceRequestError';
    this.status = status;
    this.fields = fields;
  }
}

const invalid = (fields) => new WorkspaceRequestError(422, 'Workspace is invalid', fields);

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

const createWorkspaceSchema = z.object({
  name: z.string({ error: 'Name is required' }).trim().min(1, 'Name is required'),
  repos: z.array(createRepoSchema, { error: 'At least one repository is required' }).min(1, 'At least one repository is required'),
}).superRefine((payload, ctx) => {
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
});

const activatePayloadSchema = z.object({
  id: z.union([z.string({ error: 'Workspace id is required' }).trim().min(1, 'Workspace id is required'), z.null()], {
    error: 'Workspace id is required',
  }),
});

const activeWorkspaceIdSchema = z.union([z.null(), z.string().trim().min(1)]);

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
        fields[`${field}.projectId`] = 'Project not found';
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
  // The value ticket 05 will write: absolute and normalized, so it never
  // depends on the config file's directory.
  path: reference.path,
  description: reference.description,
  status: state.status,
  owned: reference.owned,
  current: state.current,
});

/**
 * Reads the primary's config once and classifies every expected reference.
 * Ownership is the project layer only; the merged layers only reveal an alias
 * another layer also defines. Any layer parse error makes the conflict state
 * untrustworthy, so every ref is `unknown` and the first error is reported once.
 */
const readWorkspaceRefs = ({ workspace, projectsById, readConfigLayers, getLayerError, getProjectConfigPath }) => {
  const primaryProject = projectsById.get(workspace.primaryProjectId) ?? null;
  const expected = workspace.repos
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
  const failedLayer = getLayerError(layers, projectConfigPath) ?? layers.layerErrors?.[0] ?? null;
  const error = failedLayer ? { path: failedLayer.path, message: failedLayer.message } : null;

  const refs = expected.map((reference) => {
    if (failedLayer) {
      return describeReference(reference, { status: 'unknown', current: null });
    }
    if (!reference.project) {
      return describeReference(reference, { status: 'missing', current: null });
    }

    const inProject = layerDefinesAlias(layers.projectConfig, reference.alias);
    const inOtherLayer = [layers.userConfig, layers.userOverrideConfig, layers.customConfig]
      .some((layer) => layerDefinesAlias(layer, reference.alias));

    if (inProject && inOtherLayer) {
      return describeReference(reference, {
        status: 'overridden',
        current: currentReferenceValue(referencesOf(layers.projectConfig)[reference.alias]),
      });
    }
    if (inProject) {
      const current = currentReferenceValue(referencesOf(layers.projectConfig)[reference.alias]);
      return describeReference(reference, {
        status: referenceMatches(current, reference) ? 'ok' : 'different',
        current,
      });
    }
    if (inOtherLayer) {
      return describeReference(reference, {
        status: 'outside',
        current: currentReferenceValue(referencesOf(layers.mergedConfig)?.[reference.alias]),
      });
    }
    return describeReference(reference, { status: 'missing', current: null });
  });

  return { refs, error };
};

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
    getLayerError,
    getProjectConfigPath,
  } = dependencies;

  const storedWorkspaces = (value) => sanitizeRepoWorkspaces(value)?.workspaces ?? [];

  const refsFor = (workspace, projects) => readWorkspaceRefs({
    workspace,
    projectsById: new Map(projects.map((project) => [project.id, project])),
    readConfigLayers,
    getLayerError,
    getProjectConfigPath,
  });

  const list = async () => {
    const settings = await readSettings();
    const parsed = sanitizeRepoWorkspaces(settings.workspaces);
    const activeWorkspaceId = activeWorkspaceIdSchema.safeParse(settings.activeWorkspaceId);
    const projects = sanitizeProjects(settings.projects) || [];
    const projectsById = new Map(projects.map((project) => [project.id, project]));

    const workspaces = (parsed?.workspaces ?? []).map((workspace) => ({
      ...workspace,
      repos: workspace.repos.map((repo) => {
        const project = projectsById.get(repo.projectId) || null;
        return {
          ...repo,
          missing: project === null,
          project: project ? { id: project.id, path: project.path, label: project.label ?? '' } : null,
        };
      }),
    }));
    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId.data) ?? null;
    const { refs, error: refsError } = activeWorkspace
      ? refsFor(activeWorkspace, projects)
      : { refs: [], error: null };

    return {
      workspaces,
      activeWorkspaceId: activeWorkspaceId.success ? activeWorkspaceId.data : null,
      // Invalid entries are dropped from this read only; the file is untouched.
      discarded: parsed?.discarded ?? 0,
      refs,
      refsError,
    };
  };

  const create = async (payload) => {
    const { name, repos: entries } = parseCreatePayload(payload);
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
    const { refs, error: refsError } = refsFor(workspace, nextProjects);
    return { workspace, refs, refsError };
  };

  const activate = async (payload) => {
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

  return { list, create, activate };
};
