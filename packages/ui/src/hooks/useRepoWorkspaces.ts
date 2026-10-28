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

/** What a read did with the document it asked for. */
type RepoWorkspacesLoadResult = 'applied' | 'failed' | 'unavailable' | 'stale';

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
  const activationInFlightRef = React.useRef(false);

  const load = React.useCallback(async (options?: { silent?: boolean }): Promise<RepoWorkspacesLoadResult> => {
    if (!enabled) return 'failed';
    const generation = ++requestGenerationRef.current;
    const runtimeKey = getRuntimeKey();
    if (!options?.silent) {
      setState((current) => ({ ...current, status: 'loading' }));
    }
    try {
      const document = await fetchRepoWorkspaces();
      if (generation !== requestGenerationRef.current || runtimeKey !== getRuntimeKey()) return 'stale';
      setState((current) => ({
        status: 'ready',
        workspaces: document.workspaces,
        activeWorkspaceId: document.activeWorkspaceId,
        discarded: document.discarded,
        refs: document.refs,
        refsError: document.refsError,
        activating: current.activating,
      }));
      return 'applied';
    } catch (error) {
      if (generation !== requestGenerationRef.current || runtimeKey !== getRuntimeKey()) return 'stale';
      if (error instanceof RepoWorkspacesUnavailableError) {
        setState((current) => ({ ...initialState(true), status: 'unavailable', activating: current.activating }));
        return 'unavailable';
      }
      setState((current) => ({ ...current, status: 'error' }));
      return 'failed';
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
      activationInFlightRef.current = false;
      setState(initialState(true));
      void load();
    });
    const onSettingsSynced = (event: Event) => {
      // SAFETY: the app dispatches this event with SettingsSyncedDetail.
      const settings = (event as CustomEvent<SettingsSyncedDetail>).detail?.settings;
      if (!settings) return;
      if (!('workspaces' in settings) && !('activeWorkspaceId' in settings)) return;
      // A pointer written elsewhere while this hook's own switch is in flight
      // may predate the activation, which reads after it and wins.
      if (activationInFlightRef.current) return;
      // The pointer is not applied here: pairing the new name with the previous
      // workspace's references is the empty-chips flash. The read below answers
      // with the pointer and its reference states together.
      const signature = JSON.stringify({ workspaces: settings.workspaces ?? null, activeWorkspaceId: settings.activeWorkspaceId ?? null });
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
    activationInFlightRef.current = true;
    setState((current) => ({ ...current, activating: true }));
    try {
      const result = await activateRepoWorkspace(id);
      if (selection !== selectionGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
      // A read that started while the switch was in flight may carry the old
      // pointer; the switch's own answer wins over it.
      requestGenerationRef.current += 1;
      // The name and the chips are one view of one document: keep the previous
      // complete view until the route answers with the new pointer and its refs.
      const outcome = await load({ silent: true });
      if (selection !== selectionGenerationRef.current || outcome !== 'failed') return;
      // The read failed, so apply the switch from the last resolved document:
      // its per-workspace refs still describe the workspace now active. The
      // status the read reported stays, and the header never shows the old
      // workspace with the new pointer.
      setState((current) => {
        const workspace = current.workspaces.find((entry) => entry.id === result.activeWorkspaceId) ?? null;
        return {
          ...current,
          activeWorkspaceId: result.activeWorkspaceId,
          refs: workspace?.refs ?? [],
          refsError: workspace?.refsError ?? null,
        };
      });
    } finally {
      if (selection === selectionGenerationRef.current) {
        activationInFlightRef.current = false;
        setState((current) => ({ ...current, activating: false }));
      }
    }
  }, [enabled, load]);

  // A failed reload keeps the last resolved list usable, so the pointer still
  // resolves to the workspace it named.
  const activeWorkspace = React.useMemo(() => (
    state.activeWorkspaceId
      ? state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null
      : null
  ), [state.activeWorkspaceId, state.workspaces]);

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
