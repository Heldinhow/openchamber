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
The displayed config target comes from `GET /api/workspaces/config-target`
through `fetchRepoWorkspaceConfigTarget`; the form never composes the path.

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
- The primary column is grouped by the fieldset's visually hidden legend and
  claims no ARIA role of its own: the same fieldset holds alias inputs, paths,
  remove buttons and the group error, so a radiogroup there would report all of
  them as members. Only the checked row is in the Tab order (`0`, or the first
  enabled row when none is checked); ArrowDown/ArrowRight and ArrowUp/ArrowLeft
  move the selection and focus to the next or previous row, Home and End to the
  first and last, both wrapping at the ends. A submitting form has every row
  disabled and takes no keys.
- Edit opens on the saved name, repos, aliases, primary and branch snapshots.
  A repo whose project is gone shows "Project not found" and keeps its id.
- Only secondary rows show the edit-permission control; the primary row shows
  a static `Editable` label and no control, and every payload names the primary
  `readOnly: false` because the session always runs there. The checkbox is
  checked when the folder may be edited, its visible label names the state
  (`Editable` or `Read-only`) and its accessible name adds the alias. Toggling
  changes only that row. A repo starts editable, whether it is created with the
  workspace or added to it later. A row that becomes primary is set editable in
  the draft and sends `false`; when it becomes secondary again it stays
  editable rather than taking back an earlier read-only choice.
- A saved workspace whose edit-permission rule could not be written still
  counts as saved: the dialog closes and refreshes as usual, after an error
  toast that names the config path. It is not the pending-references card,
  which is reserved for unwritten references.
- The create warning is part of the form, not a toast, and stays visible until
  the request: the exact target (`<primary>/.opencode/opencode.json`) as the
  server resolves it, one chip per secondary alias, and the notice that
  unregistered folders are registered on save. A single-repository draft shows
  the discreet no-gain note instead.
- The target is read again whenever the primary row's path changes and when an
  edit dialog opens. While that read is in flight the card shows no path at all,
  never the folder plus a guessed `.opencode/opencode.json`. Only a failure that
  names an unreadable config (`RepoWorkspaceRequestError` with `configError`)
  uses the config-error block (path plus `configUnreadable`) and keeps save
  disabled. A network failure or a 500 leaves the target blank and save enabled:
  the server still owns the answer, and a blip must not block the dialog until
  it is reopened.
- When the server reports `rootConfigPath`, both the create and edit warning
  cards say that this layer shadows the existing root config file and show that
  path in mono. It is a warning, not an error, and does not block save.
- The edit warning shows the reference diff (removed, changed and added aliases)
  and the same target. Removing a repo with an owned reference asks whether to
  delete that reference; declining keeps it in the config and removes only the
  repo from the workspace.
- A `different` entry — edited outside the app — is listed as a confirmation.
  Save stays blocked until the user checks it, and a removal question for the
  same alias already is that confirmation. An `outside` or `overridden` entry
  is confirmed only when this edit changes the alias, path or description; an
  unchanged one is skipped by the server, so it gets no checkbox. Cancel writes
  nothing.
- Every resolved workspace carries its own `refs`/`refsError`, so editing a
  workspace that is not active still diffs and confirms against that
  workspace's primary config, never another one's.
- An unreadable config (`422 configError`, or `refsError` on open) shows its
  path, disables save, and keeps the dialog open; file content is never shown.
- A saved workspace whose reference writes failed keeps the workspace and
  replaces the form with the pending card. Each affected alias has its own
  retry, carrying that alias as `confirmRefs` so a user-edited entry is not a
  permanent 409; closing the dialog keeps the workspace and the pending
  references.
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
- A delete that removed the workspace but could not remove its app-owned edit
  rule still closes, after a warning toast that names the config path when the
  server supplied one. The deletion stands; the leftover rule is reported, not
  retried from this dialog.
- A delete whose owned removal failed keeps the dialog and the workspace open,
  shows the failing alias (or the config path when it could not be read), and
  never claims the workspace was deleted. Only `removed: true` reloads the
  sidebar and closes. When the failure names an alias, the same block offers two
  retries: delete again with `removeCreatedRefs: false`, which keeps every owned
  reference and says so without naming one alias, or remove the reference file
  entries with `removeCreatedRefs: true`. The second accumulates: each click
  adds its alias to the dialog's confirmed set and sends the whole set, because
  the server refuses the first hand-edited alias before writing anything. A
  second failure names the next alias, and the delete completes once all of
  them are confirmed. Both keep the submitting guard.
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

### Why the dialog asks the server for the config target

The warning must name the file the workspace service will actually write, and
the folder the user picked may be a symlink; composing `<path>/.opencode/
opencode.json` in the browser showed the typed path while the server wrote
through the canonical one. The server already owns path resolution and config
reading, so the same route answers the target and the root file it shadows, and
the browser keeps no second rule for either. Rejected alternative: keeping the
composed path and only fetching the root file, which still disagreed with the
server about the target.

### Why the removal question is a checked checkbox

The common action is to remove the repo and its reference together, so the box
starts checked and unchecking preserves the entry. A confirm dialog would add a
second modal inside the dialog and hide the diff the user is deciding on.

### Why the edit permission is one checkbox that names both states

The row already carries alias, folder, branch and remove, so the permission
answer is a single checkbox rather than two radios or a select: one click and
one extra grid column. Its visible label swaps between "Editable" and
"Read-only" so the unchecked state says what it means without a legend, and its
accessible name adds the alias so a screen reader tells the rows apart.
Rejected alternative: a badge plus an edit button, which spends two states on
two interactions for the same boolean.

### Why a failed permission write is a toast and not the pending card

The workspace and its references were saved; only the permission rule is
missing, and the next save rewrites it. The pending card already means
"references unavailable" and carries a per-alias retry, so folding a second,
different failure into it would make that retry ambiguous. A toast names the
path and closes the dialog on its normal path, and it does not block the save.

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

### Why the primary group's keys live in the form

The shared `Radio` is one control, also used in places that are not a group;
teaching it arrow keys would make every caller build the focus targets. The form
owns the rows, their order, selection and enabled state, so the roving tabindex
and keys live there and `Radio` gains only `tabIndex`. Rejected alternative: a
generic radio-group component with a single caller.

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

### Why the failed delete offers its two retries inline

The user already decided to delete the workspace; the only thing left is whether
the hand-edited reference goes with it. A checkbox after the failure would repeat
the question the dialog already asked, and a second confirmation modal would hide
the alias being decided on. The two buttons name the outcome: one leaves every
owned reference file untouched, the other overwrites the entries the user
confirmed. Both reuse the request and the submitting guard. Each "remove anyway"
sends the aliases confirmed so far, because the server stops at the first
unedited entry it meets and writes nothing; sending only the latest alias would
alternate between two edited entries forever. Rejected alternative: a new
confirmation dialog inside the existing one.

### Why every workspace carries its reference state

`GET /api/workspaces` reads each workspace's primary config, not only the active
one's, because the manage list opens the same edit form on any workspace and that
form must show the confirmation a hand-edited entry needs before the request.
The alternative — reading refs only for the active workspace — left the form
guessing, so a `different` entry edited from the manage list was a permanent
`409` with no checkbox to clear it.
