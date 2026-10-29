import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { toast } from 'sonner';
import {
  RepoWorkspaceRequestError,
  type RepoWorkspaceFolderInput,
  type RepoWorkspaceResolved,
  type RepoWorkspaceSaveResult,
} from '@/lib/repoWorkspaces/client';

let Form: typeof import('./RepoWorkspaceCreateForm').RepoWorkspaceCreateForm;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let dom: Window;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();

const workspace: RepoWorkspaceResolved = {
  id: 'ws_1',
  name: 'Shop Platform',
  directory: '/data/workspaces/ws_1',
  projects: [
    { projectId: 'p_api', missing: false, project: { id: 'p_api', path: '/repos/api', label: 'API' } },
    { projectId: 'p_web', missing: false, project: { id: 'p_web', path: '/repos/web', label: 'Web' } },
  ],
  configError: null,
};

const savedResult = (): RepoWorkspaceSaveResult => ({ workspace, configError: null });

const submit = async () => {
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};

const nameInput = () => document.querySelector<HTMLInputElement>('form input')!;

const saveButton = () => document.querySelector<HTMLButtonElement>('form button[type="submit"]')!;

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
  toast.dismiss();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
  await dom.happyDOM.abort();
  dom.close();
});

describe('workspace create form', () => {
  test('an empty name or no folders keeps save disabled and sends nothing', async () => {
    let calls = 0;
    await act(async () => root.render(
      <I18nProvider>
        <Form
          editing={null}
          titleId="workspace-title"
          onClose={() => undefined}
          onSaved={() => undefined}
          createWorkspace={async () => {
            calls += 1;
            return savedResult();
          }}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).toContain('Create workspace');
    expect(document.body.textContent).not.toContain('Add at least one folder.');
    expect(saveButton().disabled).toBe(true);

    await submit();
    expect(document.body.textContent).toContain('Add at least one folder.');
    expect(document.body.textContent).toContain('Enter a name.');
    expect(calls).toBe(0);

    await act(async () => {
      const input = nameInput();
      const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Shop');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit();

    expect(calls).toBe(0);
    expect(document.body.textContent).toContain('Add at least one folder.');
  });

  test('edit shows the saved name and folders and saves them in order', async () => {
    let saved: { id: string; input: unknown } | null = null;
    let onSaved = 0;
    let onClose = 0;
    await act(async () => root.render(
      <I18nProvider>
        <Form
          editing={workspace}
          titleId="workspace-title"
          onClose={() => { onClose += 1; }}
          onSaved={() => { onSaved += 1; }}
          updateWorkspace={async (id, input) => {
            saved = { id, input };
            return savedResult();
          }}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).toContain('Edit Shop Platform');
    expect(document.body.textContent).toContain('/repos/api');
    expect(document.body.textContent).toContain('/repos/web');

    await submit();

    expect(saved).toEqual({
      id: 'ws_1',
      input: { name: 'Shop Platform', folders: [{ path: '/repos/api' }, { path: '/repos/web' }] },
    });
    expect(onSaved).toBe(1);
    expect(onClose).toBe(1);
  });

  test('a missing project row keeps its project id', async () => {
    let savedFolders: RepoWorkspaceFolderInput[] | null = null;
    const missingWorkspace: RepoWorkspaceResolved = {
      ...workspace,
      projects: [
        workspace.projects[0],
        { projectId: 'p_gone', missing: true, project: null },
      ],
    };
    await act(async () => root.render(
      <I18nProvider>
        <Form
          editing={missingWorkspace}
          titleId="workspace-title"
          onClose={() => undefined}
          onSaved={() => undefined}
          updateWorkspace={async (_id, input) => {
            savedFolders = input.folders;
            return savedResult();
          }}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).toContain('Project not found');
    await submit();

    expect(savedFolders).toEqual([{ path: '/repos/api' }, { projectId: 'p_gone' }]);
  });

  test('server folder errors are shown inline on their row', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <Form
          editing={workspace}
          titleId="workspace-title"
          onClose={() => undefined}
          onSaved={() => undefined}
          updateWorkspace={async () => {
            throw new RepoWorkspaceRequestError(422, {
              error: 'Workspace is invalid',
              fields: { 'folders[0].path': 'Directory not found' },
            });
          }}
        />
      </I18nProvider>,
    ));

    await submit();

    expect(document.body.textContent).toContain('Folder not found.');
    expect(document.body.textContent).not.toContain('Directory not found');
  });
});
