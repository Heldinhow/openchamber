# Workspace dialogs (create and edit)

## Ownership

`RepoWorkspaceCreateForm.tsx` owns both modes: the name, the folder rows, the
inline validation shown before a request, the folder picker, and the server
fields shown on their row. `RepoWorkspaceDialog.tsx` is only the window around
the form. There is no manage list, delete question, review panel, import field
or reference confirmation; those belonged to the retired primary-based model.

`repoWorkspaceDraft.ts` is gone with the primary, alias and branch fields. The
form sends `{ name, folders }`, where a row is `{ path }` for a folder the user
picked or `{ projectId }` for a project the catalog lost.

The dialogs are mounted only by the desktop/web sidebar: from the New workspace
control next to New project and from a workspace row's Edit control. Mobile and
VS Code do not register the route and never mount them.

## Invariants

- Nothing is written before submit. Picking a folder only adds a row; Cancel
  writes nothing.
- The same form serves create and edit. Edit opens on the saved name and
  projects in workspace order; a project whose catalog entry is gone shows
  "Project not found" and keeps its id.
- Save is disabled for an empty name, no rows, or two rows with the same
  resolved path. The server repeats these checks; the client check is what makes
  the block visible without a request.
- A server field (`name`, `folders[i].path`, `folders[i].projectId`) is shown on
  that row, localized. A folder the server rejected reads as "Folder not found";
  a project the server rejected reads as "Project not found".
- A saved workspace whose neutral config could not be written still counts as
  saved: the dialog closes and reloads as usual, after an error toast that names
  the config path. The next list read reports the same error.
- A create can register a folder that was not a project yet; the folder picker
  itself registers nothing and the server stores the new project in the same
  settings write as the workspace.
- Every row is editable. There is no primary, alias, branch, access or import
  control, and no row carries a read-only flag.
