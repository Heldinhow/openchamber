import React from 'react';
import type { SettingsSyncedDetail } from '@/lib/persistence';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
  activateRepoWorkspace,
  fetchRepoWorkspaces,
  RepoWorkspacesUnavailableError,
  retryRepoWorkspaceRefs,
  type RepoWorkspaceRef,
  type RepoWorkspaceResolved,
} from '@/lib/repoWorkspaces/client';

type RepoWorkspacesStatus = 'loading' | 'ready' | 'error' | 'unavailable';

/** One retry answer is authoritative for every hook instance showing that workspace. */
const REPO_WORKSPACE_REFS_UPDATED_EVENT = 'openchamber:workspace-refs-updated';

type RepoWorkspaceRefsUpdatedDetail = {
  workspaceId: string;
  refs: RepoWorkspaceRef[];
  refsError: { path: string; message: string } | null;
};

type State = {
  status: RepoWorkspacesStatus;
  workspaces: RepoWorkspaceResolved[];
  activeWorkspaceId: string | null;
  /** Stored workspaces the settings parser dropped; shown, never rewritten. */
  discarded: number;
  refs: RepoWorkspaceRef[];
  refsError: { path: string; message: string } | null;
  activating: boolean;
};

const initialState = (enabled: boolean): State => ({
  status: enabled ? 'loading' : 'unavailable',
  workspaces: [],
  activeWorkspaceId: null,
  discarded: 0,
  refs: [],
  refsError: null,
  activating: false,
});

/**
 * The sidebar's copy of the workspace filter: the server route owns the
 * resolved state (missing projects included), the merged settings document owns
 * the pointer another window may have moved. Nothing is stored on this device.
 *
 * Disabled where the route does not exist: hosted/Capacitor mobile and VS Code.
 */
export const useRepoWorkspaces = ({ enabled }: { enabled: boolean }) => {
  const [state, setState] = React.useState<State>(() => initialState(enabled));
  const [retryingRefs, setRetryingRefs] = React.useState<ReadonlySet<string>>(() => new Set());
  const requestGenerationRef = React.useRef(0);
  const selectionGenerationRef = React.useRef(0);
  const settingsSignatureRef = React.useRef<string | null>(null);

  const load = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!enabled) return;
    const generation = ++requestGenerationRef.current;
    const runtimeKey = getRuntimeKey();
    if (!options?.silent) {
      setState((current) => ({ ...current, status: 'loading' }));
    }
    try {
      const document = await fetchRepoWorkspaces();
      if (generation !== requestGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
      setState((current) => ({
        status: 'ready',
        workspaces: document.workspaces,
        activeWorkspaceId: document.activeWorkspaceId,
        discarded: document.discarded,
        refs: document.refs,
        refsError: document.refsError,
        activating: current.activating,
      }));
    } catch (error) {
      if (generation !== requestGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
      if (error instanceof RepoWorkspacesUnavailableError) {
        setState((current) => ({ ...current, status: 'unavailable' }));
        return;
      }
      setState((current) => ({ ...current, status: 'error' }));
    }
  }, [enabled]);

  const reload = React.useCallback(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!enabled) return;
    void load();
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      requestGenerationRef.current += 1;
      selectionGenerationRef.current += 1;
      settingsSignatureRef.current = null;
      setState(initialState(true));
      void load();
    });
    const onSettingsSynced = (event: Event) => {
      // SAFETY: the app dispatches this event with SettingsSyncedDetail.
      const settings = (event as CustomEvent<SettingsSyncedDetail>).detail?.settings;
      if (!settings) return;
      if (!('workspaces' in settings) && !('activeWorkspaceId' in settings)) return;
      const nextActive = settings.activeWorkspaceId ?? null;
      setState((current) => (
        current.activeWorkspaceId === nextActive
          ? current
          : { ...current, activeWorkspaceId: nextActive, refs: [], refsError: null }
      ));
      // The pointer above can be applied at once; the resolved repos, missing
      // projects included, still come from the server route.
      const signature = JSON.stringify({ workspaces: settings.workspaces ?? null, activeWorkspaceId: nextActive });
      if (signature === settingsSignatureRef.current) return;
      settingsSignatureRef.current = signature;
      void load({ silent: true });
    };
    const onRefsUpdated = (event: Event) => {
      // SAFETY: retryRefs dispatches this event with RepoWorkspaceRefsUpdatedDetail.
      const detail = (event as CustomEvent<RepoWorkspaceRefsUpdatedDetail>).detail;
      if (!detail) return;
      setState((current) => current.activeWorkspaceId === detail.workspaceId
        ? { ...current, refs: detail.refs, refsError: detail.refsError }
        : current);
    };
    window.addEventListener('openchamber:settings-synced', onSettingsSynced);
    window.addEventListener(REPO_WORKSPACE_REFS_UPDATED_EVENT, onRefsUpdated);
    return () => {
      unsubscribeRuntime();
      window.removeEventListener('openchamber:settings-synced', onSettingsSynced);
      window.removeEventListener(REPO_WORKSPACE_REFS_UPDATED_EVENT, onRefsUpdated);
    };
  }, [enabled, load]);

  const selectWorkspace = React.useCallback(async (id: string | null) => {
    if (!enabled) return;
    const selection = ++selectionGenerationRef.current;
    const runtimeKey = getRuntimeKey();
    setState((current) => ({ ...current, activating: true }));
    try {
      const result = await activateRepoWorkspace(id);
      if (selection !== selectionGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
      // A read that started while the switch was in flight may carry the old
      // pointer; the switch's own answer wins over it.
      requestGenerationRef.current += 1;
      setState((current) => ({ ...current, activeWorkspaceId: result.activeWorkspaceId, refs: [], refsError: null }));
      // The reference states belong to whichever workspace is active now.
      void load({ silent: true });
    } finally {
      if (selection === selectionGenerationRef.current) {
        setState((current) => ({ ...current, activating: false }));
      }
    }
  }, [enabled, load]);

  const activeWorkspace = React.useMemo(() => (
    state.status === 'ready' && state.activeWorkspaceId
      ? state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null
      : null
  ), [state.activeWorkspaceId, state.status, state.workspaces]);

  /** Rewrites the named pending aliases and replaces the reference states with the answer. */
  const retryRefs = React.useCallback(async (aliases: string[]) => {
    const workspaceId = state.activeWorkspaceId;
    if (!enabled || !workspaceId || aliases.length === 0) return;
    const runtimeKey = getRuntimeKey();
    setRetryingRefs(new Set(aliases));
    try {
      const result = await retryRepoWorkspaceRefs(workspaceId, aliases);
      if (runtimeKey !== getRuntimeKey()) return;
      window.dispatchEvent(new CustomEvent<RepoWorkspaceRefsUpdatedDetail>(REPO_WORKSPACE_REFS_UPDATED_EVENT, {
        detail: { workspaceId, refs: result.refs, refsError: result.refsError },
      }));
    } finally {
      setRetryingRefs(new Set());
    }
  }, [enabled, state.activeWorkspaceId]);

  return {
    ...state,
    activeWorkspace,
    retryingRefs,
    reload,
    selectWorkspace,
    retryRefs,
  };
};
