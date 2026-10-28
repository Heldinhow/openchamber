/**
 * The one add-project path: a folder that already names a project is reused,
 * a new folder gets the id derived from its resolved path. Callers own the
 * settings write, so a workspace can register a folder and store the workspace
 * in the same update instead of exposing a half-created project.
 */
import path from 'node:path';
import { createProjectIdFromPath } from './project-id.js';

export const resolveProjectForDirectory = async ({
  requestedPath,
  create = false,
  readExistingProjects,
  fsPromises,
  validateDirectoryPath,
}) => {
  if (!requestedPath) {
    return { ok: false, error: 'Path is required' };
  }

  if (create) {
    await fsPromises.mkdir(path.resolve(requestedPath), { recursive: true });
  }

  const validated = await validateDirectoryPath(requestedPath);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const resolvedPath = validated.directory;
  const existingProjects = await readExistingProjects();
  const existing = existingProjects.find((project) => project.path === resolvedPath) || null;
  const project = existing ?? {
    id: createProjectIdFromPath(resolvedPath),
    path: resolvedPath,
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };

  return {
    ok: true,
    path: resolvedPath,
    project,
    projects: existing ? existingProjects : [...existingProjects, project],
  };
};
