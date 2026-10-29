import React from 'react';

import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { RepoWorkspaceResolved } from './client';

type RepoWorkspaceCatalogStatus = 'loading' | 'ready' | 'error' | 'unavailable';

type RepoWorkspaceCatalogState = {
  status: RepoWorkspaceCatalogStatus;
  workspaces: readonly RepoWorkspaceResolved[];
  discarded: number;
  /** The runtime whose route answered this list; a switch makes it foreign. */
  runtimeKey: string;
};

const initial = (status: RepoWorkspaceCatalogStatus): RepoWorkspaceCatalogState => ({
  status,
  workspaces: [],
  discarded: 0,
  runtimeKey: getRuntimeKey(),
});

/**
 * The last workspace list a route read. `useRepoWorkspaces` publishes it so the
 * composer can name and route a workspace draft without a second fetch.
 */
let catalog: RepoWorkspaceCatalogState = initial('loading');
/** A stable reading for a runtime whose list this catalog no longer holds. */
let foreignCatalog: RepoWorkspaceCatalogState | null = null;
const listeners = new Set<() => void>();

export const getRepoWorkspaceCatalog = (): RepoWorkspaceCatalogState => {
  if (catalog.runtimeKey === getRuntimeKey()) return catalog;
  if (!foreignCatalog || foreignCatalog.runtimeKey !== getRuntimeKey()) {
    foreignCatalog = initial('loading');
  }
  return foreignCatalog;
};

export const publishRepoWorkspaceCatalog = (next: RepoWorkspaceCatalogState): void => {
  // A fallback reader (the composer, or Mini Chat) must not replace a list the
  // sidebar already resolved with its own loading/error state: its failed
  // request would look like the workspace list disappeared.
  if (
    next.runtimeKey === catalog.runtimeKey
    && catalog.status === 'ready'
    && next.workspaces.length === 0
    && next.status !== 'ready'
  ) {
    return;
  }
  if (
    next.status === catalog.status
    && next.workspaces === catalog.workspaces
    && next.discarded === catalog.discarded
    && next.runtimeKey === catalog.runtimeKey
  ) {
    return;
  }
  catalog = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useRepoWorkspaceCatalog = (): RepoWorkspaceCatalogState => (
  React.useSyncExternalStore(subscribe, getRepoWorkspaceCatalog, getRepoWorkspaceCatalog)
);

/** The workspace a workspace draft names, or null when the catalog does not hold it. */
export const findRepoWorkspace = (id: string | null | undefined): RepoWorkspaceResolved | null => {
  if (!id) return null;
  return getRepoWorkspaceCatalog().workspaces.find((workspace) => workspace.id === id) ?? null;
};

/** The workspace a directory belongs to, resolved against an explicit list. */
export const findRepoWorkspaceIn = (
  workspaces: readonly RepoWorkspaceResolved[],
  directory: string | null | undefined,
): RepoWorkspaceResolved | null => {
  const normalized = normalizePath(directory);
  if (!normalized) return null;
  return workspaces.find((workspace) => normalizePath(workspace.directory) === normalized) ?? null;
};

export const findRepoWorkspaceByDirectory = (directory: string | null | undefined): RepoWorkspaceResolved | null => (
  findRepoWorkspaceIn(getRepoWorkspaceCatalog().workspaces, directory)
);

/** Every neutral directory the catalog knows; a draft must not root a project here. */
export const repoWorkspaceDirectories = (): Set<string> => new Set(
  getRepoWorkspaceCatalog().workspaces
    .map((workspace) => normalizePath(workspace.directory))
    .filter((directory): directory is string => directory !== null),
);
