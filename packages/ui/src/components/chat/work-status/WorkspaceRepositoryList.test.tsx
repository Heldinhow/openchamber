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

const triggers = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'));

/** The detail rows' own buttons; the repo triggers carry `aria-expanded`. */
const rowButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button:not([aria-expanded])'));

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
  test('puts the primary repo first with a discreet marker and names every repo by alias', async () => {
    await render(new Map([
      ['api', status({ branch: 'main', changes: 2 })],
      ['web', status({ branch: 'develop', changes: 1 })],
    ]));

    const text = container.textContent ?? '';
    expect(text.indexOf('api')).toBeLessThan(text.indexOf('web'));
    expect(triggers()[0]?.textContent).toContain('primary');
    expect(triggers()[1]?.textContent).not.toContain('primary');
    expect(text).not.toContain('@');
    expect(triggers()[1]?.textContent).toContain('develop');
  });

  test('expanded shows changes and ahead/behind under the repo', async () => {
    await render(new Map([
      ['api', status({ branch: 'feat/live', ahead: 2, behind: 1, changes: 3 })],
      ['web', status({ branch: 'main', changes: 0 })],
    ]));

    const text = container.textContent ?? '';
    expect(triggers().every((button) => button.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(text).toContain('feat/live');
    expect(text).toContain('↑2');
    expect(text).toContain('↓1');
    expect(text).toContain('3 files changed');
    expect(text).toContain('No changes');
  });

  test('collapsed keeps the branch and shows the compact change count', async () => {
    await act(async () => useUIStore.setState({
      workStatusExpandedSections: { 'repository-repo:api': false, 'repository-repo:web': false },
    }));
    await render(new Map([
      ['api', status({ branch: 'main', ahead: 1, changes: 2 })],
      ['web', status({ branch: 'develop', changes: 0 })],
    ]));

    expect(triggers()[0]?.textContent).toContain('main');
    expect(triggers()[0]?.querySelector('[title="2 changes"]')).not.toBeNull();
    expect(triggers()[1]?.querySelector('[aria-label="No changes"]')).not.toBeNull();
    expect(container.textContent).not.toContain('↑1');
    expect(rowButtons().length).toBe(0);
  });

  test('more than three repos start collapsed', async () => {
    await render(new Map(), ['a', 'b', 'c', 'd'].map((projectId) => repo({ projectId })));

    expect(triggers().map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false', 'false']);
  });

  test('a repo with no status shows no count and is never clean', async () => {
    await render(new Map<string, WorkspaceGitRepoStatus>(), [primaries[0]]);

    const text = container.textContent ?? '';
    expect(text).toContain('api');
    expect(text).not.toContain('No changes');
    expect(text).not.toContain('changed');
  });

  test('a missing repo keeps its row, reads missing and cannot be opened or expanded', async () => {
    await render(new Map([['api', status()]]), [
      repo({ projectId: 'api', alias: 'api', primary: true }),
      repo({ projectId: 'gone', alias: 'gone', path: null }),
    ]);

    const text = container.textContent ?? '';
    expect(text).toContain('gone');
    expect(text).toContain('missing');
    expect(triggers().length).toBe(1);
  });

  test('a repo alias carries its full text as a title', async () => {
    await render(new Map([['web', status()]]), [repo({ projectId: 'web', alias: 'a-rather-long-alias' })]);

    expect(container.querySelector<HTMLElement>('[title="a-rather-long-alias"]')?.textContent).toBe('a-rather-long-alias');
  });

  test('a non-git repo reads as not a Git repository', async () => {
    await render(new Map([['api', status({ isGitRepo: false, branch: null, changes: null })]]));

    expect(container.textContent).toContain('not a Git repository');
    expect(triggers().length).toBe(1);
  });

  test('a live branch that moved away from the saved snapshot adds a note', async () => {
    await render(new Map([['api', status({ branch: 'feat/live' })]]), [
      repo({ projectId: 'api', alias: 'api', primary: true, savedBranch: 'feat/saved' }),
    ]);

    expect(container.textContent).toContain('saved branch: feat/saved');
    expect(container.querySelector('[title="saved branch: feat/saved"]')).not.toBeNull();
  });

  test('folding a repo persists per repo through the shared store', async () => {
    await render(new Map([
      ['api', status({ branch: 'main', changes: 1 })],
      ['web', status({ branch: 'develop', changes: 1 })],
    ]));

    await act(async () => triggers()[1]?.click());

    expect(useUIStore.getState().workStatusExpandedSections['repository-repo:web']).toBe(false);
    expect(useUIStore.getState().workStatusExpandedSections['repository-repo:api']).toBeUndefined();
    expect(triggers()[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(rowButtons().length).toBe(1);
  });

  test('clicking a repo\'s changes opens that repo by its project path', async () => {
    await render(new Map([
      ['api', status({ changes: 0 })],
      ['web', status({ changes: 2 })],
    ]));

    // A clean repo has no diff to open.
    const buttons = rowButtons();
    expect(buttons.length).toBe(1);
    await act(async () => buttons[0]?.click());

    expect(opened).toEqual(['/repos/web']);
  });
});
