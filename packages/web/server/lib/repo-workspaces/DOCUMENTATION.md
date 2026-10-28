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

OpenCode `references` are read here, through the injected `readConfigLayers`,
`getLayerError` and `getProjectConfigPath` from `../opencode/shared.js`; this
module never writes them. Ticket 05 owns the write side.

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
- Every read returns `refs` for the expected references of one workspace (the
  active workspace on `GET`, the new one on create): one entry per secondary
  repo with `alias`, expected `path` and `description`, `status`, `owned` and
  the `current` config value when one exists. A workspace with no secondary
  repo returns an empty array.
- `status` is `ok`, `missing`, `different`, `outside`, `overridden` or
  `unknown`. A project whose id is gone makes its refs `missing` (and the
  primary's absence makes all of them `missing`) without failing the workspace.
  A config layer that cannot be parsed makes every ref `unknown`, never
  `missing`, and reports `{ path, message }` once in `refsError`.
- An expected alias is `owned` only when `createdRefs` lists it; ownership never
  changes the classification.
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
every workspace's primary config on a list request. Creation returns `refs`
beside `workspace`, as the contract specifies.

### Why the expected reference path is already absolute and normalized

Ticket 05 writes `path.resolve(project.path)`, so the read reports exactly that
value and the UI and the writer cannot disagree about the target. Comparison
resolves an absolute `current.path` the same way, so a trailing separator does
not read as `different`; a relative or `~` path does, because OpenCode would
resolve it differently from the absolute value the workspace writes. Rejected
alternative: comparing raw strings, which would report a hand-edited trailing
slash as a conflict.

### Why one bad config layer makes every ref `unknown`

`readConfigLayers` omits a layer it cannot parse from the merge, so classifying
against the remaining layers would read a user reference as `missing` or
`outside`, and the next write could then overwrite it. A file-wide parse failure
cannot be attributed to one alias, so the read reports `unknown` for all of them
and the same `{ path, message }` once in `refsError`. A malformed individual
entry is different: it is `different` (with `current: null`) and its siblings
keep their states.

### Why `current` comes from the project layer, except for `outside`

Ownership and ticket 05's overwrite check read the project layer, so `ok`,
`different` and `overridden` report that entry. `outside` has no project entry;
its value is the merged one actually in effect. Rejected alternative: always
reporting the merged value, which would hide the project entry that a removal
is allowed to touch.

