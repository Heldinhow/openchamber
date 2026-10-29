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
let fetchResponse: (input: string, init?: RequestInit) => Promise<Response>;
let reads = 0;

const documentPayload = {
  workspaces: [{
    id: 'ws_1',
    name: 'Shop Platform',
    directory: '/data/workspaces/ws_1',
    projects: [{ projectId: 'p_api', missing: false, project: { id: 'p_api', path: '/repos/api', label: 'API' } }],
    configError: null,
  }],
  discarded: 0,
};

const Probe = () => {
  const workspaces = useRepoWorkspaces({ enabled: true });
  return (
    <span data-id="state">
      {JSON.stringify({
        status: workspaces.status,
        ids: workspaces.workspaces.map((workspace) => workspace.id),
        names: workspaces.workspaces.map((workspace) => workspace.name),
        directories: workspaces.workspaces.map((workspace) => workspace.directory),
        discarded: workspaces.discarded,
      })}
    </span>
  );
};

type ProbeState = {
  status: string;
  ids: string[];
  names: string[];
  directories: string[];
  discarded: number;
};

const state = (): ProbeState => JSON.parse(
  document.querySelector('[data-id="state"]')?.textContent ?? '{}',
);

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
  reads = 0;
  fetchResponse = async () => {
    reads += 1;
    return Response.json(documentPayload);
  };
  globalThis.fetch = async (input, init) => fetchResponse(String(input), init);
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
  beforeEach(async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  test('loads the resolved list with its neutral directories', async () => {
    await act(async () => root.render(<Probe />));

    expect(state()).toEqual({
      status: 'ready',
      ids: ['ws_1'],
      names: ['Shop Platform'],
      directories: ['/data/workspaces/ws_1'],
      discarded: 0,
    });
  });

  test('a failed reload keeps the resolved list', async () => {
    await act(async () => root.render(<Probe />));
    expect(state().status).toBe('ready');

    fetchResponse = async () => { throw new Error('offline'); };
    await act(async () => {
      window.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
        detail: { settings: { workspaces: [{ id: 'ws_1', name: 'Renamed', projectIds: ['p_api'] }] } },
      }));
    });

    expect(state()).toMatchObject({ status: 'error', ids: ['ws_1'], names: ['Shop Platform'] });
  });

  test('a workspace list changed in another window is read once', async () => {
    await act(async () => root.render(<Probe />));
    expect(reads).toBe(1);

    fetchResponse = async () => {
      reads += 1;
      return Response.json({
        ...documentPayload,
        workspaces: [{ ...documentPayload.workspaces[0], name: 'Renamed' }],
      });
    };
    await act(async () => {
      window.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
        detail: { settings: { workspaces: [{ id: 'ws_1', name: 'Renamed', projectIds: ['p_api'] }] } },
      }));
    });

    expect(reads).toBe(2);
    expect(state()).toMatchObject({ status: 'ready', names: ['Renamed'] });
  });

  test('a runtime without the route is unavailable, not an error', async () => {
    fetchResponse = async () => new Response('Not found', { status: 404 });

    await act(async () => root.render(<Probe />));

    expect(state()).toMatchObject({ status: 'unavailable', ids: [] });
  });
});
