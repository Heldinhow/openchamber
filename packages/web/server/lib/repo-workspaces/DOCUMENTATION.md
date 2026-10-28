# Repo workspaces

## Ownership

`service.js` is the only server writer of the `workspaces` and
`activeWorkspaceId` settings fields, and the only reader that resolves them
against the project catalog. `routes.js` registers `GET /api/workspaces`,
`POST /api/workspaces` and `POST /api/workspaces/active`.

A folder that is not a project yet is registered through the shared add-project
rule in `../projects/add-project.js`; its project id comes from there. Settings
are persisted only through the settings runtime (`persistSettings`), never by
writing `settings.json`.

OpenCode `references` are not read or written yet; tickets 04 and 05 own them.

## Invariants

- An unreadable settings document is an error, never an empty workspace list.
  The production reader is `readSettingsFromDiskMigratedStrict`: the lenient
  reader maps a corrupt file to `{}` and the next write would overwrite it,
  while skipping migrations would leave legacy project ids to be rewritten
  after a workspace already references them.
- Create validates the whole payload before resolving or registering anything,
  then stores the workspace, its active pointer, the primary's
  `activeProjectId` and any newly registered projects in one `persistSettings`
  call. A failed write leaves neither a workspace nor a registered project.
- `POST /api/workspaces/active` with `{ id: null }` writes only
  `activeWorkspaceId`; projects, sessions and OpenCode config are untouched.
  An unknown workspace or a workspace whose primary project is missing is
  refused before any write.
- `GET` resolves every repo's project id against the current catalog and marks
  a missing project on the repo (`missing: true`, `project: null`). Malformed
  stored workspaces are dropped by the shared parser and counted in
  `discarded`; the read never rewrites settings.
- Error bodies carry a field key (`repos[0].alias`) and an English API message.
  They never carry settings content, file contents or secrets.

## Decisions

### Why a folder without a project is marked primary on its row

The primary is chosen before registration, when that row has no `projectId` yet.
A `primary: true` flag on the row mirrors the dialog's radio and works for both
registered and unregistered rows. Naming the primary by `projectId` cannot
address a folder that is not a project yet.

### Why registered projects ride in the workspace's settings write

The spec registers folders first and then saves the workspace. Both happen in
one `persistSettings` update here, so a failed settings write cannot leave a
project registered for a workspace that was never created. The add-project rule
is still the source of the id and of path validation. Rejected alternative:
calling `POST /api/openchamber/directory` internally, which costs an HTTP hop,
writes twice and changes `activeProjectId`/`lastDirectory` once per folder.

### Why `GET /api/workspaces` returns one top-level `refs`

`refs` describes the active workspace's primary config, which is what the
sidebar filter and the session header show. A per-workspace array would read
every workspace's primary config on a list request. The field is empty until
ticket 04 fills it; creation returns `refs` beside `workspace`, as the contract
specifies.
