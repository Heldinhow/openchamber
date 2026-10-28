import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GitStatus } from '@/lib/api/types';
import { sessionEvents } from '@/lib/sessionEvents';
import { useGitStore } from '@/stores/useGitStore';
import {
  useWorkspaceGitStatuses,
  type WorkspaceGitRepo,
  type WorkspaceGitRepoStatus,
} from './useWorkspaceGitStatuses';

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['ensureStatus']>[1];
type DirectoryGitState = NonNullable<ReturnType<ReturnType<typeof useGitStore.getState>['getDirectoryState']>>;

const globals = new Map<string, PropertyDescriptor | undefined>();
let dom: Window;
let root: Root;
let repos: WorkspaceGitRepo[] = [];
let latest: ReadonlyMap<string, WorkspaceGitRepoStatus> = new Map();
let renders = 0;

const createStatus = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  ...overrides,
});

const createDirectoryState = (overrides: Partial<DirectoryGitState> = {}): DirectoryGitState => ({
  isGitRepo: true,
  status: null,
  branches: null,
  log: null,
  identity: null,
  diffCache: new Map(),
  indexRevision: 0,
  lastRepoCheckAt: Date.now(),
  lastStatusFetch: 0,
  lastStatusChange: 0,
  lastLogFetch: 0,
  lastBranchesFetch: 0,
  lastIdentityFetch: 0,
  logMaxCount: 25,
  isLoadingStatus: false,
  isLoadingLog: false,
  isLoadingBranches: false,
  isLoadingIdentity: false,
  ...overrides,
});

const seedDirectories = (entries: Record<string, DirectoryGitState>) => {
  useGitStore.setState({ directories: new Map(Object.entries(entries)), activeDirectory: null });
};

const createGitApi = (statusFor: (directory: string) => GitStatus) => {
  const reads: string[] = [];
  const git: GitAPI = {
    checkIsGitRepository: async () => true,
    getGitStatus: async (directory) => {
      reads.push(directory);
      return statusFor(directory);
    },
    getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
    getGitLog: async () => ({ all: [], latest: null, total: 0 }),
    getCurrentGitIdentity: async () => null,
    getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path, submodule: null }),
  };
  return { git, reads };
};

const Probe = ({ enabled, git }: { enabled: boolean; git: GitAPI | null }) => {
  latest = useWorkspaceGitStatuses({ repos, git, enabled });
  renders += 1;
  return null;
};

const render = async (enabled: boolean, git: GitAPI | null) => {
  await act(async () => {
    root.render(<Probe enabled={enabled} git={git} />);
  });
};

// One macrotask drains every pending background read and the React renders they cause.
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const entries = (): Record<string, WorkspaceGitRepoStatus> => Object.fromEntries(latest);

beforeEach(() => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom,
    document: dom.document,
    Event: dom.Event,
    HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  repos = [];
  latest = new Map();
  renders = 0;
  seedDirectories({});
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
  await dom.happyDOM.abort();
  dom.close();
});

describe('useWorkspaceGitStatuses', () => {
  test('keys by project id, keeps unknown apart from clean, and skips pathless repos', async () => {
    repos = [
      { projectId: 'p_api', path: '/repos/api' },
      { projectId: 'p_web', path: '/repos/web' },
      { projectId: 'p_clean', path: '/repos/clean' },
      { projectId: 'p_unknown', path: '/repos/unknown' },
      { projectId: 'p_gone', path: null },
    ];
    seedDirectories({
      '/repos/api': createDirectoryState({
        status: createStatus({
          current: ' feat/status-panel ',
          ahead: 2,
          behind: 1,
          files: ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, index: ' ', working_dir: 'M' })),
          isClean: false,
        }),
      }),
      '/repos/web': createDirectoryState({ isGitRepo: false }),
      '/repos/clean': createDirectoryState({ status: createStatus() }),
    });

    await render(true, null);

    expect(Object.keys(entries()).sort()).toEqual(['p_api', 'p_clean', 'p_unknown', 'p_web']);
    expect(entries().p_api).toEqual({ isGitRepo: true, branch: 'feat/status-panel', ahead: 2, behind: 1, changes: 3 });
    expect(entries().p_clean).toEqual({ isGitRepo: true, branch: 'main', ahead: 0, behind: 0, changes: 0 });
    expect(entries().p_web).toEqual({ isGitRepo: false, branch: null, ahead: 0, behind: 0, changes: null });
    expect(entries().p_unknown).toEqual({ isGitRepo: null, branch: null, ahead: 0, behind: 0, changes: null });

    // An unrelated store field changing must not rebuild the map.
    const held = latest;
    await act(async () => {
      const directories = new Map(useGitStore.getState().directories);
      const api = directories.get('/repos/api');
      if (!api) throw new Error('missing seeded repo');
      directories.set('/repos/api', { ...api, isLoadingLog: true });
      useGitStore.setState({ directories });
    });
    expect(latest).toBe(held);
  });

  test('warms each path once and refreshes only the hinted repo', async () => {
    repos = [
      { projectId: 'p_api', path: '/repos/api' },
      { projectId: 'p_web', path: '/repos/web' },
    ];
    seedDirectories({
      '/repos/api': createDirectoryState(),
      '/repos/web': createDirectoryState(),
    });
    const { git, reads } = createGitApi((directory) => (
      directory.startsWith('/repos/api')
        ? createStatus({ current: 'feat/one', ahead: 1, files: [{ path: 'a.ts', index: ' ', working_dir: 'M' }], isClean: false })
        : createStatus({ current: 'main' })
    ));

    await render(true, git);
    await settle();

    expect(reads.length).toBe(2);
    expect([...reads].sort()).toEqual(['/repos/api', '/repos/web']);
    expect(entries().p_api).toEqual({ isGitRepo: true, branch: 'feat/one', ahead: 1, behind: 0, changes: 1 });
    expect(entries().p_web).toEqual({ isGitRepo: true, branch: 'main', ahead: 0, behind: 0, changes: 0 });

    await act(async () => {
      sessionEvents.requestGitRefresh({ directory: '/repos/api/' });
      sessionEvents.requestGitRefresh({ directory: '/repos/other' });
    });
    await settle();

    expect(reads.length).toBe(3);
    expect(reads[2]).toBe('/repos/api/');
  });

  test('disabled performs no read and holds the last map', async () => {
    repos = [
      { projectId: 'p_api', path: '/repos/api' },
      { projectId: 'p_web', path: '/repos/web' },
    ];
    seedDirectories({
      '/repos/api': createDirectoryState(),
      '/repos/web': createDirectoryState(),
    });
    const { git, reads } = createGitApi(() => createStatus());

    await render(true, git);
    await settle();
    expect(reads.length).toBe(2);

    const held = latest;
    const heldRenders = renders;
    await render(false, git);
    await act(async () => {
      seedDirectories({});
      sessionEvents.requestGitRefresh({ directory: '/repos/api' });
    });
    await settle();

    expect(latest).toBe(held);
    expect(entries().p_api?.branch).toBe('main');
    expect(renders).toBe(heldRenders + 1);
    expect(reads.length).toBe(2);
  });
});
