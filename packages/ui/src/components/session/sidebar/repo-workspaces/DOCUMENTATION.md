# Workspace dialog (create and edit)

## Ownership

`RepoWorkspaceCreateForm.tsx` owns both modes: the draft rows, the inline
validation shown before a request, the create warning or the edit diff, the
explicit confirmations, and the pending-references card after a save whose
writes failed. `repoWorkspaceDraft.ts` is the pure draft model: alias generation,
validation, loading an existing workspace, both request bodies and the reference
diff. `RepoWorkspaceDialog.tsx` is only the window around the form. The form
never writes settings, projects or config itself; `POST /api/workspaces` and
`PATCH /api/workspaces/:id` do, through the server service.

The dialog is mounted only by the desktop/web sidebar, from the empty card and
the workspace header (new and edit). Mobile and VS Code do not register the
route and never mount it.

## Invariants

- Nothing is written before submit. Picking a folder reads the directory to
  prove it exists (`DirectoryExplorerDialog`'s pick mode) and changes only the
  draft.
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
