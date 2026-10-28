import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The route resolves every stored repo against the project catalog. A repo
 * whose project is gone keeps its row and is marked `missing`; the workspace
 * itself stays valid.
 */
const projectRefSchema = z.object({
  id: z.string().min(1),
  path: z.string(),
  label: z.string(),
});

const repoWorkspaceRepoSchema = z.object({
  projectId: z.string().min(1),
  alias: z.string().min(1),
  description: z.string().catch(''),
  branch: z.string().catch(''),
  missing: z.boolean().catch(false),
  project: projectRefSchema.nullable().catch(null),
});

const repoWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  primaryProjectId: z.string().min(1),
  repos: z.array(repoWorkspaceRepoSchema),
  createdRefs: z.array(z.string()).catch([]),
});

const repoWorkspacesDocumentSchema = z.object({
  workspaces: z.array(repoWorkspaceSchema),
  activeWorkspaceId: z.string().min(1).nullable().catch(null),
});

export type RepoWorkspaceResolved = z.infer<typeof repoWorkspaceSchema>;

/** The runtime has no `/api/workspaces` route, as on mobile and in VS Code. */
export class RepoWorkspacesUnavailableError extends Error {
  constructor() {
    super('Workspaces are not available in this runtime');
    this.name = 'RepoWorkspacesUnavailableError';
  }
}

const readJson = async (response: Response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const fetchRepoWorkspaces = async () => {
  const response = await runtimeFetch('/api/workspaces', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) {
    throw new RepoWorkspacesUnavailableError();
  }
  if (!response.ok) {
    throw new Error(`Workspaces request failed with ${response.status}`);
  }
  const parsed = repoWorkspacesDocumentSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspaces response was invalid');
  }
  return parsed.data;
};

const activeWorkspaceResponseSchema = z.object({
  activeWorkspaceId: z.string().min(1).nullable(),
});

export const activateRepoWorkspace = async (id: string | null): Promise<{ activeWorkspaceId: string | null }> => {
  const response = await runtimeFetch('/api/workspaces/active', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!response.ok) {
    throw new Error(`Workspace switch failed with ${response.status}`);
  }
  const parsed = activeWorkspaceResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspace switch response was invalid');
  }
  return parsed.data;
};
