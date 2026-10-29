import { fetchRepoWorkspaces } from './client';

/** A workspace draft whose owner cannot be resolved; the send must not pick another directory. */
export class WorkspaceDraftTargetError extends Error {
  constructor() {
    super('The workspace for this session is no longer available.');
    this.name = 'WorkspaceDraftTargetError';
  }
}

type WorkspaceDraftLookup = {
  readWorkspaces: typeof fetchRepoWorkspaces;
};

const defaultLookup: WorkspaceDraftLookup = {
  readWorkspaces: fetchRepoWorkspaces,
};

/**
 * The neutral directory a workspace session runs in, read from the workspace
 * route so a workspace deleted while the catalog was not loaded fails here
 * instead of in a member project. Fetch failures propagate: a failed read is
 * not an empty workspace list.
 */
export const resolveWorkspaceDraftDirectory = async (
  workspaceId: string | null | undefined,
  lookup: WorkspaceDraftLookup = defaultLookup,
): Promise<string> => {
  if (!workspaceId) throw new WorkspaceDraftTargetError();
  const document = await lookup.readWorkspaces();
  const workspace = document.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new WorkspaceDraftTargetError();
  return workspace.directory;
};
