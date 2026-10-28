import * as React from 'react';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { normalizePath } from '@/lib/pathNormalization';
import { sessionEvents } from '@/lib/sessionEvents';
import { useGitStore } from '@/stores/useGitStore';

export type WorkspaceGitRepo = {
  projectId: string;
  /** Resolved project path; null when the project left the catalog. */
  path: string | null;
};

export type WorkspaceGitRepoStatus = {
  isGitRepo: boolean | null;
  branch: string | null;
  ahead: number;
  behind: number;
  /** null means no status has arrived; never report unknown as zero. */
  changes: number | null;
};

type Args = {
  repos: readonly WorkspaceGitRepo[];
  /** The narrow git surface the store's status reads need; the runtime `GitAPI` satisfies it. */
  git: Parameters<ReturnType<typeof useGitStore.getState>['ensureStatus']>[1] | null;
  enabled: boolean;
};

type WatchedRepo = { projectId: string; path: string };

const EMPTY_STATUSES: ReadonlyMap<string, WorkspaceGitRepoStatus> = new Map();

/**
 * Branch, ahead, behind and changed-file count for every repo of the active
 * workspace, read through the shared git store. A repo whose status has not
 * arrived stays unknown (`null`), never a clean zero.
 */
export const useWorkspaceGitStatuses = ({
  repos,
  git,
  enabled,
}: Args): ReadonlyMap<string, WorkspaceGitRepoStatus> => {
  const watched = React.useMemo(() => {
    const list: WatchedRepo[] = [];
    for (const repo of repos) {
      if (repo.path !== null) list.push({ projectId: repo.projectId, path: repo.path });
    }
    return list;
  }, [repos]);

  // Keyed by project and path so a caller rebuilding `repos` each render does
  // not rebuild the map; only a watched field changing does.
  const watchedKey = watched.map((repo) => `${repo.projectId}\u0000${repo.path}`).join('\u0001');
  const cacheRef = React.useRef<{ key: string | null; map: ReadonlyMap<string, WorkspaceGitRepoStatus> }>({
    key: null,
    map: EMPTY_STATUSES,
  });

  const statuses = useGitStore((state) => {
    const cached = cacheRef.current;
    // A surface animating out keeps the map it had: its exit must not drop the
    // lines mid-slide, and a closed surface must not re-render on git changes.
    if (!enabled) return cached.map;
    let same = cached.key === watchedKey;
    if (same) {
      for (const repo of watched) {
        const previous = cached.map.get(repo.projectId);
        const directory = state.directories.get(repo.path);
        if (
          !previous
          || (directory?.isGitRepo ?? null) !== previous.isGitRepo
          || (directory?.status?.current?.trim() || null) !== previous.branch
          || (directory?.status?.ahead ?? 0) !== previous.ahead
          || (directory?.status?.behind ?? 0) !== previous.behind
          || (directory?.status ? directory.status.files.length : null) !== previous.changes
        ) { same = false; break; }
      }
    }
    if (same) return cached.map;
    const next = new Map<string, WorkspaceGitRepoStatus>();
    for (const repo of watched) {
      const directory = state.directories.get(repo.path);
      next.set(repo.projectId, {
        isGitRepo: directory?.isGitRepo ?? null,
        branch: directory?.status?.current?.trim() || null,
        ahead: directory?.status?.ahead ?? 0,
        behind: directory?.status?.behind ?? 0,
        changes: directory?.status ? directory.status.files.length : null,
      });
    }
    cacheRef.current = { key: watchedKey, map: next };
    return next;
  });

  // `ensureStatus` respects its own staleness window, so a re-render is cheap.
  React.useEffect(() => {
    if (!enabled || !git || watched.length === 0) return;
    const { ensureStatus } = useGitStore.getState();
    for (const repo of watched) {
      void runBackgroundNetworkTask(() => ensureStatus(repo.path, git));
    }
  }, [enabled, git, watched]);

  React.useEffect(() => {
    if (!enabled || !git || watched.length === 0) return;
    // Git state is keyed by the exact watched path, so a hint normalized to a
    // watched path must still read that watched path (not the hint's own text).
    const watchedPaths = new Map<string, string>();
    for (const repo of watched) {
      const path = normalizePath(repo.path);
      if (path) watchedPaths.set(path, repo.path);
    }
    return sessionEvents.onGitRefreshHint((hint) => {
      const hinted = normalizePath(hint.directory);
      const watchedPath = hinted === null ? undefined : watchedPaths.get(hinted);
      if (watchedPath === undefined) return;
      const { fetchStatus } = useGitStore.getState();
      void runBackgroundNetworkTask(() => fetchStatus(watchedPath, git, { silent: true }));
    });
  }, [enabled, git, watched]);

  return statuses;
};
