# Repo workspaces

## Ownership

`service.js` is the only server writer of the `workspaces` settings field and
of the neutral directories under `<OPENCHAMBER_DATA_DIR>/workspaces/`.
`routes.js` registers `GET /api/workspaces`, `POST /api/workspaces` and
`PATCH /api/workspaces/:id`. The retired active pointer, import, config-target,
reference-retry and delete routes are gone.

A workspace is `{ id, name, projectIds }` in settings. Its sessions run in
`<OPENCHAMBER_DATA_DIR>/workspaces/<id>/`, whose `.opencode/opencode.json`
holds absolute `references` and one `edit` allow rule per member project. The
id never changes, so existing sessions keep resolving to the workspace.

A folder that is not a project yet is registered through the shared add-project
rule in `../projects/add-project.js`; its project id comes from there. Projects
are shared between workspaces, never copied. Settings are persisted only through
the settings runtime (`persistSettings`), never by writing `settings.json`.

The neutral config is read with the injected `readConfigFile` and written only
through `writeConfig` from `../opencode/shared.js`, the atomic writer that
preserves comments and foreign keys. This module has no second writer, and it
never writes into a member repository.

## Invariants

- An unreadable settings document is an error, never an empty workspace list.
  The production reader is `readSettingsFromDiskMigratedStrict`.
- Create and edit validate the whole payload and every folder before resolving
  or registering anything. A rejected request creates no workspace, project or
  file.
- A missing or unreadable folder is 422 with the row's field key. A project id
  that is not in the catalog is 422 on create; on edit it is accepted only when
  the stored workspace already holds it, so an unrelated rename does not delete
  the missing row.
- Folders are deduplicated by resolved path, preserving the first occurrence
  and the user's order.
- Create and edit persist `projects` and `workspaces` in one `persistSettings`
  call. `activeProjectId` is never part of that update and never changes here.
  A failed settings write leaves neither a workspace nor a registered project.
- The settings read-to-persist section is one queue per service instance, so two
  concurrent saves cannot drop each other's workspace.
- `GET` resolves each `projectId` against the current catalog. A project that
  left the catalog keeps its row as `missing` with `project: null`; the rest of
  the workspace and the other projects survive.
- Every resolved workspace carries `directory` and `configError`. A missing or
  unparseable neutral config is a per-workspace error, never an empty project
  list and never a failed list request.
- After the settings write, the service writes the neutral config best effort.
  A failed write is returned as `configError` beside the saved workspace; the
  workspace stays and is listed with the same error on the next read.
- The config contains `references` named from the project label or folder
  basename, sanitized to an OpenCode key and deduplicated with `-2`, `-3`.
  Every reference path is absolute. `permissions` is exactly one
  `{ action: 'edit', resource: '<project>/*', effect: 'allow' }` per available
  member, so a broader user `deny` cannot make a member read-only.
- A missing project is omitted from `references` and `permissions`; the other
  members still get theirs.
- Legacy stored workspaces are read as `projectIds` from `repos[].projectId` in
  stored order. `primaryProjectId`, `createdRefs`, `editRules` and
  `activeWorkspaceId` are ignored and dropped on the next settings write. No
  member repository is read or rewritten to migrate one.
- Create and edit never remove references or permissions left by the old
  implementation in a member repository.
- Error bodies carry a field key (`folders[0].path`) and an English API message.
  They never carry settings content, file contents or secrets.

## Decisions

### Why the workspace owns a neutral directory

A workspace session must span several repositories without any project being
primary. A directory that OpenChamber owns gives OpenCode one `location.directory`
for the session, and its config holds the references and edit rules. Rejected
alternative: running in the first project's directory, which makes that project
special and writes workspace configuration into a repository.

### Why the neutral config is rewritten whole

The directory belongs to OpenChamber and this service is its only writer, so the
desired `references` and `permissions` are the complete truth. Rewriting removes
a reference whose project left instead of leaving a stale entry behind.
Rejected alternative: merging one alias at a time, which cannot express removal
and carries no owner record for the leftovers.

### Why registered projects ride in the workspace's settings write

The shared add-project rule supplies the id and validates the folder, but the
caller owns the write. Registering and storing the workspace in one
`persistSettings` call means a failed write cannot leave a project registered
for a workspace that never existed. Rejected alternative: calling
`POST /api/openchamber/directory` per folder, which writes several times and
moves `activeProjectId` and `lastDirectory`.

### Why a missing project survives an edit

The catalog is a separate read and a project can be removed while its grouping
still matters. Accepting only the ids the edited workspace already holds keeps
the row visible and lets the user remove it deliberately; any other unknown id
is rejected so a typo cannot create a permanent missing row.

### Why a failed config write is not a failed request

The workspace is already persisted and usable for reads and future edits.
Throwing away the response would tell the user nothing was saved. The error is
reported per workspace and surfaces again on `GET`. Rejected alternative:
writing the config before settings, which could leave a directory for a
workspace that was never saved.
