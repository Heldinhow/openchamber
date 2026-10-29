import { rankByQuery } from '@/lib/search/fuzzySearch';

/**
 * The new-session picker's two groups. Search matches workspace names and
 * project names; a project match also surfaces every workspace that contains
 * that project, so a familiar project name finds the workspace it belongs to.
 * Projects keep the caller's order (the sidebar sort) inside each result.
 */
export const groupDraftTargetResults = <
  P extends { id: string },
  W extends { id: string; name: string },
>(
  workspaces: readonly W[],
  projects: readonly P[],
  query: string,
  projectTexts: (project: P) => ReadonlyArray<string | null | undefined>,
  workspaceProjectIds: (workspace: W) => readonly string[],
) => {
  const matchedProjects = rankByQuery(projects, query, projectTexts);
  if (!query.trim()) {
    return { workspaces: [...workspaces], projects: matchedProjects };
  }

  const matchedProjectIds = new Set(matchedProjects.map((project) => project.id));
  const rankedByName = rankByQuery(workspaces, query, (workspace) => [workspace.name]);
  const rankedIds = new Set(rankedByName.map((workspace) => workspace.id));
  const containingProject = workspaces.filter((workspace) => (
    workspaceProjectIds(workspace).some((projectId) => matchedProjectIds.has(projectId))
  ));

  return {
    workspaces: [...rankedByName, ...containingProject.filter((workspace) => !rankedIds.has(workspace.id))],
    projects: matchedProjects,
  };
};
