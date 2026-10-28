import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { CreateRepoWorkspaceResult, RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
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

/** Base UI's hidden input is the element that actually changes; a synthetic
 * click on the styled box does not toggle it in happy-dom. */
const setCheckbox = (element: Element | undefined, checked: boolean) => {
  expect(element !== undefined).toBe(true);
  const input = element!.parentElement?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(input !== null).toBe(true);
  if (input!.checked !== checked) input!.click();
  expect(input!.checked).toBe(checked);
};

const resolvedWorkspace: RepoWorkspaceResolved = {
  id: 'ws_1',
  name: 'Shop Platform',
  primaryProjectId: 'p_api',
  repos: [
    {
      projectId: 'p_api',
      alias: 'api',
      description: 'api',
      branch: 'main',
      missing: false,
      project: { id: 'p_api', path: '/repos/api', label: 'api' },
    },
    {
      projectId: 'p_web',
      alias: 'web',
      description: 'web',
      branch: 'main',
      missing: false,
      project: { id: 'p_web', path: '/repos/web', label: 'web' },
    },
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

  test('editing shows the reference diff and requires confirmation before overwriting an edited entry', async () => {
    const updates: Array<{ id: string; input: unknown }> = [];
    const editing = {
      workspace: resolvedWorkspace,
      refs: [{
        alias: 'web',
        path: '/repos/web',
        description: 'web',
        status: 'different' as const,
        owned: true,
        current: { path: '/user/web', description: 'Edited' },
      }],
      refsError: null,
    };

    await act(async () => root.render(
      <I18nProvider>
        <Form
          editing={editing}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
          updateWorkspace={async (id, input) => {
            updates.push({ id, input });
            return {
              workspace: resolvedWorkspace,
              refs: [],
              refWrites: [],
              refsError: null,
              configTarget: { path: '/repos/api/.opencode/opencode.json', rootConfigPath: null },
            };
          }}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).toContain('Reference changes');
    expect(document.body.textContent).toContain('@web was edited outside the app. Overwrite it?');
    const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
    expect(submit?.disabled).toBe(true);

    const confirmation = [...document.querySelectorAll('[role="checkbox"]')]
      .find((element) => element.getAttribute('aria-label')?.includes('Overwrite it?'));
    await act(async () => {
      setCheckbox(confirmation, true);
    });

    expect(submit?.disabled).toBe(false);
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('ws_1');
    expect(updates[0].input).toMatchObject({
      name: 'Shop Platform',
      confirmRefs: ['web'],
      keepRefs: [],
      repos: [
        { projectId: 'p_api', alias: 'api', primary: true },
        { projectId: 'p_web', alias: 'web', primary: false },
      ],
    });
  });

  test('importing a .code-workspace fills the rows and skips only the unsupported folder', async () => {
    let importedPath: string | null = null;
    let created = 0;
    let cancelled = 0;

    await act(async () => root.render(
      <I18nProvider>
        <Form
          titleId="workspace-title"
          onClose={() => { cancelled += 1; }}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
          importWorkspace={async (filePath) => {
            importedPath = filePath;
            return {
              name: 'Shop Platform',
              folders: [
                { path: '/repos/api', alias: 'api', primary: true, error: null },
                { path: 'vscode-remote://ssh-remote+host/work/web', alias: '', primary: false, error: 'unsupported' },
                { path: '/repos/web', alias: 'web', primary: false, error: null },
              ],
            };
          }}
          createWorkspace={async () => {
            created += 1;
            return pendingResult();
          }}
        />
      </I18nProvider>,
    ));

    const pathInput = document.querySelector<HTMLInputElement>('input[placeholder="~/project.code-workspace"]');
    expect(pathInput !== null).toBe(true);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    expect(setValue !== undefined).toBe(true);
    await act(async () => {
      setValue!.call(pathInput, '/work/shop.code-workspace');
      pathInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const importButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Import .code-workspace');
    expect(importButton !== undefined).toBe(true);
    await act(async () => {
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(importedPath).toBe('/work/shop.code-workspace');
    expect(document.body.textContent).toContain('Skipped vscode-remote://ssh-remote+host/work/web: only local folders can be imported.');

    const nameField = [...document.querySelectorAll<HTMLInputElement>('input')]
      .find((input) => input.value === 'Shop Platform');
    expect(nameField !== undefined).toBe(true);
    const aliases = [...document.querySelectorAll<HTMLInputElement>('input')]
      .map((input) => input.value)
      .filter((value) => value === 'api' || value === 'web');
    expect(aliases).toEqual(['api', 'web']);
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('aria-label'))
      .toBe('Primary repository: /repos/api');

    expect(created).toBe(0);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Cancel');
    await act(async () => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(created).toBe(0);
    expect(cancelled).toBe(1);
  });

  test('removing a repo asks about its owned reference and keeps it when unchecked', async () => {
    const updates: Array<{ input: unknown }> = [];
    const editing = {
      workspace: resolvedWorkspace,
      refs: [{
        alias: 'web',
        path: '/repos/web',
        description: 'web',
        status: 'ok' as const,
        owned: true,
        current: { path: '/repos/web', description: 'web' },
      }],
      refsError: null,
    };

    await act(async () => root.render(
      <I18nProvider>
        <Form
          editing={editing}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
          updateWorkspace={async (_id, input) => {
            updates.push({ input });
            return {
              workspace: resolvedWorkspace,
              refs: [],
              refWrites: [],
              refsError: null,
              configTarget: { path: '/repos/api/.opencode/opencode.json', rootConfigPath: null },
            };
          }}
        />
      </I18nProvider>,
    ));

    const removeWeb = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === 'Remove /repos/web from the workspace');
    expect(removeWeb !== undefined).toBe(true);
    await act(async () => {
      removeWeb!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const keepQuestion = [...document.querySelectorAll('[role="checkbox"]')]
      .find((element) => element.getAttribute('aria-label')?.includes('Remove @web from the primary repository config'));
    await act(async () => {
      setCheckbox(keepQuestion, false);
    });

    const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].input).toMatchObject({
      keepRefs: ['web'],
      confirmRefs: [],
      repos: [{ projectId: 'p_api', alias: 'api', primary: true }],
    });
    expect(submit?.disabled).toBe(false);
  });
});
