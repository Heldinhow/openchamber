import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { beforeEach, expect, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
import type { WorkspaceProjectRow } from '@/lib/repoWorkspaces/workspaceProjects';
import { useGitStore } from '@/stores/useGitStore';

type Seed = {
  isGitRepo: boolean | null;
  status: GitStatus | null;
};

const seedDirectory = (directory: string, seed: Seed) => {
  const directories = new Map(useGitStore.getState().directories);
  directories.set(directory, {
    ...seed,
    branches: null,
    log: null,
    identity: null,
    diffCache: new Map(),
    indexRevision: 0,
    lastRepoCheckAt: Date.now(),
    lastStatusFetch: Date.now(),
    lastStatusChange: 0,
    lastLogFetch: 0,
    lastBranchesFetch: 0,
    lastIdentityFetch: 0,
    logMaxCount: 25,
    isLoadingStatus: false,
    isLoadingLog: false,
    isLoadingBranches: false,
    isLoadingIdentity: false,
  });
  useGitStore.setState({ directories });
};

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  ...overrides,
});

const rows: WorkspaceProjectRow[] = [
  { projectId: 'p_api', path: '/projects/api', label: 'api', missing: false },
  { projectId: 'p_web', path: '/projects/web', label: 'Web app', missing: false },
];

const renderSection = async (options: {
  rows?: readonly WorkspaceProjectRow[];
  failedPaths?: ReadonlySet<string>;
} = {}) => {
  const win = new Window({ url: 'http://localhost' });
  const values = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    ResizeObserver: win.ResizeObserver,
    MutationObserver: win.MutationObserver,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    PointerEvent: win.PointerEvent,
    KeyboardEvent: win.KeyboardEvent,
    getComputedStyle: win.getComputedStyle.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { WorkspaceProjectsSection } = await import('./WorkspaceProjectsSection');
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const opened: string[] = [];
  await act(async () => root.render(
    <I18nProvider>
      <WorkspaceProjectsSection
        rows={options.rows ?? rows}
        failedPaths={options.failedPaths ?? new Set()}
        onOpenGit={(path) => opened.push(path)}
      />
    </I18nProvider>,
  ));
  const cleanup = async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  };
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
  return { container, opened, buttons, cleanup };
};

beforeEach(() => {
  useGitStore.setState({ directories: new Map() });
});

test('rows follow workspace order, show live branch and changes, and only the branch is actionable', async () => {
  seedDirectory('/projects/api', {
    isGitRepo: true,
    status: status({
      current: 'main',
      files: [
        { path: 'a.ts', index: 'M', working_dir: ' ' },
        { path: 'b.ts', index: '?', working_dir: '?' },
      ],
      diffStats: {
        staged: { 'a.ts': { insertions: 3, deletions: 1 } },
        working: {},
      },
    }),
  });
  seedDirectory('/projects/web', { isGitRepo: true, status: status({ current: 'feature/web' }) });

  const section = await renderSection();
  try {
    const labels = Array.from(section.container.querySelectorAll('[dir="auto"]')).map((node) => node.textContent);
    expect(labels).toEqual(['api', 'Web app']);
    expect(section.container.textContent).toContain('main');
    expect(section.container.textContent).toContain('2 files changed');
    expect(section.container.textContent).toContain('+3');
    expect(section.container.textContent).toContain('−1');
    expect(section.container.textContent).toContain('feature/web');
    expect(section.container.textContent).toContain('No changes');

    // Only the two branch buttons: no project action menu or extra control.
    expect(section.buttons()).toHaveLength(2);
    expect(section.buttons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Open Git for api',
      'Open Git for Web app',
    ]);

    await act(async () => section.buttons()[1]?.click());
    expect(section.opened).toEqual(['/projects/web']);

    await act(async () => {
      seedDirectory('/projects/web', {
        isGitRepo: true,
        status: status({
          current: 'feature/web-2',
          files: [{ path: 'app.ts', index: 'M', working_dir: ' ' }],
          diffStats: { staged: {}, working: { 'app.ts': { insertions: 5, deletions: 2 } } },
        }),
      });
    });
    expect(section.container.textContent).toContain('feature/web-2');
    expect(section.container.textContent).toContain('1 file changed');
    expect(section.container.textContent).toContain('+5');
    expect(section.container.textContent).toContain('−2');
  } finally {
    await section.cleanup();
  }
});

test('unknown, failed, no-git and missing rows stay distinct and keep their places', async () => {
  seedDirectory('/projects/api', { isGitRepo: true, status: null });
  seedDirectory('/projects/web', { isGitRepo: false, status: null });
  seedDirectory('/projects/docs', { isGitRepo: null, status: null });

  const section = await renderSection({
    rows: [
      rows[0]!,
      { projectId: 'p_gone', path: null, label: null, missing: true },
      rows[1]!,
      { projectId: 'p_docs', path: '/projects/docs', label: 'docs', missing: false },
    ],
    failedPaths: new Set(['/projects/api']),
  });
  try {
    const labels = Array.from(section.container.querySelectorAll('[dir="auto"]')).map((node) => node.textContent);
    expect(labels).toEqual(['api', 'Project not found', 'Web app', 'docs']);
    expect(section.container.textContent).toContain("Couldn't read Git status");
    expect(section.container.textContent).toContain('No Git repository');
    expect(section.container.textContent).toContain('Reading Git status…');
    // None of these rows may report a clean tree or offer a Git action.
    expect(section.container.textContent).not.toContain('No changes');
    expect(section.buttons()).toHaveLength(0);
  } finally {
    await section.cleanup();
  }
});

test('a normal project panel renders no workspace section', async () => {
  const section = await renderSection({ rows: [] });
  try {
    expect(section.container.innerHTML).toBe('');
  } finally {
    await section.cleanup();
  }
});
