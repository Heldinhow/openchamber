import { normalizePath } from '@/lib/pathNormalization';

export type RepoWorkspaceDraftRow = {
  key: string;
  path: string;
  alias: string;
};

export type RepoWorkspaceDraft = {
  name: string;
  rows: RepoWorkspaceDraftRow[];
  primaryKey: string | null;
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

const normalizedRowPath = (path: string): string => normalizePath(path) ?? path.trim();

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
