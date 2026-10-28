import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import type { DeleteRepoWorkspaceResult } from '@/lib/repoWorkspaces/client';

let ManageDialog: typeof import('./RepoWorkspaceManageDialogs').RepoWorkspaceManageDialog;
let DeleteDialog: typeof import('./RepoWorkspaceManageDialogs').RepoWorkspaceDeleteDialog;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let dom: Window;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();

const workspaceWith = (overrides: Partial<RepoWorkspaceResolved>): RepoWorkspaceResolved => ({
  id: 'ws_1',
  name: 'Shop Platform',
  primaryProjectId: 'p_api',
  repos: [
    { projectId: 'p_api', alias: 'api', description: 'api', branch: 'main', missing: false, project: null },
    { projectId: 'p_web', alias: 'web', description: 'web', branch: 'main', missing: false, project: null },
  ],
  createdRefs: ['web'],
  refs: [],
  refsError: null,
  ...overrides,
});

const deleteResult = (overrides: Partial<DeleteRepoWorkspaceResult>): DeleteRepoWorkspaceResult => ({
  removed: true,
  refs: [],
  failedAlias: null,
  configError: null,
  ...overrides,
});

const buttonLabels = () => [...document.querySelectorAll('button')].map((button) => button.textContent);

const clickButton = async (label: string) => {
  const button = [...document.querySelectorAll('button')].find((element) => element.textContent === label);
  expect(button !== undefined).toBe(true);
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

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
  ({ RepoWorkspaceManageDialog: ManageDialog, RepoWorkspaceDeleteDialog: DeleteDialog } = await import('./RepoWorkspaceManageDialogs'));
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

describe('manage workspaces list', () => {
  test('lists every workspace with its repo count and the active one, and opens edit', async () => {
    const edited: string[] = [];
    const active = workspaceWith({ id: 'ws_1', name: 'Shop Platform' });
    const other = workspaceWith({
      id: 'ws_2',
      name: 'Docs',
      repos: [{ projectId: 'p_docs', alias: 'docs', description: 'docs', branch: '', missing: false, project: null }],
      createdRefs: [],
    });

    await act(async () => root.render(
      <I18nProvider>
        <ManageDialog
          open
          onOpenChange={() => undefined}
          workspaces={[active, other]}
          activeWorkspaceId="ws_1"
          activating={false}
          onActivate={() => undefined}
          onEdit={(workspace) => edited.push(workspace.id)}
          onDelete={() => undefined}
        />
      </I18nProvider>,
    ));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Shop Platform');
    expect(text).toContain('2 repos');
    expect(text).toContain('Docs');
    expect(text).toContain('1 repo');
    expect(text).toContain('Active');

    const currentRows = document.querySelectorAll('li[aria-current="true"]');
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0].textContent).toContain('Shop Platform');

    const edit = [...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'Edit Shop Platform');
    expect(edit !== undefined).toBe(true);
    await act(async () => {
      edit!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(edited).toEqual(['ws_1']);
  });
});

describe('delete workspace question', () => {
  test('warns that sessions stay and lists only the owned aliases', async () => {
    const workspace = workspaceWith({
      repos: [
        { projectId: 'p_api', alias: 'api', description: 'api', branch: '', missing: false, project: null },
        { projectId: 'p_web', alias: 'web', description: 'web', branch: '', missing: false, project: null },
        { projectId: 'p_docs', alias: 'docs', description: 'docs', branch: '', missing: false, project: null },
      ],
    });

    await act(async () => root.render(
      <I18nProvider>
        <DeleteDialog
          open
          workspace={workspace}
          onOpenChange={() => undefined}
          onDeleted={() => undefined}
          deleteWorkspace={async () => deleteResult({})}
        />
      </I18nProvider>,
    ));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Delete Shop Platform?');
    expect(text).toContain('Sessions stay in their repos.');
    expect(text).toContain('Remove @web from the primary repository config');
    expect(text).toContain('Only the references this workspace created.');
    // `docs` is a secondary alias the user owns, so it is not offered.
    expect(text).not.toContain('@docs');
  });

  test('a removal that fails keeps the workspace, names the alias and offers both next steps', async () => {
    const calls: Array<[string, boolean]> = [];
    let closed = 0;
    let deleted = 0;

    await act(async () => root.render(
      <I18nProvider>
        <DeleteDialog
          open
          workspace={workspaceWith({})}
          onOpenChange={(open) => { if (!open) closed += 1; }}
          onDeleted={() => { deleted += 1; }}
          deleteWorkspace={async (id, removeRefs) => {
            calls.push([id, removeRefs]);
            return deleteResult({ removed: false, failedAlias: 'web' });
          }}
        />
      </I18nProvider>,
    ));

    await clickButton('Delete');

    expect(calls).toEqual([['ws_1', true]]);
    expect(deleted).toBe(0);
    expect(closed).toBe(0);
    expect(document.body.textContent).toContain("Couldn't remove @web. Nothing was deleted.");
    expect(buttonLabels()).toContain('Delete without removing @web');
    expect(buttonLabels()).toContain('Remove @web anyway');
  });

  test('deleting without removing the reference retries with removeCreatedRefs false and closes', async () => {
    const calls: Array<[string, boolean, string[]?]> = [];
    let closed = 0;
    let deleted = 0;

    await act(async () => root.render(
      <I18nProvider>
        <DeleteDialog
          open
          workspace={workspaceWith({})}
          onOpenChange={(open) => { if (!open) closed += 1; }}
          onDeleted={() => { deleted += 1; }}
          deleteWorkspace={async (id, removeRefs, confirmRefs) => {
            calls.push(confirmRefs ? [id, removeRefs, confirmRefs] : [id, removeRefs]);
            return calls.length === 1 ? deleteResult({ removed: false, failedAlias: 'web' }) : deleteResult({});
          }}
        />
      </I18nProvider>,
    ));

    await clickButton('Delete');
    await clickButton('Delete without removing @web');

    expect(calls).toEqual([['ws_1', true], ['ws_1', false]]);
    expect(deleted).toBe(1);
    expect(closed).toBe(1);
  });

  test('removing the edited reference anyway retries with confirmRefs and closes', async () => {
    const calls: Array<[string, boolean, string[]?]> = [];
    let closed = 0;

    await act(async () => root.render(
      <I18nProvider>
        <DeleteDialog
          open
          workspace={workspaceWith({})}
          onOpenChange={(open) => { if (!open) closed += 1; }}
          onDeleted={() => undefined}
          deleteWorkspace={async (id, removeRefs, confirmRefs) => {
            calls.push(confirmRefs ? [id, removeRefs, confirmRefs] : [id, removeRefs]);
            return calls.length === 1 ? deleteResult({ removed: false, failedAlias: 'web' }) : deleteResult({});
          }}
        />
      </I18nProvider>,
    ));

    await clickButton('Delete');
    await clickButton('Remove @web anyway');

    expect(calls).toEqual([['ws_1', true], ['ws_1', true, ['web']]]);
    expect(closed).toBe(1);
  });

  test('a failure without an alias shows only the message', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <DeleteDialog
          open
          workspace={workspaceWith({})}
          onOpenChange={() => undefined}
          onDeleted={() => undefined}
          deleteWorkspace={async () => deleteResult({ removed: false, failedAlias: null })}
        />
      </I18nProvider>,
    ));

    await clickButton('Delete');

    expect(document.body.textContent).toContain("Couldn't delete the workspace.");
    expect(buttonLabels()).not.toContain('Delete without removing @web');
    expect(buttonLabels()).not.toContain('Remove @web anyway');
  });

  test('a second failure keeps the dialog open with the message', async () => {
    const calls: Array<[string, boolean, string[]?]> = [];
    let closed = 0;

    await act(async () => root.render(
      <I18nProvider>
        <DeleteDialog
          open
          workspace={workspaceWith({})}
          onOpenChange={(open) => { if (!open) closed += 1; }}
          onDeleted={() => undefined}
          deleteWorkspace={async (id, removeRefs, confirmRefs) => {
            calls.push(confirmRefs ? [id, removeRefs, confirmRefs] : [id, removeRefs]);
            return deleteResult({ removed: false, failedAlias: 'web' });
          }}
        />
      </I18nProvider>,
    ));

    await clickButton('Delete');
    await clickButton('Remove @web anyway');

    expect(calls).toEqual([['ws_1', true], ['ws_1', true, ['web']]]);
    expect(closed).toBe(0);
    expect(document.body.textContent).toContain("Couldn't remove @web. Nothing was deleted.");
    expect(buttonLabels()).toContain('Remove @web anyway');
  });

  test('a successful delete reloads and closes', async () => {
    let closed = 0;
    let deleted = 0;

    await act(async () => root.render(
      <I18nProvider>
        <DeleteDialog
          open
          workspace={workspaceWith({})}
          onOpenChange={(open) => { if (!open) closed += 1; }}
          onDeleted={() => { deleted += 1; }}
          deleteWorkspace={async () => deleteResult({})}
        />
      </I18nProvider>,
    ));

    await clickButton('Delete');

    expect(deleted).toBe(1);
    expect(closed).toBe(1);
  });
});
