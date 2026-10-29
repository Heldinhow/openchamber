import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from '../types';
import { pruneSessionTreeForSidebarQuery } from '../recent/activitySections';

/** What a workspace section row needs; never passed to a project-only control. */
export type WorkspaceSidebarIdentity = {
  id: string;
  name: string;
  directory: string;
};

export type WorkspaceSection = {
  workspace: WorkspaceSidebarIdentity;
  nodes: SessionNode[];
};

/** The section's own key space: never a project id, never a project control. */
export const workspaceSectionKey = (workspaceId: string): string => `workspace:${workspaceId}`;

type Args = {
  workspaces: readonly WorkspaceSidebarIdentity[];
  sessionsByWorkspace: ReadonlyMap<string, readonly Session[]>;
  buildNode: (session: Session) => SessionNode;
  /** Normalized, empty when the sidebar is not searching. */
  query: string;
};

/**
 * One top-level section per workspace, in the workspace list's order, above
 * the plain project sections. A workspace keeps its row with no sessions; a
 * search lists only the sections whose sessions match.
 */
export const buildWorkspaceSidebarSections = ({
  workspaces,
  sessionsByWorkspace,
  buildNode,
  query,
}: Args): WorkspaceSection[] => workspaces.flatMap((workspace) => {
  const nodes = (sessionsByWorkspace.get(workspace.id) ?? []).map(buildNode);
  if (!query) return [{ workspace, nodes }];
  const matching = nodes.flatMap((node) => {
    const pruned = pruneSessionTreeForSidebarQuery(node, query);
    return pruned ? [pruned] : [];
  });
  return matching.length > 0 ? [{ workspace, nodes: matching }] : [];
});
