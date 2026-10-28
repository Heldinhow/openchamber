# Repo workspaces

## Ownership

`service.js` is the only server writer of the `workspaces` and
`activeWorkspaceId` settings fields, and the only reader that resolves them
against the project catalog. It also owns the primary's OpenCode `references`.
`routes.js` registers `GET /api/workspaces`, `GET /api/workspaces/config-target`,
`POST /api/workspaces`, `POST /api/workspaces/import`, `PATCH /api/workspaces/:id`,
`DELETE /api/workspaces/:id`, `POST /api/workspaces/active` and
`POST /api/workspaces/:id/refs/retry`.

A folder that is not a project yet is registered through the shared add-project
rule in `../projects/add-project.js`; its project id comes from there. Settings
are persisted only through the settings runtime (`persistSettings`), never by
writing `settings.json`.

OpenCode `references` are read through the injected `readConfigLayers`,
`readConfigFile`, `getLayerError` and `getProjectConfigPath`, and written only
through the injected `writeConfig` from `../opencode/shared.js` — the atomic
writer that preserves comments and foreign keys. This module has no second
writer. The write target is always `<primary>/.opencode/opencode.json`; a root
config (`opencode.jsonc` when both root files exist) is reported in
`configTarget.rootConfigPath` so the dialog can warn that the new layer
overrides it, and is never edited. Because `readConfigLayers` parses only the
highest-priority project file, the service reads `.opencode/opencode.jsonc` and
the root `opencode.json`/`opencode.jsonc` itself as lower layers for
classification on read; the shared reader's merge order stays unchanged.
Removal never reads those lower files: `removeCreatedRefs` only reads and writes
the target layer.

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
- Every workspace returned by `GET` carries `refs` and `refsError` for its own
  primary, so the edit dialog can show a workspace that is not active. The
  top-level `refs`/`refsError` still describe the active workspace.
- Every read returns `refs` for the expected references of one workspace (the
  active workspace on `GET`, the new one on create): one entry per secondary
  repo with `alias`, expected `path` and `description`, `status`, `owned` and
  the `current` config value when one exists. A workspace with no secondary
  repo returns an empty array.
- `status` is `ok`, `missing`, `different`, `outside`, `overridden` or
  `unknown`. A project whose id is gone makes its refs `missing` (and the
  primary's absence makes all of them `missing`) without failing the workspace.
  `outside` covers an alias defined below the project layer too: the lower
  project files are `.opencode/opencode.jsonc`, `opencode.json` and
  `opencode.jsonc` under the primary. `overridden` means the project layer holds
  the entry and any other layer (including those lower files) also defines the
  alias. An alias one of those files defines is never `missing`. A config layer
  that cannot be parsed, or whose `references` value is not an object, makes
  every ref `unknown`, never `missing`, and reports `{ path, message }` once in
  `refsError`; a malformed lower file counts the same way.
- A read of the reference state can fail after the workspace is already saved:
  create, edit, retry and delete's refusal paths answer the saved state with
  every expected ref `unknown` and `refsError: { path, message }` naming the
  primary's `.opencode/opencode.json`. `GET` does the same per workspace, so one
  unreadable config neither fails the request nor hides the other workspaces.
- An expected alias is `owned` only when `createdRefs` lists it; ownership never
  changes the classification.
- Every repo carries `readOnly` (default `false`); the primary is always
  editable when rules are built, whatever the payload says. Each workspace also
  stores `editRules`: the exact `{ alias, resource, effect }` entries it wrote
  into the primary's `permissions`. Rules for an alias that left `repos` stay
  stored so they can still be removed; they are never filtered on read.
- Permissions are written to the same `<primary>/.opencode/opencode.json`
  through `writeConfig`. A secondary repo gets `allow` (editable) or `deny`
  (`readOnly`) for `<configured>/*` and, when `realpath` differs, for
  `<canonical>/*`. Desired rules are appended after everything already in
  `permissions`, because the last matching rule wins. Only entries exactly
  equal to the workspace's previous `editRules` are removed; every other key
  and rule is preserved. A `permissions` value that is not an array of objects
  fails without a write.
- Create and edit persist the desired `editRules` before the config write and
  reconcile after the references are written, under the refs lock. A failed
  permission write is `permissionWrites: { status: 'failed', path, message }`
  and never fails the saved workspace. Deletion removes the app-owned rules
  after the settings write, best effort, and reports `permissionRemoved`
  (plus `configError` on failure) without keeping the workspace.
- `GET /api/workspaces/config-target?path=<folder>` reads only the target for a
  folder that may not be a project yet: the folder must be absolute and exist,
  an unreadable config is 422 `configError`, and the answer is
  `{ path, rootConfigPath }` where `path` is always
  `<folder>/.opencode/opencode.json`. `rootConfigPath` names the root file the
  new layer would shadow, checked by existence even when
  `.opencode/opencode.json` already exists. `.jsonc` wins over `.json` when both
  are present, matching OpenCode's load order. Only a missing file (`ENOENT`)
  leaves it null; any other stat error still names the candidate, because it may
  exist and be shadowed.
- Create validates every secondary's config and folder before persisting
  settings. An unreadable config is 422 with `configError: { path, message }`;
  an alias already defined in any layer — including a lower project file — is
  409 with `conflict: { alias, path }` unless `confirmRefs` lists it; a missing
  or unreadable folder is 422. None of these creates a workspace, a project or a
  file.
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
  `confirmRefs`; a reference outside `createdRefs` is never touched, and an
  entry a lower project file defines is never removed or renamed. Removal reads
  only `readConfigLayers` and the target file, never the lower project files, so
  a malformed root config cannot block it; a malformed target still does. All
  removals of one call land in one atomic write, so a failed write removes
  nothing. The whole request is preflighted first: an owned alias whose project
  or path is gone cannot be verified, so it blocks every removal (`removed: []`,
  `blockedAlias`) instead of deleting the other aliases while one stays behind.
- `PATCH /api/workspaces/:id` edits in this order: validate the payload and
  every new reference against the new primary's config, register new folders,
  remove the owned references that leave, persist the workspace, then write the
  new references best effort. A failed owned removal is 409 with the alias and
  leaves both the workspace and the file untouched; that includes an owned
  alias the workspace can no longer locate, which is named before anything is
  persisted. A failed new write is a saved workspace plus
  `refWrites[].status === 'failed'` for that alias.
- On edit, a next reference that still matches the stored workspace's entry for
  the same alias (same resolved path and description) needs neither a write nor
  a confirmation when it lives only in another layer (`outside`) or when another
  layer also defines it (`overridden`); the config is left untouched. A changed
  alias, path or description still needs `confirmRefs` for those states. A
  `missing` owned reference is still written, so a save retries a pending one,
  and a `different` entry keeps its existing ownership rule.
- On edit, a reference leaves when its alias is no longer a secondary alias:
  the repo was removed, the alias was renamed, or the repo became primary.
  `keepRefs` names the owned aliases whose repo leaves but whose entry must
  stay in the config; those aliases also leave `createdRefs`, so the workspace
  no longer owns them.
- A changed primary moves every owned reference: all owned aliases except
  `keepRefs` are removed from the old primary's config, including those whose
  repo stays a secondary, because only the new primary's file is read for this
  workspace afterwards. The removal uses the atomic removal step, so a failure
  answers 409 and leaves the workspace and both files untouched. The new
  references are then written into the new primary.
- Edited `createdRefs` keeps an old owned alias only while it is still a
  secondary alias, and adds every alias the edit actually writes. An entry that
  was already identical stays the user's.
- A repo whose project left the catalog can be sent back on edit with its
  project id; it stays in the workspace and keeps reading as `missing`. A
  missing secondary is skipped by the write step, and an edit whose old primary
  is missing cannot remove references (there is no config to edit).
- When the settings write fails after an owned removal, the removed entries are
  put back before the error is returned, so the unchanged workspace does not
  lose references it still expects. If the restore also fails, the request
  answers 500 with `configError: { path, message }` naming the config file and
  saying the entries could not be restored; the failure is never swallowed.
- `DELETE /api/workspaces/:id` deletes in the contract order: remove the owned
  references first, then drop the workspace. Without `removeCreatedRefs` the
  primary's config and the projects are untouched; the pointer is cleared only
  when the deleted workspace was the active one. A failed owned removal answers
  `removed: false` with the current `refs`, the failing `failedAlias` and, for an
  unreadable config, `configError`; settings are not written, so the workspace
  stays. An owned alias whose entry cannot be verified blocks the whole removal
  the same way, with `failedAlias` and the config untouched, because deleting
  the workspace would orphan it. A settings
  write that fails after a successful removal restores the removed entries.
  `confirmRefs` lets the caller approve removing an owned entry the user
  edited; without it the answer stays `removed: false` with the failing alias.
- The config read-modify-write path is serialized per service instance: two
  concurrent saves re-read the previous write instead of losing it.
- Settings changes are serialized per service instance too: create, update,
  remove and activate read the document and persist from that same snapshot
  inside one queue, so two concurrent requests cannot drop each other's
  workspace. The settings queue is taken before the config queue, never after.
- `POST /api/workspaces/import` only reads. It returns `{ name, folders }` and
  never calls `persistSettings`, registers a project or writes config, so a
  cancel after importing leaves no trace.
- Import resolves a relative folder against the workspace file's directory,
  expands `~`, and deduplicates by `realpath` (falling back to the normalized
  path when the folder is missing or cannot be resolved). The first accepted
  folder is proposed as primary.
- Aliases are the sanitized folder basename under the dialog's rule, suffixed
  `-2`, `-3` when repeated. A non-`file:` URI (`vscode-remote:`, `ssh:`) stays
  in the draft as `{ path, alias: '', error: 'unsupported' }` so one bad folder
  does not drop the others; `file:` URIs are converted to paths.
- An unreadable file answers 422 with `importError.reason = 'unreadable'`; a
  file that is not JSONC with a `folders` array answers 422 with
  `importError.reason = 'invalid-json'`. Neither body nor message carries file
  content.
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

### Why `GET /api/workspaces` returns per-workspace refs and one top-level set

The top-level `refs`/`refsError` describe the active workspace's primary
config, which is what the sidebar filter and the session header show, so they
stay. The edit dialog opens a workspace that may not be active and needs that
workspace's own state in the same response; a separate request or route would
cost a second settings read and another loading state. The price is one config
read per stored workspace on the list request. Rejected alternative: returning
only the active workspace's refs and reading the edited one on demand. Creation
still returns `refs` beside `workspace`, as the contract specifies.

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
`outside`, and the next write could then overwrite it. A file-wide parse failure,
or a `references` value that is not an object, cannot be attributed to one alias,
so the read reports `unknown` for all of them and the same `{ path, message }`
once in `refsError`. A malformed individual entry is different: it is `different`
(with `current: null`) and its siblings keep their states.

### Why a failed post-save refs read reports `unknown` instead of failing

The workspace — and on create the reference writes — are already persisted when
the response is built. An unexpected IO error there cannot undo them, and
turning it into an error would tell the user nothing was saved. The read reports
every expected ref `unknown` with the primary's target path in `refsError`, the
same shape a bad layer produces, and `GET` applies it per workspace so the rest
of the list survives. Rejected alternatives: letting the error escape, which
answered 500 after a successful save and failed the whole `GET`; and reporting
`missing`, which the next retry would treat as a pending reference and rewrite
over an entry it did not read.

### Why `current` comes from the project layer, except for `outside`

Ownership and ticket 05's overwrite check read the project layer, so `ok`,
`different` and `overridden` report that entry. `outside` has no project entry;
its value is the one actually in effect: the custom config first, then the lower
project files from highest to lowest, then the merged global layers. Rejected
alternative: always reporting the merged value, which would hide the project
entry that a removal is allowed to touch; and reporting the root entry even
when a `.opencode/opencode.jsonc` or custom config overrides it.

### Why the write target ignores `getProjectConfigPath`

OpenCode would let a root `opencode.json` be the project file when no
`.opencode/` config exists, but the workspace contract fixes one target:
`<primary>/.opencode/opencode.json`. Using the resolved project path could edit
the user's root file. `configTarget.rootConfigPath` names the root file that
the new layer starts to override, tested by existence rather than by
`getProjectConfigPath`, because that helper stops reporting the root as soon as
the target exists. The dialog can then warn on every save, not only the first.
The check reads `opencode.jsonc` before `opencode.json`, because OpenCode loads
the `.jsonc` later and it wins when both exist; only `ENOENT` suppresses the
warning, since any other stat error still means a file may be there and
shadowed. Rejected alternative: writing the root when it is the only project
file, which is a silent edit of a file the contract does not own.

### Why removal does not read the lower project files

The lower project files exist to classify aliases on read: without them an
alias only the root defines would read as `missing`. Removal does no such
classification. It only proves a `createdRefs` entry is still the value this
workspace wrote in its target and then deletes it there, so reading a lower
file could only turn an unrelated broken file into a refusal to delete. The
read path keeps reporting that file as `unknown` with `refsError`; the delete
path now deletes. Rejected alternative: keeping the shared read helper, which
made deleting a workspace with references depend on a file the deletion never
touches.

### Why the service reads the lower project files itself

`readConfigLayers` parses only the highest-priority project file, which is the
write target once it exists. The root file (and `.opencode/opencode.jsonc`) then
disappear from every classification, so an alias only the root defines read as
`missing`, and a write buried it without a conflict. The service therefore
reads those files with the injected `readConfigFile` and treats their
`references` as other layers. Changing the shared merge order instead would
change how every config surface resolves a project, far beyond this module.
Rejected alternative: calling `getProjectConfigPath` twice or changing the
shared reader to merge all project files; the first cannot see a root file below
an existing target, and the second changes unrelated configuration behavior.

### Why one config write per alias

Each alias is written in its own read-modify-write pass. That is what keeps a
permission or IO failure on one alias from blocking the others, and it lets the
response report one result per alias. The cost is one backup and one atomic
replace per secondary repo. Rejected alternative: one merged write, where a
single failed write fails every alias of the request; and a merged write with
per-alias retry fallback, which is more code and still loses the per-alias
provenance the pending card needs.

### Why permission rules are appended and removed by exact match

OpenCode applies the last matching rule, so the workspace's rules go at the end
of `permissions`; anything before them stays untouched and user rules keep
winning nothing. Ownership is `editRules`, which records exactly the triples
this workspace wrote, so an edit or a deletion removes only those and leaves
every other rule and key alone. Removal includes rules whose alias is gone from
`repos`, which is why the parser does not filter `editRules` by the current
aliases: filtering on read would strand those entries in the config. Both the
configured path and its canonical `realpath` are written when they differ,
because they are distinct resources to the permission check. Rejected
alternative: rewriting the whole `permissions` array from the workspace state,
which would discard rules the user added by hand.

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

### Why settings changes hold a second queue

The refs queue protects one config file, but the workspace fields live in the
settings document. Create, update, remove and activate read that document and
then persist a snapshot built from the read; two concurrent requests can read
the same list and the second write drops the first workspace. The settings
queue wraps the read-to-persist section of each. A removal inside it still takes
the refs queue, and `removeCreatedRefs` reads settings without the settings
queue, so the order is always settings then refs and the queues cannot deadlock.
Rejected alternative: serializing only the settings write, which cannot merge a
snapshot the caller already built.

### Why a failed deletion answers 200 with `removed: false`

Deletion is a request whose refusal is a normal outcome: the workspace is still
there untouched and the caller needs the alias to explain why. That does not fit
the 409 shape of an edit, where a conflict aborts a multi-step save, and it would
make the dialog handle two failure envelopes. `removed` is the single source of
truth for the UI; `failedAlias` and `configError` only say why nothing happened.
An unknown workspace is still 404, and an unreadable settings document still
throws, because in both cases there is no trustworthy workspace state to report.

### Why an unverifiable owned alias blocks the removal

`createdRefs` is the only ownership record. If an owned alias has no resolvable
project path, the workspace cannot prove which config entry it wrote, so it
cannot remove it safely. Deleting the workspace anyway would leave that entry in
the file with no owner and no way to remove it later; saving an edit would leave
it in the old primary's file the same way. The preflight covers the whole
request, so the other aliases are not removed either. The answer keeps the
workspace and names the alias: deletion says `removed: false` with
`failedAlias`, an edit answers 409 with `conflict.alias`. The user can delete
without removing references, or fix the project first.

### Why removal is one write for all removed aliases

Ticket 07 aborts the whole edit when an owned removal fails, and its workspace
must stay exactly as it was. Removing aliases one at a time could apply the
first and fail the second, leaving a half-removed config with no workspace
change. One `writeConfig` call makes the removal set atomic; the cost is that a
failure reports every alias in the set as failed. Rejected alternative:
per-alias removal with a compensating rewrite, which can itself fail and is
more code than the contract needs.

### Why an edit removes references before saving the workspace

The contract fixes this order, and it is what makes a removal failure abort the
whole edit: nothing is persisted until the config is already clean. The risk is
the opposite failure, a settings write that fails after a successful removal, so
the removed entries are restored on that path. Rejected alternative: saving the
workspace first and removing afterwards, which leaves the workspace pointing at
aliases it no longer owns when a removal fails.

### Why `keepRefs` rather than a boolean on each repo

The removal question belongs to an alias, not to a row: the user may rename an
alias or change which repo is primary, and only the aliases that leave the
workspace are candidates. A list of aliases also keeps the payload independent
of row order, and an alias that stays simply ignores its entry. The kept alias
leaves `createdRefs`, because a reference the user chose to keep is no longer
this workspace's to delete.

### Why a primary change removes owned entries that stay secondaries

Ownership is recorded by alias against the config file the workspace wrote,
which is always the primary's file. After a swap the old primary is just a
project: its file is no longer read for this workspace, and an entry left there
can never be matched to `createdRefs` again. The edit therefore removes every
owned alias from the old file except `keepRefs`, and the write step recreates
the staying secondaries in the new primary. Rejected alternative: removing only
the aliases that leave the workspace, which leaves orphan copies behind.

### Why an unchanged reference in another layer is not rewritten

`outside` and `overridden` mean the project layer does not hold the entry this
workspace expects; a write would either duplicate another layer's alias or
replace a value the workspace does not own. When the edit keeps the same alias,
path and description, the reference itself did not change, so a rewrite would
only risk touching another layer. Only a changed reference asks for
`confirmRefs`, which is also the case the dialog can explain. Rejected
alternative: requiring confirmation for every `outside`/`overridden`
reference, which refused an unrelated rename with no action the dialog offered.

### Why import is its own read-only route

A `.code-workspace` import fills a dialog that has not asked to create anything
yet, so it cannot share the create route without either writing early or
carrying a dry-run flag through every step of create. A separate method keeps
the never-write rule structural, and the draft it returns is already the shape
the form edits: resolved folder paths, aliases and a proposed primary. Rejected
alternative: parsing the file in the browser, which cannot resolve a relative
path because the browser receives neither the file's directory nor the server's
filesystem.

### Why a bad folder does not fail the import

A workspace file can mix local folders with remote URIs the app cannot open.
Dropping the whole file would lose the local folders the user does want, so the
draft carries each rejected entry with `error: 'unsupported'` and the dialog
lists it. The name and accepted folders still land, and submit sends only what
the user can save.

## Installed OpenCode check: absolute reference paths

The `references[alias].path` value is written absolute and normalized. That was
verified against the installed CLI on 2026-10-28:

- Version: `opencode v2.2.0`, the version the repo pins (the machine's CLI is
  `v2.1.4`). The check was repeated on 2026-10-28 with the pinned binary.
- Fixture: two git repositories under `/tmp/oc-ws-e2e/p5-abs/`,
  `primary/.opencode/opencode.json` pointing `references.web.path` at the
  absolute path of `secondary`, with an isolated `HOME`.
- Commands (run in `primary`): `opencode serve --port 3911`, then
  `GET /api/reference` with the server's basic auth.
- Result: accepted. The route returned
  `{"name":"web","path":"/tmp/oc-ws-e2e/p5-abs/secondary","source":{"type":"local","path":"/tmp/oc-ws-e2e/p5-abs/secondary"}}`.
- Control: the same entry with `"path": "../secondary"` was also accepted but
  resolved to `<primary>/secondary`, because OpenCode resolves a relative path
  against the config file's directory (`.opencode/`), not the project root.
  That base is exactly what the app does not want to depend on when the file
  moves between the root and `.opencode/`, so absolute remains the contract.
- Conclusion: an absolute `path` works on 2.2.0; no relative fallback is needed.

The absolute-path fixture lives outside the repository and is not committed.
The earlier v2.1.4 check (a real model writing through `@b/` under
`/private/var/folders/.../ws-ref-gate/`) reached the same conclusion; it is
history only, since the repo pins 2.2.0.
