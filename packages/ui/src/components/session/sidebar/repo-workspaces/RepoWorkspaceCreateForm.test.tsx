import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { CreateRepoWorkspaceResult } from '@/lib/repoWorkspaces/client';
import type { RepoWorkspaceDraft } from './repoWorkspaceDraft';

let Form: typeof import('./RepoWorkspaceCreateForm').RepoWorkspaceCreateForm;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let dom: Window;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();

const draft: RepoWorkspaceDraft = {
  name: 'Shop Platform',
  rows: [
    { key: 'a', path: '/repos/api', alias: 'api' },
    { key: 'b', path: '/repos/web', alias: 'web' },
  ],
  primaryKey: 'a',
};

const workspace = {
  id: 'ws_1',
  name: 'Shop Platform',
  primaryProjectId: 'p_api',
  repos: [
    { projectId: 'p_api', alias: 'api', description: 'api', branch: 'main', missing: false, project: null },
    { projectId: 'p_web', alias: 'web', description: 'web', branch: 'main', missing: false, project: null },
  ],
  createdRefs: ['web'],
};

const pendingResult = (): CreateRepoWorkspaceResult => ({
  workspace,
  refs: [],
  refWrites: [{ alias: 'web', status: 'failed' }],
  refsError: null,
  configTarget: { path: '/repos/api/.opencode/opencode.json', rootConfigPath: null },
});

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
    SVGElement: dom.SVGElement, Document: dom.Document, DocumentFragment: dom.DocumentFragment,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent, KeyboardEvent: dom.KeyboardEvent, FocusEvent: dom.FocusEvent,
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
  ({ RepoWorkspaceCreateForm: Form } = await import('./RepoWorkspaceCreateForm'));
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

describe('workspace create form', () => {
  test('a failed reference write replaces the form with the pending card and retries one alias', async () => {
    let created = 0;
    let cancelled = 0;
    let retried: string[] = [];

    await act(async () => root.render(
      <I18nProvider>
        <Form
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => { cancelled += 1; }}
          onCreated={() => { created += 1; }}
          onRefsChanged={() => undefined}
          createWorkspace={async () => pendingResult()}
          retryRefs={async (_id, aliases) => {
            retried = aliases ?? [];
            return {
              refs: [],
              refWrites: [{ alias: 'web', status: 'written' }],
              refsError: null,
              configTarget: { path: '/repos/api/.opencode/opencode.json', rootConfigPath: null },
            };
          }}
        />
      </I18nProvider>,
    ));

    const form = document.querySelector('form');
    expect(form !== null).toBe(true);
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(created).toBe(1);
    expect(cancelled).toBe(0);
    expect(document.body.textContent).toContain('Workspace created, references pending');
    expect(document.body.textContent).toContain('/repos/api/.opencode/opencode.json');
    expect(document.body.textContent).toContain('@web');

    const retryButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Try again');
    expect(retryButton !== undefined).toBe(true);
    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(retried).toEqual(['web']);
    expect(cancelled).toBe(1);
  });

  test('an invalid draft keeps the create button disabled and sends nothing', async () => {
    let calls = 0;
    await act(async () => root.render(
      <I18nProvider>
        <Form
          initialDraft={{
            ...draft,
            rows: [{ key: 'a', path: '/repos/api', alias: 'web app' }],
          }}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
          createWorkspace={async () => {
            calls += 1;
            return pendingResult();
          }}
        />
      </I18nProvider>,
    ));

    const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
    expect(submit?.disabled).toBe(true);
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls).toBe(0);
  });
});
