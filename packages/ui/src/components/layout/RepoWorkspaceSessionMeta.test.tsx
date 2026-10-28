import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RepoWorkspaceRef } from '@/lib/repoWorkspaces/client';

let SessionMeta: typeof import('./RepoWorkspaceSessionMeta').RepoWorkspaceSessionMeta;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let dom: Window;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();

const ref = (overrides: Partial<RepoWorkspaceRef>): RepoWorkspaceRef => ({
  alias: 'web',
  path: '/shop/web',
  description: 'web',
  status: 'ok',
  owned: true,
  current: null,
  ...overrides,
});

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement, SVGElement: dom.SVGElement,
    Document: dom.Document, DocumentFragment: dom.DocumentFragment,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  ({ RepoWorkspaceSessionMeta: SessionMeta } = await import('./RepoWorkspaceSessionMeta'));
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

const render = async (refs: RepoWorkspaceRef[], onRetry: (alias: string) => void = () => {}) => {
  await act(async () => root.render(
    <I18nProvider>
      <SessionMeta
        workspaceName="Shop Platform"
        refs={refs}
        refsError={null}
        retryingAliases={new Set()}
        onRetry={onRetry}
      />
    </I18nProvider>,
  ));
};

describe('RepoWorkspaceSessionMeta', () => {
  test('shows the workspace, the subtitle, ok chips and the other statuses as states', async () => {
    await render([
      ref({ alias: 'web', status: 'ok', path: '/shop/web' }),
      ref({ alias: 'gone', status: 'missing', path: '/shop/gone' }),
      ref({ alias: 'docs', status: 'outside', current: { path: '/elsewhere/docs', description: 'docs' }, owned: false }),
      ref({ alias: 'ui', status: 'overridden', current: { path: '/shop/ui', description: 'ui' } }),
    ]);

    expect(document.body.textContent).toContain('Shop Platform');
    expect(document.body.textContent).toContain('Session open in the primary');

    const chip = [...document.querySelectorAll('span')].find((element) => element.textContent?.startsWith('@web'));
    expect(chip?.getAttribute('title')).toBe('/shop/web');
    expect(chip?.className).toContain('rounded-full');
    expect(chip?.querySelector('.sr-only')?.textContent?.trim()).toBe('/shop/web');

    expect(document.body.textContent).toContain('@gone');
    expect(document.body.textContent).toContain('missing');
    const missingState = [...document.querySelectorAll('span')]
      .find((element) => element.textContent?.includes('@gone') && element.textContent?.includes('missing'));
    expect(missingState?.querySelector('.sr-only')?.textContent?.trim()).toBe('/shop/gone');
    expect(document.body.textContent).toContain('defined outside this workspace');
    expect(document.body.textContent).toContain('another layer also defines this alias');

    const missingChip = [...document.querySelectorAll('span')].find((element) => element.getAttribute('title') === '/shop/gone');
    expect(missingChip).toBeUndefined();
  });

  test('an owned missing reference offers retry and calls it with the alias', async () => {
    const retried: string[] = [];
    await render([ref({ alias: 'gone', status: 'missing' })], (alias) => retried.push(alias));

    const button = [...document.querySelectorAll('button')].find((element) => element.textContent === 'Try again');
    expect(button?.getAttribute('aria-label')).toBe('Try again for @gone');
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(retried).toEqual(['gone']);
  });

  test('a missing reference the workspace does not own shows no retry', async () => {
    await render([ref({ alias: 'gone', status: 'missing', owned: false })]);
    expect([...document.querySelectorAll('button')]).toHaveLength(0);
  });
});
