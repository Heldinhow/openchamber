import * as React from 'react';

import { runBackgroundNetworkTask } from '@/lib/background-network';
import type { GitStatus } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sessionEvents } from '@/lib/sessionEvents';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitStore } from '@/stores/useGitStore';
import type { RepoWorkspaceResolved } from './client';

/** One member project as the right panel lists it, in workspace order. */
export type WorkspaceProjectRow = {
  projectId: string;
  /** Null when the project left the catalog; the row reports it as missing. */
  path: string | null;
  label: string | null;
  missing: boolean;
};

/**
 * What the panel knows about one project's git. A probe that has not answered,
 * a project that is not a repository, a read that failed and a clean tree are
 * different states; none of them may become an empty repository with zero
 * changes.
 */
export type WorkspaceProjectGitReadout =
  | { state: 'unknown' }
  | { state: 'failed' }
  | { state: 'no-git' }
  | {
    state: 'ready';
    branch: string | null;
    changes: number;
    /** Null when the status carries no diff stat, never a made-up zero. */
    additions: number | null;
    deletions: number | null;
  };

const projectLabel = (project: { label: string; path: string }): string => (
  project.label.trim() || project.path.split(/[\\/]/).filter(Boolean).pop() || project.path
);

/**
 * The workspace's projects in the order the user stored them. A missing
 * project keeps its row; it is never dropped in favour of the others.
 */
export const projectWorkspaceRows = (
  workspace: RepoWorkspaceResolved | null,
): WorkspaceProjectRow[] => (workspace?.projects ?? []).map((member) => {
  const project = member.project;
  if (member.missing || !project) {
    return { projectId: member.projectId, path: null, label: null, missing: true };
  }
  return {
    projectId: member.projectId,
    path: project.path,
    label: projectLabel(project),
    missing: false,
  };
});

/** A directory read through the shared git store, as this projection needs it. */
export type WorkspaceProjectDirectoryState = {
  isGitRepo: boolean | null;
  status: GitStatus | null;
};

const diffTotals = (status: GitStatus) => {
  const stats = status.diffStats;
  if (!stats) {
    return { additions: null, deletions: null };
  }
  let additions = 0;
  let deletions = 0;
  for (const entry of [...Object.values(stats.staged), ...Object.values(stats.working)]) {
    additions += entry.insertions;
    deletions += entry.deletions;
  }
  return { additions, deletions };
};

/**
 * The row's git state. A failed probe or read is reported as failed, not as an
 * empty result; a status that already arrived survives a later failed refresh.
 */
export const projectWorkspaceGitReadout = (
  directory: WorkspaceProjectDirectoryState | undefined,
  failed: boolean,
): WorkspaceProjectGitReadout => {
  if (directory?.isGitRepo === false) {
    return { state: 'no-git' };
  }
  if (directory?.status) {
    const branch = directory.status.current.trim();
    return {
      state: 'ready',
      branch: branch || null,
      changes: directory.status.files.length,
      ...diffTotals(directory.status),
    };
  }
  if (failed) {
    return { state: 'failed' };
  }
  return { state: 'unknown' };
};

const EMPTY_FAILURES: ReadonlySet<string> = new Set();

/**
 * Reads every member project's status through the shared git store, in the
 * background, once per project. A project is retried when the git store is
 * hinted for the session directory (a workspace session runs in its neutral
 * directory) or for the project's own path. A failed read stays failed until a
 * later read succeeds; it never clears another project's row.
 */
export const useWorkspaceProjectFailures = (
  projectPaths: readonly string[],
  sessionDirectory: string | null,
  enabled: boolean,
): ReadonlySet<string> => {
  const { git } = useRuntimeAPIs();
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const [failedPaths, setFailedPaths] = React.useState<ReadonlySet<string>>(EMPTY_FAILURES);

  const markFailed = React.useCallback((path: string, failed: boolean) => {
    setFailedPaths((current) => {
      if (failed === current.has(path)) return current;
      const next = new Set(current);
      if (failed) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  React.useEffect(() => {
    if (!enabled || projectPaths.length === 0) return undefined;
    let cancelled = false;
    const runtimeKey = getRuntimeKey();

    const load = async (path: string) => {
      try {
        await runBackgroundNetworkTask(() => fetchStatus(path, git, { silent: true, throwOnError: true }));
        if (cancelled || runtimeKey !== getRuntimeKey()) return;
        markFailed(path, false);
      } catch {
        if (cancelled || runtimeKey !== getRuntimeKey()) return;
        markFailed(path, true);
      }
    };

    void (async () => {
      for (const path of projectPaths) {
        if (cancelled) return;
        const known = useGitStore.getState().directories.get(path);
        // An answered probe is authoritative: a repository keeps its status
        // (refreshed through its own staleness window) and a non-repository
        // needs no status read.
        if (known?.status) {
          void ensureStatus(path, git);
          continue;
        }
        if (known?.isGitRepo === false) continue;
        await load(path);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, ensureStatus, fetchStatus, git, markFailed, projectPaths]);

  React.useEffect(() => {
    if (!enabled || projectPaths.length === 0) return undefined;
    const sessionPath = normalizePath(sessionDirectory);
    const watched = new Map<string, string>();
    for (const path of projectPaths) {
      const normalized = normalizePath(path);
      if (normalized) watched.set(normalized, path);
    }

    const refresh = (path: string) => {
      if (useGitStore.getState().directories.get(path)?.isGitRepo === false) return;
      void runBackgroundNetworkTask(() => fetchStatus(path, git, { silent: true }))
        .then(() => markFailed(path, false))
        .catch(() => undefined);
    };

    return sessionEvents.onGitRefreshHint((hint) => {
      const hinted = normalizePath(hint.directory);
      if (!hinted) return;
      if (sessionPath && hinted === sessionPath) {
        for (const path of watched.values()) refresh(path);
        return;
      }
      const watchedPath = watched.get(hinted);
      if (watchedPath) refresh(watchedPath);
    });
  }, [enabled, fetchStatus, git, markFailed, projectPaths, sessionDirectory]);

  return failedPaths;
};
