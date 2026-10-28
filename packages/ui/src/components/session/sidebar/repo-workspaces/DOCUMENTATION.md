# Workspace creation dialog

## Ownership

`RepoWorkspaceCreateForm.tsx` owns the create screen: the draft rows, the
inline validation shown before a request, the warning about the config file, and
the pending-references card after a creation whose writes failed.
`repoWorkspaceDraft.ts` is the pure draft model: alias generation, validation and
the request body. `CreateRepoWorkspaceDialog.tsx` is only the window around the
form. The form never writes settings, projects or config itself;
`POST /api/workspaces` does, through the server service.

The dialog is mounted only by the desktop/web sidebar, from the empty card and
the workspace header. Mobile and VS Code do not register the route and never
mount it.

## Invariants

- Nothing is written before submit. Picking a folder reads the directory to
  prove it exists (`DirectoryExplorerDialog`'s pick mode) and changes only the
  draft.
- Save stays disabled while the name is empty, no row is primary, a row has no
  valid alias, two rows share an alias, or two rows point at the same folder.
  The server repeats these checks; the client check is what makes the block
  visible without a request.
- The warning is part of the form, not a toast, and stays visible until the
  request: the exact target (`<primary>/.opencode/opencode.json`), one chip per
  secondary alias, and the notice that unregistered folders are registered on
  save. A single-repository draft shows the discreet no-gain note instead.
- A folder without a project is marked "Project not registered" from the
  current project catalog. Nothing is registered until the request succeeds.
- An unreadable config (`422 configError`) shows its path and keeps the dialog
  open; the file content is never shown or echoed.
- A created workspace whose reference writes failed keeps the workspace and
  replaces the form with the pending card. Each affected alias has its own
  retry; closing the dialog keeps the workspace and the pending references.
- The workspace is activated by the server. The caller refreshes the project
  catalog and the filter after `onCreated`.

## Decisions

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
facts — created, references pending — one screen, and the per-alias retry lives
next to the alias it retries.
