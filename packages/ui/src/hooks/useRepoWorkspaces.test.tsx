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
let seen: Array<{ active: string | null; refs: number }> = [];

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
  seen.push({ active: workspaces.activeWorkspace?.id ?? null, refs: workspaces.refs.length });
  return (
    <>
      <span data-id="state">
        {JSON.stringify({
          status: workspaces.status,
          ids: workspaces.workspaces.map((workspace) => workspace.id),
          active: workspaces.activeWorkspace?.id ?? null,
          name: workspaces.activeWorkspace?.name ?? null,
          refs: workspaces.refs.map((ref) => ref.alias),
          docsRefs: workspaces.workspaces.find((workspace) => workspace.id === 'ws_2')?.refs.length ?? null,
        })}
      </span>
      <button type="button" onClick={() => void workspaces.selectWorkspace('ws_2')}>switch</button>
    </>
  );
};

type ProbeState = {
  status: string;
  ids: string[];
  active: string | null;
  name: string | null;
  refs: string[];
  docsRefs: number | null;
};

const state = (): ProbeState => {
  const text = host.querySelector('[data-id="state"]')?.textContent ?? '{}';
  return JSON.parse(text);
};

const pressSwitch = async () => {
  const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent === 'switch');
  expect(button !== undefined).toBe(true);
  await act(async () => {
    button!.click();
  });
};

const docsRef = {
  alias: 'docs',
  path: '/repos/docs',
  description: 'docs',
  status: 'ok',
  owned: false,
  current: { path: '/repos/docs', description: 'docs' },
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
  globalThis.fetch = async (input, init) => fetchResponse(String(input), init);
  seen = [];
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

  test('a switch changes the workspace name and its references together', async () => {
    fetchResponse = async () => Response.json(documentPayload);
    await act(async () => root.render(<Probe />));
    expect(state()).toMatchObject({ active: 'ws_1', name: 'Shop Platform', refs: [] });

    // The switch's read stays open so the intermediate state can be inspected.
    let resolveRead: (response: Response) => void = () => undefined;
    const read = new Promise<Response>((resolve) => { resolveRead = resolve; });
    fetchResponse = async (input) => {
      if (String(input).endsWith('/api/workspaces')) return read;
      return Response.json({ activeWorkspaceId: 'ws_2' });
    };

    await pressSwitch();
    // The previous complete view stays until the read answers: no new name
    // paired with the old, empty reference list.
    expect(state()).toMatchObject({ active: 'ws_1', name: 'Shop Platform', refs: [] });

    await act(async () => {
      resolveRead(Response.json({
        ...documentPayload,
        activeWorkspaceId: 'ws_2',
        refs: [docsRef],
      }));
    });

    expect(state()).toMatchObject({ status: 'ready', active: 'ws_2', name: 'Docs', refs: ['docs'] });
    expect(seen.every((entry) => !(entry.active === 'ws_2' && entry.refs === 0))).toBe(true);
  });

  test('a failed switch read applies the activated pointer with that workspace\'s last refs', async () => {
    fetchResponse = async () => Response.json(documentPayload);
    await act(async () => root.render(<Probe />));
    expect(state()).toMatchObject({ status: 'ready', active: 'ws_1' });

    fetchResponse = async (input) => {
      if (String(input).endsWith('/api/workspaces')) throw new Error('offline');
      return Response.json({ activeWorkspaceId: 'ws_2' });
    };

    await pressSwitch();

    // The old workspace is not claimed and the new one is not shown as having
    // no references: the last document's own refs for it are used, with Retry.
    expect(state()).toMatchObject({
      status: 'error',
      active: 'ws_2',
      name: 'Docs',
      refs: ['docs'],
    });
  });
});
