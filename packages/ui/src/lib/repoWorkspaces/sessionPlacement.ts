import { normalizePath } from '@/lib/pathNormalization';

/**
 * The resolved workspace, narrowed to what placing a session needs. A repo
 * whose project left the catalog has no path and never matches.
 */
export type RepoWorkspaceSessionWorkspace = {
  primaryProjectId: string;
  repos: ReadonlyArray<{
    projectId: string;
    project: { path: string } | null;
  }>;
};

type RepoWorkspaceSessionProject = {
  id: string;
  path: string;
};

type Placement = 'primary' | 'secondary' | 'outside';

const isWithin = (directory: string, root: string): boolean => (
  directory === root || directory.startsWith(root.endsWith('/') ? root : `${root}/`)
);

/**
 * Which repo of the workspace holds this session. The deepest known project
 * root wins, so a repo or project nested under the primary stays its own repo
 * (and a nested project outside the workspace stays outside). A session
 * outside every repo, or no workspace at all, is `outside`.
 */
export const repoWorkspaceSessionPlacement = (
  workspace: RepoWorkspaceSessionWorkspace | null,
  directory: string | null,
  projects: readonly RepoWorkspaceSessionProject[] = [],
): Placement => {
  const target = normalizePath(directory);
  if (!workspace || !target) return 'outside';

  const roots = [
    ...projects.map((project) => ({ projectId: project.id, path: project.path })),
    ...workspace.repos.map((repo) => ({ projectId: repo.projectId, path: repo.project?.path ?? null })),
  ];
  let match: { projectId: string; rootLength: number } | null = null;
  for (const candidate of roots) {
    const root = normalizePath(candidate.path);
    if (!root || !isWithin(target, root)) continue;
    if (!match || root.length > match.rootLength) {
      match = { projectId: candidate.projectId, rootLength: root.length };
    }
  }

  if (!match || !workspace.repos.some((repo) => repo.projectId === match?.projectId)) return 'outside';
  return match.projectId === workspace.primaryProjectId ? 'primary' : 'secondary';
};
