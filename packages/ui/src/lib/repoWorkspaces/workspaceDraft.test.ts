import { describe, expect, test } from 'bun:test';

import type { RepoWorkspaceResolved } from './client';
import { resolveWorkspaceDraftDirectory, WorkspaceDraftTargetError } from './workspaceDraft';

const workspace = (id: string, directory: string): RepoWorkspaceResolved => ({
  id,
  name: id,
  directory,
  projects: [],
  configError: null,
});

const lookup = (workspaces: RepoWorkspaceResolved[]) => ({
  readWorkspaces: async () => ({ workspaces, discarded: 0 }),
});

describe('a workspace draft directory', () => {
  test('is the neutral directory the route resolves for the workspace id', async () => {
    const directory = await resolveWorkspaceDraftDirectory(
      'ws_product',
      lookup([workspace('ws_product', '/data/workspaces/ws_product')]),
    );

    expect(directory).toBe('/data/workspaces/ws_product');
  });

  test('fails when the workspace the draft names is gone', async () => {
    const request = resolveWorkspaceDraftDirectory('ws_gone', lookup([workspace('ws_other', '/data/workspaces/ws_other')]));

    await expect(request).rejects.toBeInstanceOf(WorkspaceDraftTargetError);
  });

  test('fails when the draft names no workspace', async () => {
    await expect(resolveWorkspaceDraftDirectory(null, lookup([]))).rejects.toBeInstanceOf(WorkspaceDraftTargetError);
  });

  test('propagates a failed route read instead of reporting a missing workspace', async () => {
    const request = resolveWorkspaceDraftDirectory('ws_product', {
      readWorkspaces: async () => { throw new Error('offline'); },
    });

    await expect(request).rejects.toThrow('offline');
  });
});
