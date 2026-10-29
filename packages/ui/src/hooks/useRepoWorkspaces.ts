import React from 'react';
import type { SettingsSyncedDetail } from '@/lib/persistence';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
  fetchRepoWorkspaces,
  RepoWorkspacesUnavailableError,
  type RepoWorkspaceResolved,
} from '@/lib/repoWorkspaces/client';
import { publishRepoWorkspaceCatalog } from '@/lib/repoWorkspaces/catalog';

export type RepoWorkspacesStatus = 'loading' | 'ready' | 'error' | 'unavailable';

type State = {
  status: RepoWorkspacesStatus;
  workspaces: RepoWorkspaceResolved[];
  /** Stored workspaces the settings parser dropped; shown, never rewritten. */
  discarded: number;
  /** The runtime whose request produced this state. */
  runtimeKey: string;
};

const initialState = (enabled: boolean): State => ({
  status: enabled ? 'loading' : 'unavailable',
  workspaces: [],
  discarded: 0,
  runtimeKey: getRuntimeKey(),
});

/** The fields a settings save holds, so a resolved list can be compared to it. */
const workspaceListSignature = (workspaces: readonly { id: string; name: string; projectIds: string[] }[]): string => (
  JSON.stringify(workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    projectIds: workspace.projectIds,
  })))
);

/**
 * The sidebar's copy of the workspace list. The server route owns the resolved
 * state (missing projects included); the merged settings document only signals
 * that another window may have changed the list. Nothing is stored on this
 * device.
 *
 * Disabled where the route does not exist: hosted/Capacitor mobile and VS Code.
 */
export const useRepoWorkspaces = ({ enabled }: { enabled: boolean }) => {
  const [state, setState] = React.useState<State>(() => initialState(enabled));
  const requestGenerationRef = React.useRef(0);
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
      setState({
        status: 'ready',
        workspaces: document.workspaces,
        discarded: document.discarded,
        runtimeKey,
      });
    } catch (error) {
      if (generation !== requestGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
      if (error instanceof RepoWorkspacesUnavailableError) {
        setState({ ...initialState(true), status: 'unavailable' });
        return;
      }
      // A failed read keeps the last resolved list; the status tells the
      // sidebar to offer a retry.
      setState((current) => ({ ...current, status: 'error' }));
    }
  }, [enabled]);

  const reload = React.useCallback(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    publishRepoWorkspaceCatalog({ ...state });
  }, [state]);

  React.useEffect(() => {
    if (!enabled) return;
    void load();
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      requestGenerationRef.current += 1;
      settingsSignatureRef.current = null;
      setState(initialState(true));
      void load();
    });
    const onSettingsSynced = (event: Event) => {
      // SAFETY: the app dispatches this event with SettingsSyncedDetail.
      const settings = (event as CustomEvent<SettingsSyncedDetail>).detail?.settings;
      if (!settings || !('workspaces' in settings)) return;
      const signature = workspaceListSignature(settings.workspaces ?? []);
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

  return {
    ...state,
    reload,
  };
};
