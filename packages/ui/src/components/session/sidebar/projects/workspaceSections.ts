import type { Session } from '@/lib/opencode/model';
import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import type { SessionNode } from '../types';
import { pruneSessionTreeForSidebarQuery } from '../recent/activitySections';

/** What a workspace section row needs; never passed to a project-only control. */
export type WorkspaceSidebarIdentity = {
  id: string;
  name: string;
  directory: string;
  /** A neutral config that exists but cannot be read; shown on the row. */
  configError?: { path: string; message: string } | null;
  /** The projects the workspace contains, for search by a familiar project. */
  projects?: readonly {
    projectId: string;
    /** Null when the project left the catalog; it cannot match a search. */
    project: { label: string; path: string } | null;
  }[];
};

export type WorkspaceSection = {
  workspace: WorkspaceSidebarIdentity;
  nodes: SessionNode[];
  /** The workspace itself matched through its name or a member project. */
  metadataMatch?: boolean;
};

/** The section's own key space: never a project id, never a project control. */
export const workspaceSectionKey = (workspaceId: string): string => `workspace:${workspaceId}`;

type Args = {
  workspaces: readonly WorkspaceSidebarIdentity[];
  sessionsByWorkspace: ReadonlyMap<string, readonly Session[]>;
  /** Sessions the sidebar nests under another one; only roots open a tree. */
  nestedSessionIds: ReadonlySet<string>;
  buildNode: (session: Session) => SessionNode;
  /** Normalized, empty when the sidebar is not searching. */
  query: string;
};

const matchesWorkspaceSearch = (workspace: WorkspaceSidebarIdentity, query: string): boolean => (
  workspace.name.toLowerCase().includes(query)
  || (workspace.projects ?? []).some(({ project }) => Boolean(
    project && matchesRankQuery([project.label, project.path], query),
  ))
);

/**
 * One top-level section per workspace, in the workspace list's order, above
 * the plain project sections. A workspace keeps its row with no sessions; a
 * search matches the workspace's name or a member project and then shows all
 * its sessions, or lists the sessions that match by title.
 */
export const buildWorkspaceSidebarSections = ({
  workspaces,
  sessionsByWorkspace,
  nestedSessionIds,
  buildNode,
  query,
}: Args): WorkspaceSection[] => workspaces.flatMap((workspace) => {
  const nodes = (sessionsByWorkspace.get(workspace.id) ?? [])
    .filter((session) => !nestedSessionIds.has(session.id))
    .map(buildNode);
  if (!query) return [{ workspace, nodes }];
  if (matchesWorkspaceSearch(workspace, query)) return [{ workspace, nodes, metadataMatch: true }];
  const matching = nodes.flatMap((node) => {
    const pruned = pruneSessionTreeForSidebarQuery(node, query);
    return pruned ? [pruned] : [];
  });
  return matching.length > 0 ? [{ workspace, nodes: matching }] : [];
});
