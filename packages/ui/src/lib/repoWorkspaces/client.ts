import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The route resolves every stored project against the project catalog. A
 * project whose entry is gone keeps its row and is marked `missing`; the
 * workspace itself stays valid.
 */
const projectRefSchema = z.object({
  id: z.string().min(1),
  path: z.string(),
  label: z.string(),
});

const workspaceProjectSchema = z.object({
  projectId: z.string().min(1),
  missing: z.boolean().catch(false),
  project: projectRefSchema.nullable().catch(null),
});

const configErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
}).nullable().catch(null);

const repoWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  directory: z.string().min(1),
  projects: z.array(workspaceProjectSchema),
  configError: configErrorSchema,
});

export type RepoWorkspaceResolved = z.infer<typeof repoWorkspaceSchema>;

const repoWorkspacesDocumentSchema = z.object({
  workspaces: z.array(repoWorkspaceSchema),
  discarded: z.number().int().nonnegative().catch(0),
});

type RepoWorkspacesDocument = z.infer<typeof repoWorkspacesDocumentSchema>;

const createResultSchema = z.object({
  workspace: repoWorkspaceSchema,
  /** Best effort after the save: only a failure changes what the user sees. */
  configError: configErrorSchema,
});

export type RepoWorkspaceSaveResult = z.infer<typeof createResultSchema>;

const requestErrorSchema = z.object({
  error: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
});

/** A 4xx answer with the field the dialog puts inline. */
export class RepoWorkspaceRequestError extends Error {
  readonly status: number;
  readonly fields: Record<string, string>;

  constructor(status: number, payload: z.infer<typeof requestErrorSchema> | null) {
    super(payload?.error ?? `Workspace request failed with ${status}`);
    this.name = 'RepoWorkspaceRequestError';
    this.status = status;
    this.fields = payload?.fields ?? {};
  }
}

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

const requestFailure = async (response: Response) => {
  const parsed = requestErrorSchema.safeParse(await readJson(response));
  return new RepoWorkspaceRequestError(response.status, parsed.success ? parsed.data : null);
};

export const fetchRepoWorkspaces = async (): Promise<RepoWorkspacesDocument> => {
  const response = await runtimeFetch('/api/workspaces', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) throw new RepoWorkspacesUnavailableError();
  if (!response.ok) throw await requestFailure(response);
  const parsed = repoWorkspacesDocumentSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspaces response was invalid');
  }
  return parsed.data;
};

/** A folder row: a path the user picked, or a project the catalog already has. */
export type RepoWorkspaceFolderInput = {
  path?: string;
  projectId?: string;
};

type SaveRepoWorkspaceInput = {
  name: string;
  folders: RepoWorkspaceFolderInput[];
};export const createRepoWorkspace = async (input: SaveRepoWorkspaceInput): Promise<RepoWorkspaceSaveResult> => {
  const response = await runtimeFetch('/api/workspaces', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await requestFailure(response);
  const parsed = createResultSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspace creation response was invalid');
  }
  return parsed.data;
};

export const updateRepoWorkspace = async (
  id: string,
  input: SaveRepoWorkspaceInput,
): Promise<RepoWorkspaceSaveResult> => {
  const response = await runtimeFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await requestFailure(response);
  const parsed = createResultSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspace update response was invalid');
  }
  return parsed.data;
};
