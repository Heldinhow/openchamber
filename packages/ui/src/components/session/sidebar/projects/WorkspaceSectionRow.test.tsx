import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import type { WorkspaceSection } from './workspaceSections';

const workspace: WorkspaceSection = {
  workspace: { id: 'ws_product', name: 'Product', directory: '/data/workspaces/ws_product' },
  nodes: [],
};

type RowCalls = { newSession: string[]; edit: string[]; toggles: number };

const renderRow = async (options: { forceExpanded?: boolean; alwaysShowActions?: boolean } = {}) => {
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
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { I18nProvider } = await import('@/lib/i18n');
  const { WorkspaceSectionRow } = await import('./WorkspaceSectionRow');
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const calls: RowCalls = { newSession: [], edit: [], toggles: 0 };
  let menuKey: string | null = null;
  const Row = () => {
    const [openMenuKey, setOpenMenuKey] = React.useState<string | null>(null);
    menuKey = openMenuKey;
    return (
      <WorkspaceSectionRow
        section={workspace}
        collapsed={false}
        forceExpanded={options.forceExpanded ?? false}
        alwaysShowActions={options.alwaysShowActions ?? false}
        openSidebarMenuKey={openMenuKey}
        setOpenSidebarMenuKey={setOpenMenuKey}
        onToggle={() => { calls.toggles += 1; }}
        onNewSession={(entry) => calls.newSession.push(entry.id)}
        onEdit={(id) => calls.edit.push(id)}
      />
    );
  };
  await act(async () => root.render(
    <ThemeSystemProvider>
      <I18nProvider>
        <Row />
      </I18nProvider>
    </ThemeSystemProvider>,
  ));
  const cleanup = async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  };
  const menuItem = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  return { calls, container, menuItem, getMenuKey: () => menuKey, cleanup };
};

test('the plus starts a workspace session and the menu holds only Edit', async () => {
  const row = await renderRow();
  try {
    const plus = row.container.querySelector<HTMLButtonElement>('button[aria-label="New session in Product"]');
    const menu = row.container.querySelector<HTMLButtonElement>('button[aria-label="Workspace menu for Product"]');
    if (!plus || !menu) throw new Error('workspace controls missing');

    expect(plus.className).toContain('group-hover/workspace:opacity-100');
    expect(plus.className).toContain('group-has-[:focus-visible]/workspace:opacity-100');
    expect(menu.className).toContain('group-hover/workspace:opacity-100');
    expect(menu.className).toContain('group-has-[:focus-visible]/workspace:opacity-100');
    // Both sit in the tab order, so keyboard focus reveals them the same way
    // hover does.
    await act(async () => plus.focus());
    expect(document.activeElement).toBe(plus);
    await act(async () => menu.focus());
    expect(document.activeElement).toBe(menu);

    await act(async () => plus.click());
    expect(row.calls.newSession).toEqual(['ws_product']);

    await act(async () => menu.click());
    const items = row.menuItem();
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Edit workspace']);
    expect(row.getMenuKey()).toBe('workspace:ws_product');

    await act(async () => items[0]?.click());
    expect(row.calls.edit).toEqual(['ws_product']);
    expect(row.getMenuKey()).toBeNull();
  } finally {
    await row.cleanup();
  }
});

test('the menu closes on Escape', async () => {
  const row = await renderRow();
  try {
    const menu = row.container.querySelector<HTMLButtonElement>('button[aria-label="Workspace menu for Product"]');
    if (!menu) throw new Error('workspace menu missing');

    await act(async () => menu.click());
    expect(row.menuItem()).toHaveLength(1);

    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(row.menuItem()).toHaveLength(0);
    expect(row.getMenuKey()).toBeNull();
  } finally {
    await row.cleanup();
  }
});

test('the name button toggles the section, and search keeps it open', async () => {
  const row = await renderRow();
  try {
    const toggle = row.container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!toggle) throw new Error('workspace toggle missing');
    await act(async () => toggle.click());
    expect(row.calls.toggles).toBe(1);
  } finally {
    await row.cleanup();
  }

  const searched = await renderRow({ forceExpanded: true });
  try {
    const toggle = searched.container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!toggle) throw new Error('workspace toggle missing');
    await act(async () => toggle.click());
    expect(searched.calls.toggles).toBe(0);
  } finally {
    await searched.cleanup();
  }
});
