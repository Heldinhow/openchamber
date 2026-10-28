import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';

let Slot: typeof import('./WorkspaceSidebarHeader').WorkspaceSidebarSlot;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let dom: Window;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();

const workspace: RepoWorkspaceResolved = {
  id: 'ws_1',
  name: 'Shop Platform',
  primaryProjectId: 'p_api',
  createdRefs: ['web'],
  refs: [],
  refsError: null,
  repos: [
    { projectId: 'p_api', alias: 'api', description: 'api', branch: 'main', readOnly: false, missing: false, project: null },
    { projectId: 'p_web', alias: 'web', description: 'web', branch: 'main', readOnly: false, missing: false, project: null },
  ],
};

type SlotProps = React.ComponentProps<typeof Slot>;

const baseProps: SlotProps = {
  status: 'loading',
  workspaces: [],
  activeWorkspace: null,
  discarded: 0,
  activating: false,
  onRetry: () => undefined,
  onSelect: () => undefined,
  onCreate: () => undefined,
  onEdit: () => undefined,
  onManage: () => undefined,
};

const render = async (props: Partial<SlotProps>) => {
  await act(async () => root.render(
    <I18nProvider>
      <Slot {...baseProps} {...props} />
    </I18nProvider>,
  ));
};

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    SVGElement: dom.SVGElement, Document: dom.Document, DocumentFragment: dom.DocumentFragment,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent, KeyboardEvent: dom.KeyboardEvent,
    DOMRect: dom.DOMRect, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  ({ WorkspaceSidebarSlot: Slot } = await import('./WorkspaceSidebarHeader'));
  ({ I18nProvider } = await import('@/lib/i18n'));
  const { createRoot } = await import('react-dom/client');
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

describe('workspace sidebar slot', () => {
  test('the first read shows the skeleton only while there is no data', async () => {
    await render({});
    expect(document.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading workspaces');
    expect(document.body.textContent).not.toContain('All projects');
  });

  test('a failed reload keeps the last header and shows the retry beside it', async () => {
    await render({ status: 'error', workspaces: [workspace], activeWorkspace: workspace });
    expect(document.body.textContent).toContain('Shop Platform');
    expect(document.body.textContent).toContain("Couldn't load workspaces.");
    expect(document.querySelector('[aria-label="Loading workspaces"]')).toBeNull();
  });

  test('the empty card appears only on a ready read with no workspace', async () => {
    await render({ status: 'ready' });
    expect(document.body.textContent).toContain('Several repos, one session.');

    await render({ status: 'error' });
    expect(document.body.textContent).not.toContain('Several repos, one session.');
    expect(document.body.textContent).toContain("Couldn't load workspaces.");
  });

  test('the header lists the repos and the menu when data exists', async () => {
    await render({ status: 'ready', workspaces: [workspace], activeWorkspace: workspace });
    expect(document.body.textContent).toContain('Shop Platform');
    expect(document.body.textContent).toContain('2 repos');
    const trigger = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Shop Platform'));
    expect(trigger?.getAttribute('aria-label')).toBeNull();
    expect(trigger?.textContent).toContain('Shop Platform');
  });

  test('the workspace menu marks the active entry as a checked radio item', async () => {
    await render({ status: 'ready', workspaces: [workspace], activeWorkspace: workspace });
    const trigger = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Shop Platform'))!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });

    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Shop Platform');
    expect(items[1].textContent).toBe('All projects');
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    expect(items[1].getAttribute('aria-checked')).toBe('false');
  });
});
