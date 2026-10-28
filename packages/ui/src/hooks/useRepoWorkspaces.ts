import React from 'react';
import type { SettingsSyncedDetail } from '@/lib/persistence';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
  activateRepoWorkspace,
  fetchRepoWorkspaces,
  RepoWorkspacesUnavailableError,
  type RepoWorkspaceRef,
  type RepoWorkspaceResolved,
} from '@/lib/repoWorkspaces/client';

type RepoWorkspacesStatus = 'loading' | 'ready' | 'error' | 'unavailable';

type State = {
  status: RepoWorkspacesStatus;
  workspaces: RepoWorkspaceResolved[];
  activeWorkspaceId: string | null;
  refs: RepoWorkspaceRef[];
  refsError: { path: string; message: string } | null;
  activating: boolean;
};

const initialState = (enabled: boolean): State => ({
  status: enabled ? 'loading' : 'unavailable',
  workspaces: [],
  activeWorkspaceId: null,
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
    window.addEventListener('openchamber:settings-synced', onSettingsSynced);
    return () => {
      unsubscribeRuntime();
      window.removeEventListener('openchamber:settings-synced', onSettingsSynced);
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

  return {
    ...state,
    activeWorkspace,
    reload,
    selectWorkspace,
  };
};
