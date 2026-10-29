/**
 * Multi-repo workspaces: a named list of projects whose sessions run in a
 * neutral directory owned by OpenChamber. This module is the only writer of
 * the `workspaces` settings field and of `<OPENCHAMBER_DATA_DIR>/workspaces/`.
 * It never writes into a member repository.
 *
 * A folder that is not a project yet is registered through the shared
 * add-project rule in `../projects/add-project.js` and stored in the same
 * settings write as the workspace.
 */
import path from 'node:path';
import { z } from 'zod';
import { resolveProjectForDirectory } from '../projects/add-project.js';

const WORKSPACE_ID_PREFIX = 'ws_';
const NEUTRAL_CONFIG_DIR = '.opencode';
const NEUTRAL_CONFIG_FILE = 'opencode.json';

export class WorkspaceRequestError extends Error {
  constructor(status, message, { fields = null } = {}) {
    super(message);
    this.name = 'WorkspaceRequestError';
    this.status = status;
    this.fields = fields;
  }
}

const folderSchema = z.object({
  projectId: z.string({ error: 'Project id must be text' }).trim().min(1, 'Project id must not be empty').optional(),
  path: z.string({ error: 'Folder path must be text' }).trim().min(1, 'Folder path must not be empty').optional(),
});

const workspacePayloadSchema = z.object({
  name: z.string({ error: 'Name is required' }).trim().min(1, 'Name is required'),
  folders: z.array(folderSchema, { error: 'At least one folder is required' })
    .min(1, 'At least one folder is required'),
}).superRefine((payload, ctx) => {
  payload.folders.forEach((folder, index) => {
    if ((folder.projectId === undefined) === (folder.path === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['folders', index, 'path'],
        message: folder.projectId === undefined
          ? 'A registered project or a folder path is required'
          : 'Provide either a project id or a folder path, not both',
      });
    }
  });
});

const invalid = (fields) => new WorkspaceRequestError(422, 'Workspace is invalid', { fields });

const fieldKey = (segments) => segments.reduce(
  (key, segment) => (Number.isInteger(segment) ? `${key}[${segment}]` : (key ? `${key}.${segment}` : `${segment}`)),
  '',
);

const parsePayload = (payload) => {
  const parsed = workspacePayloadSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const fields = {};
  for (const issue of parsed.error.issues) {
    const key = fieldKey(issue.path) || 'workspace';
    if (!fields[key]) fields[key] = issue.message;
  }
  throw invalid(fields);
};

/** Reference keys: no whitespace, `/`, backtick or comma, and no leading `@`. */
const referenceNameFor = (value, folderPath) => {
  const base = (value || '').trim() || path.basename(folderPath);
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-.]+$/, '');
  return cleaned || 'project';
};

const nextReferenceName = (base, taken) => {
  let name = base;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  return name;
};

const projectLabel = (project) => project.label?.trim() || '';

const storedWorkspaces = (value, sanitizeRepoWorkspaces) => (
  sanitizeRepoWorkspaces(value) ?? { workspaces: [], discarded: 0 }
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
    readConfigFile,
    writeConfig,
    openchamberDataDir,
  } = dependencies;

  let settingsQueue = Promise.resolve();
  // Read-to-persist is one critical section: two saves that each build their
  // list from the same snapshot would otherwise drop one workspace.
  const withSettingsLock = (task) => {
    const run = settingsQueue.then(task, task);
    settingsQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  const workspaceDirectory = (workspaceId) => path.resolve(openchamberDataDir, 'workspaces', workspaceId);
  const neutralConfigPath = (workspaceId) => path.join(
    workspaceDirectory(workspaceId),
    NEUTRAL_CONFIG_DIR,
    NEUTRAL_CONFIG_FILE,
  );

  const readNeutralConfig = async (targetPath) => {
    try {
      await fsPromises.stat(targetPath);
      // The writer is the only one that should touch this file, but a user can
      // still edit it. A parse failure is an error for this workspace.
      const config = readConfigFile(targetPath);
      return { config, error: null };
    } catch {
      return { config: null, error: { path: targetPath, message: 'Failed to read the workspace configuration' } };
    }
  };

  const resolveWorkspace = async (workspace, projects) => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    const targetPath = neutralConfigPath(workspace.id);
    const { error } = await readNeutralConfig(targetPath);
    return {
      id: workspace.id,
      name: workspace.name,
      directory: workspaceDirectory(workspace.id),
      projects: workspace.projectIds.map((projectId) => {
        const project = byId.get(projectId) ?? null;
        return {
          projectId,
          missing: project === null,
          project: project ? { id: project.id, path: project.path, label: projectLabel(project) } : null,
        };
      }),
      configError: error,
    };
  };

  /**
   * Resolve every row before anything is saved. A folder that does not exist
   * or cannot be read fails the request; a project id already stored for this
   * workspace may stay even when the catalog lost it, so an unrelated rename
   * does not delete the missing row.
   */
  const resolveFolders = async (folders, settings, keepMissingProjectIds) => {
    let projects = sanitizeProjects(settings.projects) || [];
    const resolved = [];
    const fields = {};

    for (const [index, folder] of folders.entries()) {
      if (folder.projectId !== undefined) {
        const project = projects.find((candidate) => candidate.id === folder.projectId) ?? null;
        if (!project) {
          if (keepMissingProjectIds.has(folder.projectId)) {
            resolved.push({ projectId: folder.projectId, path: null, label: '' });
            continue;
          }
          fields[`folders[${index}].projectId`] = 'Project not found';
          continue;
        }
        const validated = await validateDirectoryPath(project.path);
        if (!validated.ok) {
          fields[`folders[${index}].projectId`] = validated.error || 'Folder is not available';
          continue;
        }
        resolved.push({ projectId: project.id, path: validated.directory, label: projectLabel(project) });
        continue;
      }

      const result = await resolveProjectForDirectory({
        requestedPath: folder.path,
        create: false,
        readExistingProjects: async () => projects,
        fsPromises,
        validateDirectoryPath,
      });
      if (!result.ok) {
        fields[`folders[${index}].path`] = result.error || 'Folder is not available';
        continue;
      }
      projects = result.projects;
      resolved.push({ projectId: result.project.id, path: result.path, label: projectLabel(result.project) });
    }

    if (Object.keys(fields).length > 0) throw invalid(fields);

    const seenPaths = new Set();
    const seenProjectIds = new Set();
    const members = [];
    for (const row of resolved) {
      if (seenProjectIds.has(row.projectId)) continue;
      if (row.path !== null) {
        if (seenPaths.has(row.path)) continue;
        seenPaths.add(row.path);
      }
      seenProjectIds.add(row.projectId);
      members.push(row);
    }

    return { projects, members, projectIds: members.map((member) => member.projectId) };
  };

  /** Absolute references and edit allow rules for every available member. */
  const writeNeutralConfig = async (workspaceId, members) => {
    const targetPath = neutralConfigPath(workspaceId);
    try {
      await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
      const existing = readConfigFile(targetPath);
      const references = {};
      const permitted = [];
      const takenNames = new Set();
      for (const member of members) {
        if (!member.path) continue;
        const referenceName = nextReferenceName(referenceNameFor(member.label, member.path), takenNames);
        takenNames.add(referenceName);
        references[referenceName] = {
          path: path.resolve(member.path),
          description: member.label || path.basename(member.path),
        };
        permitted.push({
          action: 'edit',
          resource: `${path.resolve(member.path)}/*`,
          effect: 'allow',
        });
      }
      await writeConfig({ ...existing, references, permissions: permitted }, targetPath);
      return null;
    } catch {
      return { path: targetPath, message: 'Failed to write the workspace configuration' };
    }
  };

  const list = async () => {
    const settings = await readSettings();
    const projects = sanitizeProjects(settings.projects) || [];
    const stored = storedWorkspaces(settings.workspaces, sanitizeRepoWorkspaces);
    const workspaces = [];
    for (const workspace of stored.workspaces) {
      workspaces.push(await resolveWorkspace(workspace, projects));
    }
    return { workspaces, discarded: stored.discarded };
  };

  const create = async (payload) => withSettingsLock(async () => {
    const input = parsePayload(payload ?? {});
    const settings = await readSettings();
    const resolved = await resolveFolders(input.folders, settings, new Set());
    const stored = storedWorkspaces(settings.workspaces, sanitizeRepoWorkspaces);
    const workspace = {
      id: `${WORKSPACE_ID_PREFIX}${crypto.randomUUID().replace(/-/g, '')}`,
      name: input.name,
      projectIds: resolved.projectIds,
    };

    await persistSettings({
      projects: resolved.projects,
      workspaces: [...stored.workspaces, workspace],
    });

    const configError = await writeNeutralConfig(workspace.id, resolved.members);
    return { workspace: await resolveWorkspace(workspace, resolved.projects), configError };
  });

  const update = async (workspaceId, payload) => withSettingsLock(async () => {
    const input = parsePayload(payload ?? {});
    const settings = await readSettings();
    const stored = storedWorkspaces(settings.workspaces, sanitizeRepoWorkspaces);
    const existing = stored.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
    if (!existing) throw new WorkspaceRequestError(404, 'Workspace not found');

    const resolved = await resolveFolders(input.folders, settings, new Set(existing.projectIds));
    const workspace = { id: existing.id, name: input.name, projectIds: resolved.projectIds };

    await persistSettings({
      projects: resolved.projects,
      workspaces: stored.workspaces.map((entry) => (entry.id === workspace.id ? workspace : entry)),
    });

    const configError = await writeNeutralConfig(workspace.id, resolved.members);
    return { workspace: await resolveWorkspace(workspace, resolved.projects), configError };
  });

  return { list, create, update };
};
