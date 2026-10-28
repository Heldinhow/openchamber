/**
 * `/api/workspaces` routes. The service owns the behavior; this file maps the
 * service's request errors to statuses and keeps internal failures opaque, so
 * a settings parse error never reaches the client as file content.
 */
import { createWorkspaceService, WorkspaceRequestError } from './service.js';

const respondWithError = (res, error, fallbackMessage) => {
  if (error instanceof WorkspaceRequestError) {
    const body = { error: error.message };
    if (error.fields) body.fields = error.fields;
    if (error.configError) body.configError = error.configError;
    if (error.conflict) body.conflict = error.conflict;
    if (error.importError) body.importError = error.importError;
    return res.status(error.status).json(body);
  }
  return res.status(500).json({ error: fallbackMessage });
};

export const registerWorkspaceRoutes = (app, dependencies) => {
  const service = createWorkspaceService(dependencies);

  app.get('/api/workspaces', async (_req, res) => {
    try {
      return res.json(await service.list());
    } catch (error) {
      return respondWithError(res, error, 'Failed to read workspaces');
    }
  });

  // The dialog reads the target before saving; the folder may not be a project.
  app.get('/api/workspaces/config-target', async (req, res) => {
    try {
      return res.json(await service.configTarget({ path: req.query.path }));
    } catch (error) {
      return respondWithError(res, error, 'Failed to read the config target');
    }
  });

  // Before the `/:id` routes, so `import` is never read as a workspace id.
  app.post('/api/workspaces/import', async (req, res) => {
    try {
      return res.json(await service.importDraft(req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to import workspace file');
    }
  });

  app.post('/api/workspaces', async (req, res) => {
    try {
      return res.status(201).json(await service.create(req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to create workspace');
    }
  });

  app.patch('/api/workspaces/:id', async (req, res) => {
    try {
      return res.json(await service.update(req.params.id, req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to update workspace');
    }
  });

  app.delete('/api/workspaces/:id', async (req, res) => {
    try {
      return res.json(await service.remove(req.params.id, req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to delete workspace');
    }
  });

  app.post('/api/workspaces/active', async (req, res) => {
    try {
      return res.json(await service.activate(req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to activate workspace');
    }
  });

  app.post('/api/workspaces/:id/refs/retry', async (req, res) => {
    try {
      return res.json(await service.retryRefs(req.params.id, req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to retry workspace references');
    }
  });
};
