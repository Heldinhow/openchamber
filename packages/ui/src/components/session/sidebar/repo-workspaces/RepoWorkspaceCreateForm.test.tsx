import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { CreateRepoWorkspaceResult, RepoWorkspaceConfigTarget, RepoWorkspaceImportDraft, RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
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
  refs: [],
  refsError: null,
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
  refs: [],
  refsError: null,
};

const pendingResult = (): CreateRepoWorkspaceResult => ({
  workspace,
  refs: [],
  refWrites: [{ alias: 'web', status: 'failed' }],
  refsError: null,
  configTarget: { path: '/repos/api/.opencode/opencode.json', rootConfigPath: null },
});

/** The target the server answers for a folder; these tests never hit the route. */
const targetFor = async (folderPath: string): Promise<RepoWorkspaceConfigTarget> => ({
  path: `${folderPath}/.opencode/opencode.json`,
  rootConfigPath: null,
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
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  useProjectsStore.setState({ projects: [], activeProjectId: null });
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
  const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

  const radioFor = (path: string) => radios().find((radio) => (
    radio.getAttribute('aria-label') === `Primary repository: ${path}`
    || radio.getAttribute('aria-label') === `Secondary repository: ${path}`
  ));

  const press = async (target: Element, key: string) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  };
  test('a failed reference write replaces the form with the pending card and retries one alias', async () => {
    let created = 0;
    let cancelled = 0;
    let retried: string[] = [];
    let retryConfirmations: string[] = [];

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => { cancelled += 1; }}
          onCreated={() => { created += 1; }}
          onRefsChanged={() => undefined}
          createWorkspace={async () => pendingResult()}
          retryRefs={async (_id, aliases, confirmations) => {
            retried = aliases ?? [];
            retryConfirmations = confirmations ?? [];
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
    expect(retryConfirmations).toEqual(['web']);
    expect(cancelled).toBe(1);
  });

  test('an untouched name field shows no error until it is blurred', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={{ name: '', rows: [], primaryKey: null }}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    const nameInput = document.querySelector<HTMLInputElement>('input')!;
    expect(document.body.textContent).not.toContain('Enter a name.');
    expect(nameInput.getAttribute('aria-invalid')).toBe('false');

    await act(async () => {
      nameInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Enter a name.');
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
  });

  test('submitting an empty form shows the name error and sends nothing', async () => {
    let calls = 0;
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={{ name: '', rows: [], primaryKey: null }}
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

    expect(document.body.textContent).not.toContain('Enter a name.');
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(document.body.textContent).toContain('Enter a name.');
    expect(document.querySelector<HTMLInputElement>('input')?.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled).toBe(true);
    expect(calls).toBe(0);
  });

  test('create stays disabled while an import is running', async () => {
    let resolveImport: (value: RepoWorkspaceImportDraft) => void = () => undefined;
    let calls = 0;
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
          importWorkspace={() => new Promise((resolve) => { resolveImport = resolve; })}
          createWorkspace={async () => {
            calls += 1;
            return pendingResult();
          }}
        />
      </I18nProvider>,
    ));

    const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
    expect(submit?.disabled).toBe(false);

    const pathInput = document.querySelector<HTMLInputElement>('input[placeholder="~/project.code-workspace"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue!.call(pathInput, '/work/shop.code-workspace');
      pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const importButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Import .code-workspace')!;
    await act(async () => {
      importButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(submit?.disabled).toBe(true);
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls).toBe(0);

    await act(async () => {
      resolveImport({ name: 'Shop Platform', folders: [] });
    });
  });

  test('an invalid draft keeps the create button disabled and sends nothing', async () => {
    let calls = 0;
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
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

  test('the primary error is referenced by the fieldset', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={{ name: 'Shop Platform', rows: [], primaryKey: null }}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    const fieldset = document.querySelector('fieldset');
    const describedBy = fieldset?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const error = document.getElementById(describedBy!);
    expect(error?.textContent).toBe('Add at least one folder.');
  });

  test('the primary column is grouped by its fieldset legend with a single Tab stop', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    const fieldset = document.querySelector('fieldset');
    expect(fieldset !== null).toBe(true);
    const legend = fieldset!.querySelector('legend');
    expect(legend?.textContent).toBe('Primary repository');
    // The fieldset holds inputs and buttons too, so it must not claim to be a
    // radiogroup; the native legend names it and the radios live inside it.
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(fieldset!.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(radios()[0].tabIndex).toBe(0);
    expect(radios()[1].tabIndex).toBe(-1);
  });

  test('arrow keys move the primary and focus with the selection', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    const api = radioFor('/repos/api')!;
    const web = radioFor('/repos/web')!;
    api.focus();

    await press(api, 'ArrowDown');
    expect(web.getAttribute('aria-checked')).toBe('true');
    expect(api.getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(web);
    expect(api.tabIndex).toBe(-1);
    expect(web.tabIndex).toBe(0);

    await press(web, 'ArrowUp');
    expect(api.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(api);

    await press(api, 'ArrowUp');
    expect(web.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(web);

    await press(web, 'Home');
    expect(api.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(api);

    await press(api, 'End');
    expect(web.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(web);
  });

  test('the first row is the Tab stop when no row is primary', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={{ ...draft, primaryKey: null }}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    expect(radios()[0].getAttribute('aria-checked')).toBe('false');
    expect(radios()[0].tabIndex).toBe(0);
    expect(radios()[1].tabIndex).toBe(-1);
  });

  test('arrow keys leave a submitting group alone', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
          createWorkspace={() => new Promise(() => undefined)}
        />
      </I18nProvider>,
    ));

    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const api = radioFor('/repos/api')!;
    expect(radios().every((radio) => radio.disabled)).toBe(true);
    await press(api, 'ArrowDown');
    expect(api.getAttribute('aria-checked')).toBe('true');
    expect(radioFor('/repos/web')!.getAttribute('aria-checked')).toBe('false');
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
          fetchConfigTarget={targetFor}
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

  test('a changed alias defined outside the project config also needs confirmation', async () => {
    const updates: Array<{ input: unknown }> = [];
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    useProjectsStore.setState({
      projects: [{ id: 'p_web', path: '/repos/web', label: 'Web app' }],
      activeProjectId: 'p_web',
    });

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          editing={{
            workspace: resolvedWorkspace,
            refs: [{
              alias: 'web',
              path: '/repos/web',
              description: 'web',
              status: 'outside',
              owned: true,
              current: { path: '/repos/web', description: 'Web app' },
            }],
            refsError: null,
          }}
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

    expect(document.body.textContent).toContain('@web was edited outside the app. Overwrite it?');
    const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
    expect(submit?.disabled).toBe(true);

    const confirmation = [...document.querySelectorAll('[role="checkbox"]')]
      .find((element) => element.getAttribute('aria-label')?.includes('Overwrite it?'));
    await act(async () => {
      setCheckbox(confirmation, true);
    });
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].input).toMatchObject({ confirmRefs: ['web'] });
  });

  test('an unchanged alias defined outside the project config needs no checkbox', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
          editing={{
            workspace: resolvedWorkspace,
            refs: [{
              alias: 'web',
              path: '/repos/web',
              description: 'web',
              status: 'overridden',
              owned: true,
              current: { path: '/repos/web', description: 'web' },
            }],
            refsError: null,
          }}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    const overwrite = [...document.querySelectorAll('[role="checkbox"]')]
      .find((element) => element.getAttribute('aria-label')?.includes('Overwrite it?'));
    expect(overwrite).toBeUndefined();
    expect(document.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled).toBe(false);
  });

  test('importing a .code-workspace fills the rows and skips only the unsupported folder', async () => {
    let importedPath: string | null = null;
    let created = 0;
    let cancelled = 0;

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={targetFor}
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
          fetchConfigTarget={targetFor}
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

  test('shows the target the server returns instead of composing one', async () => {
    const seen: string[] = [];
    const fetchTarget = async (folderPath: string): Promise<RepoWorkspaceConfigTarget> => {
      seen.push(folderPath);
      return { path: '/srv/api/.opencode/opencode.json', rootConfigPath: null };
    };

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={fetchTarget}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    expect(seen).toEqual(['/repos/api']);
    expect(document.body.textContent).toContain('/srv/api/.opencode/opencode.json');
    expect(document.body.textContent).not.toContain('/repos/api/.opencode/opencode.json');
  });

  test('reads the target again when the primary folder changes', async () => {
    const seen: string[] = [];
    const fetchTarget = async (folderPath: string): Promise<RepoWorkspaceConfigTarget> => {
      seen.push(folderPath);
      return { path: `${folderPath}/target/.opencode/opencode.json`, rootConfigPath: null };
    };

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={fetchTarget}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).toContain('/repos/api/target/.opencode/opencode.json');
    const webRadio = [...document.querySelectorAll('[role="radio"]')]
      .find((element) => element.getAttribute('aria-label') === 'Secondary repository: /repos/web');
    expect(webRadio !== undefined).toBe(true);
    await act(async () => {
      webRadio!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(seen).toEqual(['/repos/api', '/repos/web']);
    expect(document.body.textContent).toContain('/repos/web/target/.opencode/opencode.json');
  });

  test('warns that the new layer shadows an existing root config', async () => {
    const rootConfig = '/private/repos/api/opencode.json';
    const fetchTarget = async (): Promise<RepoWorkspaceConfigTarget> => ({
      path: '/private/repos/api/.opencode/opencode.json',
      rootConfigPath: rootConfig,
    });

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={fetchTarget}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).toContain('This layer shadows the existing root config file.');
    const pathLine = [...document.querySelectorAll('p')].find((element) => element.textContent === rootConfig);
    expect(pathLine !== undefined).toBe(true);
    expect(pathLine!.className).toContain('font-mono');
  });

  test('shows no guessed path while the target read is in flight', async () => {
    let resolveTarget: (target: RepoWorkspaceConfigTarget) => void = () => undefined;
    const fetchTarget = () => new Promise<RepoWorkspaceConfigTarget>((resolve) => {
      resolveTarget = resolve;
    });

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={fetchTarget}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).not.toContain('/repos/api/.opencode/opencode.json');

    await act(async () => {
      resolveTarget({ path: '/canonical/repos/api/.opencode/opencode.json', rootConfigPath: null });
    });

    expect(document.body.textContent).toContain('/canonical/repos/api/.opencode/opencode.json');
  });

  test('a transport failure reading the target leaves Create enabled', async () => {
    const fetchTarget = async (): Promise<RepoWorkspaceConfigTarget> => {
      throw new Error('offline');
    };

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={fetchTarget}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).not.toContain('Couldn\'t read this configuration file.');
    expect(document.body.textContent).not.toContain('/repos/api/.opencode/opencode.json');
    expect(document.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled).toBe(false);
  });

  test('shows the config error and blocks saving when the target cannot be read', async () => {
    const { RepoWorkspaceRequestError } = await import('@/lib/repoWorkspaces/client');
    const configPath = '/repos/api/.opencode/opencode.json';
    const fetchTarget = async (): Promise<RepoWorkspaceConfigTarget> => {
      throw new RepoWorkspaceRequestError(422, {
        error: 'OpenCode configuration cannot be read',
        configError: { path: configPath, message: 'invalid JSONC' },
      });
    };

    await act(async () => root.render(
      <I18nProvider>
        <Form
          fetchConfigTarget={fetchTarget}
          initialDraft={draft}
          titleId="workspace-title"
          onClose={() => undefined}
          onCreated={() => undefined}
          onRefsChanged={() => undefined}
        />
      </I18nProvider>,
    ));

    expect(document.body.textContent).toContain(configPath);
    expect(document.body.textContent).toContain('Couldn\'t read this configuration file. Fix it and try again.');
    expect(document.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled).toBe(true);
  });
});
