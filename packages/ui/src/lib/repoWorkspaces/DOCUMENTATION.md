# Repo workspaces (client read side)

## Ownership

`client.ts` is the UI's only reader of `/api/workspaces` and the only caller of
`GET /api/workspaces/config-target`, `POST /api/workspaces`,
`POST /api/workspaces/import`, `PATCH /api/workspaces/:id`,
`DELETE /api/workspaces/:id`, `POST /api/workspaces/active` and
`POST /api/workspaces/:id/refs/retry`.
`useRepoWorkspaces` holds the resolved list, the active pointer, the count of
discarded workspaces and the reference states for the sidebar, the session
header and every workspace's edit dialog; the workspace dialogs use
`fetchRepoWorkspaceConfigTarget`, `createRepoWorkspace`, `updateRepoWorkspace`,
`deleteRepoWorkspace` and `retryRepoWorkspaceRefs` and parse every response at
the boundary.

`workspaceReview.ts` is the workspace review panel's only projection. It reads
the resolved workspace, its reference states and a per-repo git readout, and
returns the cards, the header total and the partial flag. It does not fetch and
does not write.

The server owns both writes and the project catalog. The client never writes a
workspace document and never stores one locally.

## Invariants

- A failed read is never an empty workspace list. The store keeps its last
  resolved data and active pointer, reports `error`, and the sidebar shows Retry
  beside the last header; the project list stays usable and the filter still
  resolves its workspace. A 404 means the route is absent in this runtime and
  the whole feature is hidden rather than shown as a failure.
- The resolved route payload is authoritative for repos, including a repo whose
  project is gone (`missing: true`). The merged settings document only tells
  this window that the pointer moved; the reload then reads the resolved
  pointer and state.
- Selection applies only the active pointer the route reports. The activation
  answer alone does not move it: the hook reads again and applies the new
  pointer together with its top-level reference pair, and the activation answer
  is only the fallback of a failed read. Clicking the active workspace, or "All
  projects", sends `{ id: null }`. Every other mounted copy of the hook hears
  the switch through `openchamber:workspace-active-updated`, compares the
  announced pointer with the one it applied, and reads again instead of
  applying it; the copy that switched already holds the answer and does not
  read.
- Requests are generation-guarded and keyed to the runtime that started them:
  a late response from another runtime or from before a selection can neither
  replace the list nor re-activate the old workspace. A settings-synced pointer
  from another window only triggers that read, and is ignored while this hook's
  own activation is in flight. A settings payload whose workspace list differs
  from the one this hook holds queues one silent read after the activation
  settles, so another window's create, rename or delete is not lost; the pointer
  in that payload is still never applied directly.
- Create, update and retry answers are parsed at the boundary. A 4xx is a
  `RepoWorkspaceRequestError` carrying the field key, config path or conflict
  alias the dialog puts inline; a failed reference write is a successful create
  or edit with `refWrites[].status === 'failed'`.
- A delete answer is parsed at the boundary too. `removed: false` is a normal
  answer, not a transport error: the workspace still exists and `failedAlias`
  or `configError` explains why. Only a non-2xx answer becomes an error.
  `confirmRefs` is sent beside `removeCreatedRefs` so the dialog can overwrite an
  owned entry the user edited by hand, and is omitted when empty.
- The import answer is parsed at the boundary like every other response. Its
  folders are a draft only: the server reads the file and returns nothing
  persisted, and an import error carries a reason (`unreadable` or
  `invalid-json`) instead of file content.
- The config-target answer is parsed at the boundary too. It names the exact
  file the form will write and the existing root config it shadows; a 4xx is a
  `RepoWorkspaceRequestError` whose `configError` the form shows in its existing
  config-error block. The client never composes that path.
- The document's `discarded` count is read-only: it names stored workspaces the
  parser dropped so the sidebar can show them, and nothing writes them back.
- The document's top-level `refs` and `refsError` describe the active
  workspace's primary config for the session header. Each resolved workspace
  also carries its own pair, which the edit dialog reads for any workspace;
  neither is ever borrowed from the active one. The pointer and the top-level
  pair move together, from one route answer: a switch keeps the previous
  complete view until the read reports the new workspace and its references.
  A failed switch read applies the activated pointer from the last resolved
  document, with that workspace's own pair, and keeps the `error` status; it
  never shows the old workspace, and it never shows a fabricated empty list
  while the activated workspace is in the last resolved document.
- A retry names the aliases it retries and may carry `confirmRefs`; retrying
  from the pending card confirms the alias the user clicked, so a user-edited
  entry can be written instead of answering `409` forever.
- The review total sums only the repos whose git status was read. A repo whose
  project is gone, or whose read failed, keeps its own card and makes the total
  partial; it is never shown as a clean zero. A repo without git is its own
  state, not zero changes.
- The review reads each repo once per open through the existing git store and
  shows the live branch beside the saved snapshot. A divergence adds a muted
  "current branch" line; nothing checks out or rewrites the snapshot.
- The session header shows the active workspace only when the session's
  directory lands in that workspace's primary repo
  (`sessionPlacement.ts`; the deepest project root wins, so a nested secondary
  or a project outside the workspace is not mistaken for the primary). Only `ok`
  references become `@alias` chips;
  `missing`, `different`, `outside`, `overridden` and `unknown` stay text states,
  and only an owned `missing` reference offers retry. The header retry replaces
  the reference states with the route's answer; it does not rewrite settings or
  config on its own. Every mounted copy of the hook applies that answer through
  `openchamber:workspace-refs-updated`, so the sidebar's edit dialog and the
  header never show different states for the same workspace.
- The session header keeps the workspace name, its subtitle and the retry
  visible at any width. Only the reference entries that fit are rendered; every
  hidden entry, `ok` or not, is counted in a `+N` control whose tooltip lists
  its alias, path and non-`ok` label, so a hidden state is never silent. The
  row is measured from each entry's natural width plus the control, never
  capped by a fixed count, and without `ResizeObserver` the row clips in that
  environment rather than collapsing.

## Decisions

### Why the review panel reads git on open instead of watching branches

Branch is a label saved when the workspace is created or edited, not a checkout
instruction. A watcher would refresh behind the user and imply the snapshot
should follow the live branch; one read per open keeps the review honest and
cheap. Rejected alternative: subscribing the panel to each repo's branch.

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

### Why the header places a session by directory instead of the active project

The active project follows the workspace pointer, but a session opened in
another project stays open beside it. Reading the session's own directory (and
the repo roots the route resolved) keeps the workspace name and its references
off that session, even while the pointer still names the workspace.

### Why a switch applies the pointer with the reference read

The header pairs the workspace name (from the resolved list and the pointer)
with the top-level `refs`, so moving the pointer before the read showed the new
name beside the previous workspace's chip row for one round-trip. The hook
holds the previous complete view and applies the read's pointer and both
reference fields in one state update. The same applies to a settings-synced
pointer from another window, which now only triggers the read. Rejected
alternative: clearing `refs` on the pointer change and showing a loading state,
which adds a third view of the header for a switch that is already in flight.
A failed read applies the activated pointer from the last document's
per-workspace pair, so the old workspace is not claimed and a workspace the
last document described is never shown as having no references. Every other
mounted copy of the hook, such as the header beside the sidebar, is told of the
switch through `openchamber:workspace-active-updated` and reads the same
document; announcing the pointer and letting each copy read is what keeps their
name and chips together.

### Why the header measures the reference row instead of capping it

The entries are text at a user-controlled interface size, and the room left for
them changes with the window, the workspace name and the retry. A fixed cap
either clipped the third chip at 1100px or hid entries while space remained.
Measuring each entry's natural width and the `+N` control, then recounting on
resize, keeps every visible entry whole and makes the count honest. Rejected
alternative: a fixed maximum number of chips, which still clipped at narrow
widths.
