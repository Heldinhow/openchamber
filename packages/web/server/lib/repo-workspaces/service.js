/**
 * Multi-repo workspaces: the one owner that reads and writes `workspaces` and
 * `activeWorkspaceId` in the persisted settings document. It resolves projects
 * against the current catalog and registers a folder that is not a project yet
 * through the existing add-project path, never by writing settings itself.
 *
 * Nothing here touches OpenCode's `references`; ticket 04 adds the read side
 * and ticket 05 the write side.
 */
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

export const createWorkspaceService = (dependencies) => {
  const {
    readSettings,
    persistSettings,
    sanitizeProjects,
    sanitizeRepoWorkspaces,
    validateDirectoryPath,
    fsPromises,
    crypto,
  } = dependencies;

  const storedWorkspaces = (value) => sanitizeRepoWorkspaces(value)?.workspaces ?? [];

  const list = async () => {
    const settings = await readSettings();
    const parsed = sanitizeRepoWorkspaces(settings.workspaces);
    const activeWorkspaceId = activeWorkspaceIdSchema.safeParse(settings.activeWorkspaceId);
    const projectsById = new Map((sanitizeProjects(settings.projects) || []).map((project) => [project.id, project]));

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

    return {
      workspaces,
      activeWorkspaceId: activeWorkspaceId.success ? activeWorkspaceId.data : null,
      // Invalid entries are dropped from this read only; the file is untouched.
      discarded: parsed?.discarded ?? 0,
      // The reference states arrive in ticket 04.
      refs: [],
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
    return { workspace, refs: [] };
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
