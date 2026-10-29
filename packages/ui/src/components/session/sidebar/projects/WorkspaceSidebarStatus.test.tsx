import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';

const renderStatus = async (status: 'loading' | 'ready' | 'error' | 'unavailable', options: { hasRows?: boolean; discarded?: number } = {}) => {
  const win = new Window({ url: 'http://localhost' });
  const values = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { WorkspaceSidebarStatus } = await import('./WorkspaceSectionRow');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let retries = 0;
  await act(async () => root.render(
    <I18nProvider>
      <WorkspaceSidebarStatus
        status={status}
        hasRows={options.hasRows ?? false}
        discarded={options.discarded ?? 0}
        onRetry={() => { retries += 1; }}
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
  return { container, retries: () => retries, cleanup };
};

test('a failed workspace read is reported and retryable beside the last rows', async () => {
  const status = await renderStatus('error', { hasRows: true });
  try {
    expect(status.container.textContent).toContain('Couldn\'t load workspaces.');
    const retry = status.container.querySelector<HTMLButtonElement>('button');
    await act(async () => retry?.click());
    expect(status.retries()).toBe(1);
  } finally {
    await status.cleanup();
  }
});

test('the first read shows a loading placeholder and dropped entries are counted', async () => {
  const loading = await renderStatus('loading');
  try {
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
  } finally {
    await loading.cleanup();
  }

  const discarded = await renderStatus('ready', { hasRows: true, discarded: 2 });
  try {
    expect(discarded.container.textContent).toContain('2 workspaces were discarded');
  } finally {
    await discarded.cleanup();
  }
});
