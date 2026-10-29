import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import { WorkspaceSidebarSlot } from './WorkspaceSidebarHeader';

const workspace: RepoWorkspaceResolved = {
  id: 'ws_product',
  name: 'Product',
  directory: '/data/workspaces/ws_product',
  projects: [],
  configError: null,
};

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const button = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

test('the plus starts a session owned by the workspace and Edit opens the same workspace', async () => {
  const sessions: string[] = [];
  const edits: string[] = [];
  await act(async () => root.render(
    <I18nProvider>
      <WorkspaceSidebarSlot
        status="ready"
        workspaces={[workspace]}
        discarded={0}
        onRetry={() => undefined}
        onNewSession={(entry) => sessions.push(entry.id)}
        onEdit={(entry) => edits.push(entry.id)}
      />
    </I18nProvider>,
  ));

  const newSession = button('New session in Product');
  const edit = button('Edit Product');
  if (!newSession || !edit) throw new Error('workspace controls missing');
  await act(async () => newSession.click());
  await act(async () => edit.click());

  expect(sessions).toEqual([workspace.id]);
  expect(edits).toEqual([workspace.id]);
});
