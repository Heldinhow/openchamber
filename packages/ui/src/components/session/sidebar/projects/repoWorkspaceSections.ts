import type { Session } from '@/lib/opencode/model';

/**
 * One repo of a workspace, as the sidebar needs it. Structurally satisfied by
 * both the settings parser (`RepoWorkspace`) and the resolved route payload.
 */
export type RepoWorkspaceSummary = {
  id: string;
  name: string;
  primaryProjectId: string;
  repos: ReadonlyArray<{
    projectId: string;
    alias: string;
    description: string;
    branch: string;
  }>;
};

export type RepoWorkspaceSidebarProject = {
  id: string;
  path: string;
  label?: string;
  normalizedPath: string;
  icon?: string;
  color?: string;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  iconBackground?: string;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
};

/** The existing Git store state for a project, read without a new request. */
export type RepoWorkspaceGit = {
  isRepo: boolean | null;
  branch: string | null;
  /** Changed files; `null` while the status has not arrived. */
  changes: number | null;
};

type RepoWorkspaceSidebarSection = {
  /** A placeholder project (`missing`) keeps the row in the list. */
  project: RepoWorkspaceSidebarProject;
  repo: { alias: string; description: string; branch: string } | null;
  primary: boolean;
  showSessions: boolean;
  showNewSession: boolean;
  /** The saved branch snapshot, shown only when it differs from `main`. */
  branchChip: string | null;
  git: RepoWorkspaceGit | null;
  missing: boolean;
  sessions: Session[];
};

type Args = {
  workspaces: readonly RepoWorkspaceSummary[];
  projects: readonly RepoWorkspaceSidebarProject[];
  /**
   * Sessions already owned by each project (the sidebar's ownership index).
   * The projection never re-derives ownership from paths.
   */
  sessions: ReadonlyMap<string, readonly Session[]>;
  activeWorkspaceId: string | null;
  gitByProject: ReadonlyMap<string, RepoWorkspaceGit>;
};

const missingProject = (repo: RepoWorkspaceSummary['repos'][number]): RepoWorkspaceSidebarProject => ({
  id: repo.projectId,
  path: '',
  label: repo.alias,
  normalizedPath: '',
});

const branchChipOf = (branch: string): string | null => {
  const trimmed = branch.trim();
  return trimmed.length > 0 && trimmed !== 'main' ? trimmed : null;
};

type RepoWorkspaceSidebarProjection = {
  activeWorkspace: RepoWorkspaceSummary | null;
  sections: RepoWorkspaceSidebarSection[];
};

/**
 * The single place that turns the active workspace into sidebar sections.
 * Without one the current grouping passes through unchanged, in the order the
 * caller already sorted the projects. With one, its repos come first, and every
 * other project follows as a plain section, in that same order.
 */
export const projectRepoWorkspaceSidebar = ({
  workspaces,
  projects,
  sessions,
  activeWorkspaceId,
  gitByProject,
}: Args): RepoWorkspaceSidebarProjection => {
  const activeWorkspace = activeWorkspaceId
    ? workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
    : null;
  const plainSection = (project: RepoWorkspaceSidebarProject): RepoWorkspaceSidebarSection => ({
    project,
    repo: null,
    primary: false,
    showSessions: true,
    showNewSession: true,
    branchChip: null,
    git: null,
    missing: false,
    sessions: [...(sessions.get(project.id) ?? [])],
  });

  if (!activeWorkspace) {
    return { activeWorkspace: null, sections: projects.map(plainSection) };
  }

  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const repoProjectIds = new Set(activeWorkspace.repos.map((repo) => repo.projectId));

  return {
    activeWorkspace,
    sections: [...activeWorkspace.repos.map((repo): RepoWorkspaceSidebarSection => {
      const project = projectsById.get(repo.projectId) ?? null;
      const primary = repo.projectId === activeWorkspace.primaryProjectId;
      return {
        project: project ?? missingProject(repo),
        repo: { alias: repo.alias, description: repo.description, branch: repo.branch },
        primary,
        showSessions: primary,
        showNewSession: primary,
        branchChip: branchChipOf(repo.branch),
        git: project ? gitByProject.get(project.id) ?? null : null,
        missing: project === null,
        sessions: primary ? [...(sessions.get(repo.projectId) ?? [])] : [],
      };
    }), ...projects.filter((project) => !repoProjectIds.has(project.id)).map(plainSection)],
  };
};

/** Clicking the active workspace again leaves the filter, as "All projects" does. */
export const nextActiveWorkspaceId = (clickedWorkspaceId: string | null, activeWorkspaceId: string | null): string | null => (
  clickedWorkspaceId === activeWorkspaceId ? null : clickedWorkspaceId
);
