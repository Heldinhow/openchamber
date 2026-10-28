# Repo workspaces (client read side)

## Ownership

`client.ts` is the UI's only reader of `/api/workspaces` and the only caller of
`POST /api/workspaces`, `POST /api/workspaces/active` and
`POST /api/workspaces/:id/refs/retry`. `useRepoWorkspaces` holds the resolved
list and the active pointer for the sidebar; the create dialog uses
`createRepoWorkspace` and `retryRepoWorkspaceRefs` and parses the response at
the boundary. Ticket 03 reads this state; editing and deleting workspaces stay
with the dialogs of tickets 07–08.

The server owns both writes and the project catalog. The client never writes a
workspace document and never stores one locally.

## Invariants

- A failed read is never an empty workspace list. The store keeps its last
  resolved data, reports `error`, and the sidebar shows Retry; the project list
  stays usable. A 404 means the route is absent in this runtime and the whole
  feature is hidden rather than shown as a failure.
- The resolved route payload is authoritative for repos, including a repo whose
  project is gone (`missing: true`). The merged settings document contributes
  only the active pointer; a reload then reads the resolved state again.
- Selection applies only the `activeWorkspaceId` the server echoes. Clicking the
  active workspace, or "All projects", sends `{ id: null }`.
- Requests are generation-guarded and keyed to the runtime that started them:
  a late response from another runtime or from before a selection can neither
  replace the list nor re-activate the old workspace.
- Create and retry answers are parsed at the boundary. A 4xx is a
  `RepoWorkspaceRequestError` carrying the field key, config path or conflict
  alias the dialog puts inline; a failed reference write is a successful create
  with `refWrites[].status === 'failed'`.

## Decisions

### Why the route, and not the settings document, lists the repos

The resolved list has to mark a `projectId` the catalog no longer holds. The
settings document only stores ids, so using it for the list would make the
sidebar render a missing project as a normal one. The merged document is still
read, because another window can move the active pointer and the server echoes
that save.

### Why the sidebar disables rather than adapts on mobile and VS Code

Those runtimes do not register the route in this version. Asking anyway would
show a load failure on every sidebar mount; the feature is hidden and the
sidebar behaves exactly as before.
