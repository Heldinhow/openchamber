import { normalizePath } from '@/lib/pathNormalization';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';

export type RepoWorkspaceDraftRow = {
  key: string;
  path: string;
  alias: string;
  /** An existing repo keeps its catalog id; a new folder only carries a path. */
  projectId?: string;
  /** The project left the catalog: the id is kept and the path is unknown. */
  missing?: boolean;
  /** The saved branch snapshot, used until live git status answers. */
  branch?: string;
};

export type RepoWorkspaceDraft = {
  name: string;
  rows: RepoWorkspaceDraftRow[];
  primaryKey: string | null;
};

const normalizedRowPath = (path: string): string => normalizePath(path) ?? path.trim();

/** The edit dialog opens on exactly the saved workspace. */
export const draftFromWorkspace = (workspace: RepoWorkspaceResolved): RepoWorkspaceDraft => {
  const rows: RepoWorkspaceDraftRow[] = workspace.repos.map((repo, index) => ({
    key: `repo-${index}`,
    path: repo.project ? (normalizePath(repo.project.path) ?? repo.project.path) : '',
    alias: repo.alias,
    projectId: repo.projectId,
    missing: repo.missing,
    branch: repo.branch,
  }));
  const primaryIndex = workspace.repos.findIndex((repo) => repo.projectId === workspace.primaryProjectId);
  return {
    name: workspace.name,
    rows,
    primaryKey: rows[primaryIndex]?.key ?? rows[0]?.key ?? null,
  };
};

export type RepoWorkspaceRowError = {
  alias?: 'required' | 'invalid' | 'duplicate' | 'in-use';
  path?: 'duplicate' | 'missing';
};

type RepoWorkspaceDraftValidation = {
  nameError: boolean;
  primaryError: boolean;
  rows: Record<string, RepoWorkspaceRowError>;
  canSubmit: boolean;
};

/** The OpenCode reference-key rule the server enforces. */
const ALIAS_PATTERN = /^[^\s/`,@][^\s/`,]*$/;

export const emptyRepoWorkspaceDraft = (): RepoWorkspaceDraft => ({
  name: '',
  rows: [],
  primaryKey: null,
});

/**
 * One place decides whether the dialog may submit: the server repeats these
 * checks, but a blocked save must be visible before a request is made.
 */
export const validateRepoWorkspaceDraft = (draft: RepoWorkspaceDraft): RepoWorkspaceDraftValidation => {
  const rows: Record<string, RepoWorkspaceRowError> = {};
  const aliasRows = new Map<string, string[]>();
  const pathRows = new Map<string, string[]>();

  for (const row of draft.rows) {
    const alias = row.alias.trim();
    const error: RepoWorkspaceRowError = {};
    if (!alias) error.alias = 'required';
    else if (!ALIAS_PATTERN.test(alias)) error.alias = 'invalid';
    if (error.alias) rows[row.key] = error;

    if (alias) aliasRows.set(alias, [...(aliasRows.get(alias) ?? []), row.key]);
    const path = normalizedRowPath(row.path);
    if (path) pathRows.set(path, [...(pathRows.get(path) ?? []), row.key]);
  }

  for (const keys of aliasRows.values()) {
    if (keys.length < 2) continue;
    for (const key of keys) rows[key] = { ...rows[key], alias: 'duplicate' };
  }
  for (const keys of pathRows.values()) {
    if (keys.length < 2) continue;
    for (const key of keys.slice(1)) rows[key] = { ...rows[key], path: 'duplicate' };
  }

  const nameError = draft.name.trim().length === 0;
  const primaryError = draft.rows.length === 0
    || !draft.primaryKey
    || !draft.rows.some((row) => row.key === draft.primaryKey);
  const hasRowError = Object.keys(rows).length > 0;

  return {
    nameError,
    primaryError,
    rows,
    canSubmit: !nameError && !primaryError && !hasRowError,
  };
};

/** A folder's name as an alias the OpenCode rule accepts, deduped with `-2`, `-3`. */
export const aliasForFolder = (path: string, takenAliases: readonly string[]): string => {
  const normalized = normalizedRowPath(path);
  const basename = normalized.split('/').filter(Boolean).pop() ?? 'repo';
  const base = basename
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-.]+$/, '') || 'repo';

  const taken = new Set(takenAliases);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

/** The next free alias a conflict can suggest without writing anything. */
export const suggestedAlias = (alias: string, takenAliases: readonly string[]): string => {
  const taken = new Set(takenAliases);
  let suffix = 2;
  while (taken.has(`${alias}-${suffix}`)) suffix += 1;
  return `${alias}-${suffix}`;
};

/** The exact body `POST /api/workspaces` accepts: every row is a folder path. */
export const createPayloadFromDraft = (
  draft: RepoWorkspaceDraft,
  branchFor: (path: string) => string,
) => ({
  name: draft.name.trim(),
  repos: draft.rows.map((row) => ({
    alias: row.alias.trim(),
    path: normalizedRowPath(row.path),
    branch: branchFor(normalizedRowPath(row.path)),
    primary: row.key === draft.primaryKey,
  })),
});

/**
 * The `PATCH` body: repos already in the catalog keep their id (a missing
 * project included), new folders travel by path. `keepRefs` names the owned
 * references the user chose not to delete when their repo left.
 */
export const updatePayloadFromDraft = (
  draft: RepoWorkspaceDraft,
  branchFor: (path: string) => string,
  {
    confirmRefs = [],
    keepRefs = [],
  }: { confirmRefs?: string[]; keepRefs?: string[] } = {},
) => ({
  name: draft.name.trim(),
  repos: draft.rows.map((row) => {
    const path = normalizedRowPath(row.path);
    return {
      alias: row.alias.trim(),
      ...(row.projectId ? { projectId: row.projectId } : { path }),
      branch: branchFor(path) || row.branch || '',
      primary: row.key === draft.primaryKey,
    };
  }),
  confirmRefs,
  keepRefs,
});

type RepoWorkspaceRefDiff = {
  removed: string[];
  added: string[];
  changed: string[];
};

/** The reference diff the edit notice shows, computed from the saved state. */
export const diffRepoWorkspaceRefs = ({
  workspace,
  draft,
  labels,
}: {
  workspace: RepoWorkspaceResolved;
  draft: RepoWorkspaceDraft;
  labels: ReadonlyMap<string, string>;
}): RepoWorkspaceRefDiff => {
  const previous = new Map(
    workspace.repos
      .filter((repo) => repo.projectId !== workspace.primaryProjectId)
      .map((repo) => [repo.alias, repo]),
  );
  const next = new Map(
    draft.rows
      .filter((row) => row.key !== draft.primaryKey && row.alias.trim())
      .map((row) => [row.alias.trim(), row]),
  );

  const removed = [...previous.keys()].filter((alias) => !next.has(alias));
  const added = [...next.keys()].filter((alias) => !previous.has(alias));
  const changed = [...next.keys()].filter((alias) => {
    const before = previous.get(alias);
    const row = next.get(alias);
    if (!before || !row) return false;
    // A missing project has no path to compare; leaving it untouched is not a change.
    if (before.missing && row.projectId === before.projectId) return false;
    const beforePath = before.project
      ? (normalizePath(before.project.path) ?? before.project.path)
      : '';
    const nextPath = normalizedRowPath(row.path);
    // A label the catalog does not know yet keeps the saved description, so an
    // unrelated row never shows as changed.
    const nextDescription = labels.has(nextPath) ? (labels.get(nextPath) ?? '') : before.description;
    return beforePath !== nextPath || before.description !== nextDescription;
  });

  return { removed, added, changed };
};
