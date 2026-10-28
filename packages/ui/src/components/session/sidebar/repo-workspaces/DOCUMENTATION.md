# Workspace dialogs (create, edit, manage, delete)

## Ownership

`RepoWorkspaceCreateForm.tsx` owns both modes: the draft rows, the inline
validation shown before a request, the create warning or the edit diff, the
explicit confirmations, and the pending-references card after a save whose
writes failed. `repoWorkspaceDraft.ts` is the pure draft model: alias generation,
validation, loading an existing workspace, both request bodies and the reference
diff. `RepoWorkspaceDialog.tsx` is only the window around the form.
`RepoWorkspaceManageDialogs.tsx` owns "Manage workspaces" (the list with
Activate, Edit and Delete) and the delete question; their list and question are
exported without the window so the component test drives them directly. The form
never writes settings, projects or config itself; `POST /api/workspaces`,
`POST /api/workspaces/import`, `PATCH /api/workspaces/:id` and
`DELETE /api/workspaces/:id` do, through the server service (import only reads).

The dialogs are mounted only by the desktop/web sidebar, from the empty card and
the workspace header (new, edit, manage). Mobile and VS Code do not register the
route and never mount them.

`RepoWorkspaceReview.tsx` is the "Workspace view" panel. The sidebar row under
the repo list opens it for the active workspace; it reads each repo's git once
through `useGitStore` (no watcher), renders one card per repo and hands the diff
to the existing context panel with the repo as `targetDirectory`. The header
total, partial flag and branch divergence come from
`lib/repoWorkspaces/workspaceReview.ts`; the panel does not recompute them.

## Invariants

- Nothing is written before submit. Picking a folder reads the directory to
  prove it exists (`DirectoryExplorerDialog`'s pick mode), and importing a
  `.code-workspace` reads the file and replaces the draft rows and name;
  neither changes anything outside the form, so cancel after either writes
  nothing.
- Import is offered only in create mode. The first accepted folder is primary,
  an unsupported folder is listed by path, an unreadable or invalid file shows
  its error in the import status slot, and the name stays editable.
- Save stays disabled while the name is empty, no row is primary, a row has no
  valid alias, two rows share an alias, or two rows point at the same folder.
  The server repeats these checks; the client check is what makes the block
  visible without a request.
- Edit opens on the saved name, repos, aliases, primary and branch snapshots.
  A repo whose project is gone shows "Project not found" and keeps its id.
- The create warning is part of the form, not a toast, and stays visible until
  the request: the exact target (`<primary>/.opencode/opencode.json`), one chip
  per secondary alias, and the notice that unregistered folders are registered
  on save. A single-repository draft shows the discreet no-gain note instead.
- The edit warning shows the reference diff (removed, changed and added aliases)
  and the same target. Removing a repo with an owned reference asks whether to
  delete that reference; declining keeps it in the config and removes only the
  repo from the workspace.
- A `different` entry — edited outside the app — is listed as a confirmation.
  Save stays blocked until the user checks it, and a removal question for the
  same alias already is that confirmation. Cancel writes nothing.
- An unreadable config (`422 configError`, or `refsError` on open) shows its
  path, disables save, and keeps the dialog open; file content is never shown.
- A saved workspace whose reference writes failed keeps the workspace and
  replaces the form with the pending card. Each affected alias has its own
  retry; closing the dialog keeps the workspace and the pending references.
- A removal the server refuses (`409` with an alias) is shown with that alias
  and nothing is saved. The caller refreshes the project catalog and the filter
  after `onCreated`.
- "Manage workspaces" lists every workspace with its repo count and marks the
  active one. Activate switches the filter and closes; Edit opens the same form
  on that workspace; Delete opens the delete question.
- The delete question states that sessions stay in their repos and offers a
  checked box only when the workspace owns references. The box names exactly
  `createdRefs`; a secondary reference the user owns is never listed. Cancel
  closes without a request.
- A delete whose owned removal failed keeps the dialog and the workspace open,
  shows the failing alias (or the config path when it could not be read), and
  never claims the workspace was deleted. Only `removed: true` reloads the
  sidebar and closes.
- The review panel reads each repo on open and keeps a read failure in that
  repo's card; the other cards and the total stay. A repo without git is shown
  as "No git", a missing project as "Project not found", and neither becomes a
  silent zero. A diverged live branch adds a muted "current branch" line and
  leaves the saved snapshot alone. "View diff" opens the existing diff on the
  repo whose card was clicked. "Open session" targets the primary and "Edit
  workspace" opens the edit dialog.

## Decisions

### Why one form serves create and edit

Both modes are the same rows, validation and pending transition; only the
initial draft, the notice and the route differ. A second form would duplicate
the validation and the pending card, which are the parts most likely to drift.
The component test drives both routes through the same surface.

### Why the removal question is a checked checkbox

The common action is to remove the repo and its reference together, so the box
starts checked and unchecking preserves the entry. A confirm dialog would add a
second modal inside the dialog and hide the diff the user is deciding on.

### Why the form is its own component

`RepoWorkspaceCreateForm` owns the request and the pending transition so the
dialog around it stays a window with no state. It also lets the component test
submit a draft and reach the pending card without a server, while the surrounding
dialog keeps the focus trap, Escape and the close control.

### Why the import field asks for a path instead of opening a file picker

The server resolves each `folders[].path` relative to the workspace file, so it
must read the file itself and needs its absolute path. A browser file input
gives the client only the file's contents and name, and the desktop picker only
returns folders, so neither can supply that path. The field is the one input the
contract can actually use; the import button stays next to it as the design
asks. Rejected alternative: reading the file in the browser and posting its
contents, which cannot resolve relative folders and would duplicate the parser.

### Why the folder picker is reused in a pick-only mode

`DirectoryExplorerDialog` already owns browsing, keyboard navigation and the
folder policy. A second picker would drift from it. The `onPickDirectory` prop
turns off project registration, bulk add and clone, so the workspace dialog gets
a path and nothing else.

### Why the pending card replaces the form instead of a toast

The workspace already exists and is active; the form's fields no longer describe
anything the user can save. Keeping the card in the same dialog makes the two
facts — created or saved, references pending — one screen, and the per-alias
retry lives next to the alias it retries.

### Why deleting always answers `removed` and not a bare success

The delete button is destructive, so the dialog must be able to tell "deleted"
from "the references could not be removed and the workspace is still here"
without guessing from a status code. `removed` is that single fact; the alias
and the config path are the explanation. The server writes settings only after a
clean removal, so the dialog never has to undo an optimistic close.

### Why editing a non-active workspace opens without reference states

`GET /api/workspaces` returns the active workspace's `refs` because that is what
the sidebar and session header show; reading every workspace's primary config on
a list request is not part of the contract. The manage list can still open the
same form: the draft and diff come from the stored workspace, and the server
revalidates every change, answering `409` with the alias when a hand-edited entry
needs a confirmation the client could not show in advance. Editing the active
workspace keeps the full diff and confirmations.
