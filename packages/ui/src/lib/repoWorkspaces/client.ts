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

export type RepoWorkspaceResolved = z.infer<typeof repoWorkspaceSchema>;

const referenceEntrySchema = z.object({
  path: z.string().nullable().catch(null),
  description: z.string().catch(''),
});

const referenceStatusSchema = z.enum(['ok', 'missing', 'different', 'outside', 'overridden', 'unknown']);

const repoWorkspaceRefSchema = z.object({
  alias: z.string(),
  path: z.string().nullable().catch(null),
  description: z.string().catch(''),
  status: referenceStatusSchema.catch('unknown'),
  owned: z.boolean().catch(false),
  current: referenceEntrySchema.nullable().catch(null),
});

export type RepoWorkspaceRef = z.infer<typeof repoWorkspaceRefSchema>;

const refsErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
}).nullable().catch(null);

const repoWorkspacesDocumentSchema = z.object({
  workspaces: z.array(repoWorkspaceSchema),
  activeWorkspaceId: z.string().min(1).nullable().catch(null),
  discarded: z.number().int().nonnegative().catch(0),
  refs: z.array(repoWorkspaceRefSchema).catch([]),
  refsError: refsErrorSchema,
});

const refWriteSchema = z.object({
  alias: z.string(),
  status: z.enum(['written', 'unchanged', 'failed']).catch('failed'),
  message: z.string().optional(),
});

const configTargetSchema = z.object({
  path: z.string(),
  rootConfigPath: z.string().nullable().catch(null),
});

const refsResultFields = {
  refs: z.array(repoWorkspaceRefSchema),
  refWrites: z.array(refWriteSchema),
  refsError: refsErrorSchema,
  configTarget: configTargetSchema,
};

const createRepoWorkspaceResultSchema = z.object({
  workspace: repoWorkspaceSchema,
  ...refsResultFields,
});

const updateRepoWorkspaceResultSchema = createRepoWorkspaceResultSchema;

const retryRepoWorkspaceRefsResultSchema = z.object(refsResultFields);

const requestErrorSchema = z.object({
  error: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  configError: z.object({ path: z.string(), message: z.string() }).optional(),
  conflict: z.object({
    alias: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    path: z.string().nullable().optional(),
  }).optional(),
});

export type RepoWorkspaceConfigTarget = z.infer<typeof configTargetSchema>;
export type CreateRepoWorkspaceResult = z.infer<typeof createRepoWorkspaceResultSchema>;
export type RetryRepoWorkspaceRefsResult = z.infer<typeof retryRepoWorkspaceRefsResultSchema>;

/**
 * A deletion that could not remove every owned reference answers `removed:
 * false` and names the alias; the workspace is still there.
 */
const deleteRepoWorkspaceResultSchema = z.object({
  removed: z.boolean(),
  refs: z.array(repoWorkspaceRefSchema).catch([]),
  failedAlias: z.string().nullable().catch(null),
  configError: refsErrorSchema,
});

export type DeleteRepoWorkspaceResult = z.infer<typeof deleteRepoWorkspaceResultSchema>;

/** A 4xx answer with the field, config or conflict the dialog puts inline. */
export class RepoWorkspaceRequestError extends Error {
  readonly status: number;
  readonly fields: Record<string, string>;
  readonly configError: { path: string; message: string } | null;
  readonly conflict: { alias: string | null; aliases: string[]; path: string | null } | null;

  constructor(status: number, payload: z.infer<typeof requestErrorSchema> | null) {
    super(payload?.error ?? `Workspace request failed with ${status}`);
    this.name = 'RepoWorkspaceRequestError';
    this.status = status;
    this.fields = payload?.fields ?? {};
    this.configError = payload?.configError ?? null;
    this.conflict = payload?.conflict
      ? {
        alias: payload.conflict.alias ?? null,
        aliases: payload.conflict.aliases ?? [],
        path: payload.conflict.path ?? null,
      }
      : null;
  }
}

const requestFailure = async (response: Response) => {
  const parsed = requestErrorSchema.safeParse(await readJson(response));
  return new RepoWorkspaceRequestError(response.status, parsed.success ? parsed.data : null);
};

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

export type CreateRepoWorkspaceInput = {
  name: string;
  repos: Array<{
    alias: string;
    path: string;
    branch: string;
    primary: boolean;
  }>;
};

/**
 * Creates and activates the workspace. The response names the config target and
 * one write result per alias; a failed write is a pending reference, not a
 * failed creation.
 */
export const createRepoWorkspace = async (input: CreateRepoWorkspaceInput): Promise<CreateRepoWorkspaceResult> => {
  const response = await runtimeFetch('/api/workspaces', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await requestFailure(response);
  const parsed = createRepoWorkspaceResultSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspace creation response was invalid');
  }
  return parsed.data;
};

export type UpdateRepoWorkspaceInput = {
  name: string;
  repos: Array<{
    alias: string;
    branch: string;
    primary: boolean;
    projectId?: string;
    path?: string;
  }>;
  confirmRefs?: string[];
  keepRefs?: string[];
};

/** Applies the new repo set; a failed removal is a 409 and keeps the workspace. */
export const updateRepoWorkspace = async (
  id: string,
  input: UpdateRepoWorkspaceInput,
): Promise<CreateRepoWorkspaceResult> => {
  const response = await runtimeFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await requestFailure(response);
  const parsed = updateRepoWorkspaceResultSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspace update response was invalid');
  }
  return parsed.data;
};

/** Retries the named pending aliases; the route only rewrites what is not `ok`. */
export const retryRepoWorkspaceRefs = async (id: string, aliases?: string[]): Promise<RetryRepoWorkspaceRefsResult> => {
  const response = await runtimeFetch(`/api/workspaces/${encodeURIComponent(id)}/refs/retry`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(aliases ? { aliases } : {}),
  });
  if (!response.ok) throw await requestFailure(response);
  const parsed = retryRepoWorkspaceRefsResultSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspace reference retry response was invalid');
  }
  return parsed.data;
};

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

/**
 * Deletes the workspace; the owned references leave only when asked. A failed
 * removal comes back as `removed: false` with the alias, never as a lost
 * workspace.
 */
export const deleteRepoWorkspace = async (
  id: string,
  removeCreatedRefs: boolean,
): Promise<DeleteRepoWorkspaceResult> => {
  const response = await runtimeFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeCreatedRefs }),
  });
  if (!response.ok) throw await requestFailure(response);
  const parsed = deleteRepoWorkspaceResultSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new Error('Workspace deletion response was invalid');
  }
  return parsed.data;
};
