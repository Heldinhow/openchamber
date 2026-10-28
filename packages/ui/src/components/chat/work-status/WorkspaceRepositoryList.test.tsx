import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { WorkspaceGitRepoStatus } from '@/lib/repoWorkspaces/useWorkspaceGitStatuses';
import { useUIStore } from '@/stores/useUIStore';
import {
  WorkspaceRepositoryList,
  type WorkspaceRepositoryRow,
} from './WorkspaceRepositoryList';

const repo = (overrides: Partial<WorkspaceRepositoryRow> & Pick<WorkspaceRepositoryRow, 'projectId'>): WorkspaceRepositoryRow => ({
  alias: overrides.projectId,
  primary: false,
  path: `/repos/${overrides.projectId}`,
  savedBranch: '',
  ...overrides,
});

const status = (overrides: Partial<WorkspaceGitRepoStatus> = {}): WorkspaceGitRepoStatus => ({
  isGitRepo: true,
  branch: 'main',
  ahead: 0,
  behind: 0,
  changes: 0,
  ...overrides,
});

const primaries: WorkspaceRepositoryRow[] = [
  repo({ projectId: 'api', alias: 'api', primary: true }),
  repo({ projectId: 'web', alias: 'web' }),
];

let dom: Window;
let root: Root;
let container: HTMLElement;
let previousExpanded: Record<string, boolean>;
let opened: string[];
const globals = new Map<string, PropertyDescriptor | undefined>();

const render = async (
  statuses: ReadonlyMap<string, WorkspaceGitRepoStatus>,
  repos: readonly WorkspaceRepositoryRow[] = primaries,
) => {
  await act(async () => root.render(
    <I18nProvider>
      <WorkspaceRepositoryList
        repos={repos}
        statuses={statuses}
        onOpenRepo={(path) => opened.push(path)}
      />
    </I18nProvider>,
  ));
};

const section = () => {
  const node = container.querySelector('[data-work-status-section="repository-repos"]');
  if (!node) throw new Error('Expected the repository section');
  return node;
};

const heading = () => {
  const button = section().querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (!button) throw new Error('Expected the section heading');
  return button;
};

/** The rows' own buttons; the heading is the one carrying `aria-expanded`. */
const rowButtons = () => Array.from(section().querySelectorAll<HTMLButtonElement>('button:not([aria-expanded])'));

beforeEach(() => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event,
    localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  previousExpanded = useUIStore.getState().workStatusExpandedSections;
  useUIStore.setState({ workStatusExpandedSections: {} });
  opened = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState({ workStatusExpandedSections: previousExpanded });
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
  await dom.happyDOM.abort();
  dom.close();
});

describe('WorkspaceRepositoryList', () => {
  test('puts the primary repo first with its marker and names secondaries by alias', async () => {
    await render(new Map([
      ['api', status({ branch: 'main', changes: 2 })],
      ['web', status({ branch: 'develop', changes: 1 })],
    ]));

    const text = section().textContent ?? '';
    expect(text.indexOf('main')).toBeLessThan(text.indexOf('@web'));
    expect(text).toContain('(primary)');
    expect(text).toContain('@web');
    expect(text).toContain('develop');
  });

  test('shows live branch, ahead/behind, changed count and clean', async () => {
    await render(new Map([
      ['api', status({ branch: 'feat/live', ahead: 2, behind: 1, changes: 3 })],
      ['web', status({ branch: 'main', changes: 0 })],
    ]));

    const text = section().textContent ?? '';
    expect(text).toContain('feat/live');
    expect(text).toContain('↑2');
    expect(text).toContain('↓1');
    expect(text).toContain('3 changed');
    expect(text).toContain('clean');
  });

  test('a repo with no status shows no count and is never clean', async () => {
    await render(new Map<string, WorkspaceGitRepoStatus>(), [primaries[0]]);

    const text = section().textContent ?? '';
    expect(text).not.toContain('clean');
    expect(text).not.toContain('changed');
  });

  test('a non-git repo reads as not a Git repository', async () => {
    await render(new Map([['api', status({ isGitRepo: false, branch: null, changes: null })]]));

    expect(section().textContent).toContain('not a Git repository');
  });

  test('a live branch that moved away from the saved snapshot adds a note', async () => {
    await render(new Map([['api', status({ branch: 'feat/live' })]]), [
      repo({ projectId: 'api', alias: 'api', primary: true, savedBranch: 'feat/saved' }),
    ]);

    expect(section().textContent).toContain('saved branch: feat/saved');
  });

  test('a missing project keeps its alias row, reads missing and cannot be opened', async () => {
    await render(new Map([['api', status()]]), [
      repo({ projectId: 'api', alias: 'api', primary: true }),
      repo({ projectId: 'gone', alias: 'gone', path: null }),
    ]);

    const text = section().textContent ?? '';
    expect(text).toContain('@gone');
    expect(text).toContain('missing');
    expect(rowButtons().length).toBe(1);
  });

  test('collapsed unmounts the rows and keeps the total only when every repo answered', async () => {
    await act(async () => useUIStore.setState({ workStatusExpandedSections: { 'repository-repos': false } }));
    await render(new Map([
      ['api', status({ branch: 'main', changes: 2 })],
      ['web', status({ branch: 'develop', changes: 1 })],
    ]));

    expect(heading().textContent).toBe('Repositories2 repos · 3 changed');
    expect(section().textContent).not.toContain('main');

    await act(async () => useUIStore.setState({ workStatusExpandedSections: { 'repository-repos': false } }));
    await render(new Map([
      ['api', status({ branch: 'main', changes: 2 })],
      // No status: the total must stay hidden instead of reading as a partial sum.
    ]));
    expect(heading().textContent).toBe('Repositories2 repos');
  });

  test('expanding persists through the shared store', async () => {
    await act(async () => useUIStore.setState({ workStatusExpandedSections: { 'repository-repos': false } }));
    await render(new Map([
      ['api', status({ branch: 'main' })],
      ['web', status({ branch: 'develop' })],
    ]));

    await act(async () => heading().click());

    expect(useUIStore.getState().workStatusExpandedSections['repository-repos']).toBe(true);
    expect(section().textContent).toContain('main');
  });

  test('clicking a row opens that repo by its project path', async () => {
    await render(new Map([
      ['api', status()],
      ['web', status()],
    ]));

    const buttons = rowButtons();
    expect(buttons.length).toBe(2);
    await act(async () => buttons[1]?.click());

    expect(opened).toEqual(['/repos/web']);
  });
});
