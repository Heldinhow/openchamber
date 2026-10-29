# Repo workspaces (client read side)

## Ownership

`client.ts` is the UI's only reader of `/api/workspaces` and the only caller of
`POST /api/workspaces` and `PATCH /api/workspaces/:id`. It parses every response
at the boundary: the resolved list, the saved workspace, the per-workspace
config error, and the 4xx fields a dialog shows inline.

`useRepoWorkspaces` holds the resolved list for the sidebar: each workspace's
id, name, neutral `directory`, resolved projects (including a missing one) and
`configError`. It reloads when the merged settings document reports a different
`workspaces` list, so a create or edit in another window lands here.

`catalog.ts` publishes that resolved list to the composer and to the draft
store. It is the one place a workspace draft resolves its name and neutral
directory from, and `draftTargetGroups.ts` builds the picker's two groups:
workspace names and project names both match, and a matched project also
surfaces every workspace that contains it. A workspace draft keeps its
`workspaceId` and neutral directory, so it still names and routes the workspace
before the list loads. `workspaceDraft.ts` asks the route directly when the
catalog copy is missing or stale; a workspace the route no longer holds throws
instead of yielding a directory.

The server owns both writes and the project catalog. The client never writes a
workspace document, never composes the neutral directory, and never stores one
locally.

## Invariants

- A failed read is never an empty workspace list. The hook keeps its last
  resolved list, reports `error`, and the sidebar offers Retry. A 404 means the
  route is absent in this runtime (mobile, VS Code) and the whole feature is
  hidden instead of shown as a failure.
- The resolved route payload is authoritative for projects, including a project
  whose catalog entry is gone (`missing: true`, `project: null`).
- Requests are generation-guarded and keyed to the runtime that started them: a
  late response from another runtime or from before a reload cannot replace the
  list.
- A settings-synced payload only triggers a read when the stored `workspaces`
  list differs from the one this hook last saw; the hook never applies the
  settings list directly, because only the route resolves missing projects and
  config errors.
- A saved workspace's `configError` is a successful save with a failed neutral
  config write. The dialog reports it and closes; the list shows the same error
  on the next read.
- Create and edit inputs carry a name and folder rows (`path` or `projectId`).
  The client does not send aliases, a primary, branches or permissions.
- The catalog is a runtime-scoped copy of the route's last resolved list. It is
  never written to storage, and a runtime switch makes the old copy ineligible
  until the destination answers.
- A workspace draft is a target of its own (`target: "workspace"` plus
  `workspaceId`), never a project whose path happens to be the neutral
  directory. Its directory comes from the catalog; the persisted id, name and
  directory only keep the draft nameable before the list loads.
- A workspace the catalog authoritatively no longer holds, and a neutral
  directory the filesystem reports missing, fail the first send as a workspace
  failure. They never fall back to a member project, the active project or the
  previous project.

## Decisions

### Why the route, and not the settings document, lists the projects

The settings entry stores only ids. A project that left the catalog has to be
marked `missing`, and the neutral `directory` and `configError` come from the
file the service owns. Reading the settings list here would render a missing
project as a normal one. The merged document is still read, because another
window can change the list and the server echoes that save.

### Why the composer reads a published catalog instead of its own request

The sidebar already owns the only `/api/workspaces` read. A second request per
composer would duplicate the listener and could show two different lists while
one reloads. The catalog is the same resolved payload, keyed to the runtime that
answered, so the composer's picker and the draft store agree with the sidebar
and neither treats a failed read as an empty list.

### Why mobile and VS Code disable instead of adapting

Those runtimes do not register `/api/workspaces`. Asking anyway would show a
load failure on every sidebar mount, so the feature is hidden and the sidebar
behaves as before.
