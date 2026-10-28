# Repo workspaces

## Ownership

`service.js` is the only server writer of the `workspaces` and
`activeWorkspaceId` settings fields, and the only reader that resolves them
against the project catalog. It also owns the primary's OpenCode `references`.
`routes.js` registers `GET /api/workspaces`, `POST /api/workspaces`,
`POST /api/workspaces/active` and `POST /api/workspaces/:id/refs/retry`.

A folder that is not a project yet is registered through the shared add-project
rule in `../projects/add-project.js`; its project id comes from there. Settings
are persisted only through the settings runtime (`persistSettings`), never by
writing `settings.json`.

OpenCode `references` are read through the injected `readConfigLayers`,
`readConfigFile`, `getLayerError` and `getProjectConfigPath`, and written only
through the injected `writeConfig` from `../opencode/shared.js` — the atomic
writer that preserves comments and foreign keys. This module has no second
writer. The write target is always `<primary>/.opencode/opencode.json`; a root
`opencode.json` is reported in `configTarget.rootConfigPath` so the dialog can
warn that the new layer overrides it, and is never edited.

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
- Create validates every secondary's config and folder before persisting
  settings. An unreadable config is 422 with `configError: { path, message }`;
  an alias already defined in any layer is 409 with `conflict: { alias, path }`
  unless `confirmRefs` lists it; a missing or unreadable folder is 422. None of
  these creates a workspace, a project or a file.
- `createdRefs` is exactly the set of aliases create writes. An entry that was
  already identical in a merged layer works but stays the user's (not owned, no
  write). `createdRefs` is persisted before the refs write, so a failed write is
  a pending reference, never a missing workspace.
- References are written one alias at a time, after the settings write. One
  failure is reported in `refWrites` for that alias and does not stop the
  others; the response still returns the workspace. Every alias write re-reads
  the target and refuses to overwrite a conflicting entry that appeared since
  preflight.
- `POST /api/workspaces/:id/refs/retry` targets only owned aliases. Without
  `aliases` it attempts only `missing` ones; an explicit `ok` alias is skipped,
  and `different`/`outside`/`overridden` need `confirmRefs` or answer 409. It
  never rewrites an `ok` reference.
- `removeCreatedRefs` (the helper ticket 07 calls) removes only `createdRefs`
  entries, only from the workspace's own target file, and only when the current
  value equals the one the workspace wrote. A user-edited owned entry needs
  `confirmRefs`; a reference outside `createdRefs` is never touched. All
  removals of one call land in one atomic write, so a failed write removes
  nothing.
- The config read-modify-write path is serialized per service instance: two
  concurrent saves re-read the previous write instead of losing it.
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

### Why the write target ignores `getProjectConfigPath`

OpenCode would let a root `opencode.json` be the project file when no
`.opencode/` config exists, but the workspace contract fixes one target:
`<primary>/.opencode/opencode.json`. Using the resolved project path could edit
the user's root file. `configTarget.rootConfigPath` names the root file that
the new layer starts to override, computed before the write, so the dialog can
warn without choosing the root file. Rejected alternative: writing the root
when it is the only project file, which is a silent edit of a file the contract
does not own.

### Why one config write per alias

Each alias is written in its own read-modify-write pass. That is what keeps a
permission or IO failure on one alias from blocking the others, and it lets the
response report one result per alias. The cost is one backup and one atomic
replace per secondary repo. Rejected alternative: one merged write, where a
single failed write fails every alias of the request; and a merged write with
per-alias retry fallback, which is more code and still loses the per-alias
provenance the pending card needs.

### Why an identical pre-existing reference is not owned

`createdRefs` decides what the workspace may later remove. If create adopted an
entry it did not write, deleting the workspace would delete a reference the user
had configured by hand. A matching entry is therefore left alone and reported
`ok` with `owned: false`, even though it was never rewritten.

### Why retry derives pending references from the config

There is no per-alias status stored in settings. A pending reference is an owned
alias whose value is `missing` from the current config, which covers both a
failed write and a later hand deletion. Recomputing it keeps retry idempotent
and avoids a second source of truth that could drift after an external edit.
Rejected alternative: storing write failures in settings, which would also need
cleanup when the user edits the file.

### Why every config mutation holds one queue

The read of the target, the merge of the new value and the write are one
critical section. Without the queue, two saves can both read the same document
and the later write silently drops the earlier reference. The queue is per
service instance, which is per server runtime; the settings runtime already
serializes settings writes, and this is the config-file equivalent. Rejected
alternative: relying on the atomic writer alone — it prevents a torn file, not
a lost update.

### Why removal is one write for all removed aliases

Ticket 07 aborts the whole edit when an owned removal fails, and its workspace
must stay exactly as it was. Removing aliases one at a time could apply the
first and fail the second, leaving a half-removed config with no workspace
change. One `writeConfig` call makes the removal set atomic; the cost is that a
failure reports every alias in the set as failed. Rejected alternative:
per-alias removal with a compensating rewrite, which can itself fail and is
more code than the contract needs.

## Installed OpenCode check: absolute reference paths

The `references[alias].path` value is written absolute and normalized. That was
verified against the installed CLI on 2026-10-28:

- Version: `opencode v2.1.4` (repo pin is 2.2.0).
- Fixture: two git repositories under
  `/private/var/folders/n4/bjx54c1d3_d7438735kj02sr0000gn/T/opencode/ws-ref-gate/`,
  `repo-a/.opencode/opencode.json` pointing `references.b.path` at the
  absolute path of `repo-b`.
- Command (run in `repo-a`):
  `opencode run --standalone --auto --format json --model opencode-go/deepseek-v4.1-flash "Crie o arquivo b-edit.txt dentro de @b/ com o texto ok. Depois leia o arquivo e confirme o caminho."`
- Result: accepted. The tool wrote and read
  `/private/var/folders/n4/bjx54c1d3_d7438735kj02sr0000gn/T/opencode/ws-ref-gate/repo-b/b-edit.txt`.
- Conclusion: an absolute `path` works; no relative fallback is needed.

The fixture lives outside the repository and is not committed.

