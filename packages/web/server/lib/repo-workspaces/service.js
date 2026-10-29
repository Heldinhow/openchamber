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
/** New ids are hex; stored legacy ids were `ws_<uuid>`. Nothing else may name a directory. */
const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9-]+$/;
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

const storedWorkspaces = (value, sanitizeRepoWorkspaces) => {
  const result = sanitizeRepoWorkspaces(value) ?? { workspaces: [], discarded: 0 };
  // Defense in depth: an id that can escape `<data>/workspaces/` never reaches
  // a path, even if a caller injects a sanitizer that keeps it.
  const workspaces = result.workspaces.filter((workspace) => WORKSPACE_ID_PATTERN.test(workspace.id));
  return { workspaces, discarded: result.discarded + result.workspaces.length - workspaces.length };
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

  const workspaceDirectory = (workspaceId) => {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new WorkspaceRequestError(404, 'Workspace not found');
    }
    return path.resolve(openchamberDataDir, 'workspaces', workspaceId);
  };
  const neutralConfigPath = (workspaceId) => path.join(
    workspaceDirectory(workspaceId),
    NEUTRAL_CONFIG_DIR,
    NEUTRAL_CONFIG_FILE,
  );

  /**
   * A missing file is not an error: a legacy workspace has no neutral config
   * yet, and `list` creates one. A file that exists but cannot be read or
   * parsed is an error and is never overwritten.
   */
  const readNeutralConfig = async (targetPath) => {
    try {
      await fsPromises.stat(targetPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { config: null, missing: true, error: null };
      return {
        config: null,
        missing: false,
        error: { path: targetPath, message: 'Failed to read the workspace configuration' },
      };
    }
    try {
      return { config: readConfigFile(targetPath), missing: false, error: null };
    } catch {
      return {
        config: null,
        missing: false,
        error: { path: targetPath, message: 'Failed to read the workspace configuration' },
      };
    }
  };

  const resolveWorkspace = async (workspace, projects, configWriteError = null) => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    const targetPath = neutralConfigPath(workspace.id);
    const { missing, error } = await readNeutralConfig(targetPath);
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
      configError: error ?? (missing ? configWriteError : null),
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
            resolved.push({ index, projectId: folder.projectId, path: null, label: '' });
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
        resolved.push({ index, projectId: project.id, path: validated.directory, label: projectLabel(project) });
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
      resolved.push({ index, projectId: result.project.id, path: result.path, label: projectLabel(result.project) });
    }

    if (Object.keys(fields).length > 0) throw invalid(fields);

    // Duplicates are a user mistake, not an entry to drop silently: reject the
    // later row so the dialog can point at it. The client catches the common
    // case before the request; this is the trust-boundary check.
    const seenPaths = new Map();
    const seenProjectIds = new Map();
    for (const row of resolved) {
      if (seenProjectIds.has(row.projectId)) {
        fields[`folders[${row.index}].projectId`] = 'This project is already in the workspace';
      } else {
        seenProjectIds.set(row.projectId, row.index);
      }
      if (row.path !== null) {
        if (seenPaths.has(row.path)) {
          fields[`folders[${row.index}].path`] = 'This folder is already in the workspace';
        } else {
          seenPaths.set(row.path, row.index);
        }
      }
    }
    if (Object.keys(fields).length > 0) throw invalid(fields);

    return {
      projects,
      members: resolved.map(({ index: _index, ...row }) => row),
      projectIds: resolved.map((row) => row.projectId),
    };
  };

  /** The stored project order resolved for the neutral config. */
  const membersForWorkspace = (workspace, projects) => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    return workspace.projectIds.map((projectId) => {
      const project = byId.get(projectId) ?? null;
      return {
        projectId,
        path: project?.path ?? null,
        label: project ? projectLabel(project) : '',
      };
    });
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
        const configuredPath = path.resolve(member.path);
        const referenceName = nextReferenceName(referenceNameFor(member.label, member.path), takenNames);
        takenNames.add(referenceName);
        references[referenceName] = {
          path: configuredPath,
          description: member.label || path.basename(member.path),
        };
        // OpenCode checks the canonical resource too; a symlinked project must
        // stay editable through either path.
        const permittedPaths = new Set([configuredPath]);
        try {
          const canonical = path.resolve(await fsPromises.realpath(configuredPath));
          if (canonical !== configuredPath) permittedPaths.add(canonical);
        } catch {
          // A missing folder is excluded from the config already; only the
          // configured path can match if it is readable later.
        }
        for (const permittedPath of permittedPaths) {
          permitted.push({
            action: 'edit',
            resource: `${permittedPath}/*`,
            effect: 'allow',
          });
        }
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
      const read = await readNeutralConfig(neutralConfigPath(workspace.id));
      // A legacy workspace has no neutral directory yet. Creating it on read is
      // what makes its stored projects usable without touching a repository.
      const configWriteError = read.missing
        ? await writeNeutralConfig(workspace.id, membersForWorkspace(workspace, projects))
        : null;
      workspaces.push(await resolveWorkspace(workspace, projects, configWriteError));
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
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new WorkspaceRequestError(404, 'Workspace not found');
    }
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
