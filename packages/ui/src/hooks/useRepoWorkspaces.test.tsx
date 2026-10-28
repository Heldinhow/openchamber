import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

let useRepoWorkspaces: typeof import('./useRepoWorkspaces').useRepoWorkspaces;

const globals = new Map<string, PropertyDescriptor | undefined>();
let dom: Window;
let root: Root;
let host: HTMLElement;
const realFetch = globalThis.fetch;
let fetchResponse: () => Promise<Response>;

const documentPayload = {
  workspaces: [
    {
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
    },
    {
      id: 'ws_2',
      name: 'Docs',
      primaryProjectId: 'p_docs',
      repos: [
        { projectId: 'p_docs', alias: 'docs', description: 'docs', branch: 'main', missing: false, project: null },
      ],
      createdRefs: [],
      refs: [{
        alias: 'docs',
        path: '/repos/docs',
        description: 'docs',
        status: 'ok',
        owned: false,
        current: { path: '/repos/docs', description: 'docs' },
      }],
      refsError: null,
    },
  ],
  activeWorkspaceId: 'ws_1',
  discarded: 0,
  refs: [],
  refsError: null,
};

const Probe = () => {
  const workspaces = useRepoWorkspaces({ enabled: true });
  return (
    <span data-id="state">
      {JSON.stringify({
        status: workspaces.status,
        ids: workspaces.workspaces.map((workspace) => workspace.id),
        active: workspaces.activeWorkspace?.id ?? null,
        docsRefs: workspaces.workspaces.find((workspace) => workspace.id === 'ws_2')?.refs.length ?? null,
      })}
    </span>
  );
};

const state = (): { status: string; ids: string[]; active: string | null; docsRefs: number | null } => {
  const text = host.querySelector('[data-id="state"]')?.textContent ?? '{}';
  return JSON.parse(text);
};

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    SVGElement: dom.SVGElement, Document: dom.Document, DocumentFragment: dom.DocumentFragment,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
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
  ({ useRepoWorkspaces } = await import('./useRepoWorkspaces'));
  fetchResponse = async () => Response.json({});
  globalThis.fetch = async () => fetchResponse();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = realFetch;
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
  await dom.happyDOM.abort();
  dom.close();
});

describe('useRepoWorkspaces', () => {
  test('a failed reload keeps the resolved list and its active workspace', async () => {
    fetchResponse = async () => Response.json(documentPayload);

    await act(async () => root.render(<Probe />));
    expect(state()).toMatchObject({
      status: 'ready',
      ids: ['ws_1', 'ws_2'],
      active: 'ws_1',
      docsRefs: 1,
    });

    fetchResponse = async () => { throw new Error('offline'); };
    await act(async () => {
      window.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
        detail: { settings: { workspaces: documentPayload.workspaces, activeWorkspaceId: 'ws_1' } },
      }));
    });

    expect(state()).toMatchObject({
      status: 'error',
      ids: ['ws_1', 'ws_2'],
      active: 'ws_1',
      docsRefs: 1,
    });
  });
});
