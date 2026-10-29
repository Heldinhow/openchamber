# Workspace sessions across projects

Status: ready-for-agent

## Problem Statement

A user working across several projects needs one conversation that belongs to the whole workspace. The current workspace associates sessions with a primary project and writes references and permissions into that project's configuration. This makes one project special and couples a shared workspace to a repository's files. The user also needs to see each project's Git state without losing the existing project and session workflows.

## Solution

A workspace has a name, a set of shared projects and its own sessions. No project is primary. Workspace creation and editing write only to a neutral workspace directory owned by OpenChamber; they never write references, permissions or workspace files into member repositories.

The left sidebar presents each workspace as a section with its own sessions. Plain projects keep their existing sections and sessions. A workspace is not a global filter that hides other projects. The right context panel shows the selected workspace session's projects, each with its live branch and changed-file summary; the branch opens the existing Git view scoped to that project.

The approved visual reference is `docs/wireframes/workspace-sidebars.html`. It is a preview, not evidence of working behavior. The requirements below take precedence where the preview contains extra actions or placeholder behavior.

## Validated technical foundation

The neutral-directory execution path was verified against the pinned OpenCode `2.2.0` on 2026-10-28, before this spec was corrected. The fixture lived outside the repository:

- Two git repositories, `repo-a` and `repo-b`.
- A neutral directory that is not a git repository and is not inside either repo, with `.opencode/opencode.json` containing absolute `references` for both repos.
- A real OpenCode session created with `location.directory` set to the neutral directory.
- The session's agent read `repo-a/README.md` and wrote `repo-b/probe.txt` through the normal read/write tools. No explicit permission rule was needed; an explicit `{ action: "edit", resource: "<repo>/*", effect: "allow" }` rule in the neutral config also worked when a broader rule was present.
- After stopping and restarting `opencode serve`, the session list scoped to the neutral directory still returned the session and `session.get` still returned the neutral directory in `location.directory`.
- `GET /api/reference` was empty until the neutral location had been initialized once. Workspace code must not treat that first empty read as "no projects"; the OpenCode config and session path are authoritative.

Conclusions:

- A neutral directory with absolute OpenCode `references` is a working multi-project execution root on the pinned version.
- A workspace session can discover, read and edit every member project with no writes to the member repositories.
- Workspace ownership can be derived from the session's `directory`; no separate session-to-workspace mapping is required.
- Desktop uses the same in-process server and the same OpenCode client contract as web, so this validates the shared execution path for both initial targets.

## User Stories

1. As a user, I want a session owned by a workspace, so that my conversation can span its projects without a primary project.
2. As a user, I want the same project in multiple workspaces, so that each workspace can group the projects relevant to its work.
3. As a user, I want existing projects and their sessions to remain available, so that workspace sessions do not replace my normal workflow.
4. As a user, I want a New workspace button next to New project, so that I can create either kind of grouping from the sidebar.
5. As a user, I want to name a workspace and choose its folders, so that I can define its projects.
6. As a user, I want to add and remove folders before saving, so that I can correct the workspace contents.
7. As a user, I want workspace creation to avoid primary, alias and branch selection, so that no project receives a special role.
8. As a user, I want creation without a `.code-workspace` file, so that workspace configuration stays in OpenChamber.
9. As a user, I want to edit a workspace's name and folders from its hover menu, so that I can maintain the grouping.
10. As a keyboard user, I want the workspace controls available on focus, so that I can use the same actions without a pointer.
11. As a user, I want the workspace's plus button to create a session in that workspace, so that I can start work directly from its row.
12. As a user, I want a workspace section to show only the workspace and its sessions, without repository rows, repository counts or session counts, so that I can navigate conversations directly; plain project sections keep their current presentation.
13. As a user, I want the new-session selector to list both projects and workspaces, so that I can choose the session's owner.
14. As a user, I want a search to find both projects and workspaces containing a project, so that I can find the right context by a familiar project name.
15. As a user, I want to see each workspace project's branch and changed-file summary in the right context panel, so that I can understand the work in progress.
16. As a user, I want to open the existing Git view from a project's branch row, scoped to that project, so that Git acts on the chosen project.
17. As a user, I want no additional project action controls in that panel, so that it stays focused on status and the existing Git entry point.
18. As a user, I want every workspace project to be editable by the session, so that work can span the whole workspace.
19. As a user, I want workspace setup and edits to leave repository files untouched, so that creating a grouping does not alter my projects.
20. As a user, I want workspace sessions and normal project sessions in In work under the existing tracking rules, so that I can see all ongoing work together.
21. As a user, I want In work, search and filtering to treat a workspace session like a normal project session, so that workspace grouping does not hide unrelated ongoing work.
22. As a user, I want one project's unavailable Git state to remain distinct from a clean state, so that I can trust the other projects' status.
23. As a user, I want sessions and workspace settings to survive reopening the app, so that I can resume my work.

## Implementation Decisions

### Data and ownership

- A workspace stores `{ id, name, projectIds }` in OpenChamber settings. `id` is stable; `name` is a label. Project order is the order the user chose. No project is primary; there is no `primaryProjectId`, per-project alias, saved branch or read-only flag in the new shape.
- Workspace ownership of a session is derived from the session's directory. A workspace session is created in the workspace's neutral directory, so its OpenCode record already carries that directory. There is no second session-to-workspace store and no session metadata change.
- The neutral directory is `<OPENCHAMBER_DATA_DIR>/workspaces/<workspace-id>/`. `<workspace-id>` is generated once and never changes when the name or folders change, so existing sessions keep resolving to the workspace.
- The workspace service is the only writer of that directory. It writes `.opencode/opencode.json` with absolute `references` for every member project and `edit` allow rules for every member path. It uses the existing atomic config writer. It does not write into member repositories.
- Reference names are derived deterministically from project labels/folder names, deduplicated with numeric suffixes. They are execution plumbing, not user-facing aliases; no alias field appears in create, edit, the sidebar or the right panel.
- All projects are editable; there is no per-project read-only control and no project action menu. A broad user `deny` must not make a workspace project read-only, which is why the neutral config carries an explicit `edit` allow rule per project.
- A workspace with a project that left the catalog keeps the project id and shows the project as missing. It is omitted from the neutral config and from Git reads, and the other projects still work. A neutral config that exists but cannot be read is an error, never an empty workspace list; a missing config is created from the stored project order on read, so a legacy workspace becomes usable without a repository write.
- Creating or editing a workspace never changes `activeProjectId`, never checks out a branch, never writes a workspace file into a repo, and never removes app-owned references left by an older workspace implementation.
- Existing stored workspaces are read compatibly: `primaryProjectId` is ignored and `repos[].projectId` becomes `projectIds` in stored order. Legacy `createdRefs` and `editRules` are not used by the new flow. A legacy workspace is not migrated by rewriting repository files; its old sessions remain normal sessions in their project. `activeWorkspaceId` is retired and ignored; a workspace is resolved from the selected session.
- Settings writes stay behind the existing `persistSettings` path and the service's settings lock. Two concurrent saves must not drop each other's workspace.
- Create registers a folder that is not a project yet through the shared add-project rule, in the same settings write. A folder already in the catalog is reused, so projects are shared across workspaces with no copy.
- Duplicate folders in one workspace are deduplicated by resolved path. A folder that does not exist or cannot be read is rejected before anything is saved. Removing a folder from a workspace removes only the grouping membership.

### Sessions

- The new-session picker lists both workspaces and projects, grouped as the preview shows. A workspace result creates a draft owned by that workspace. A project result keeps the existing project draft flow.
- A workspace draft resolves its directory from the workspace's neutral directory. The first send creates the session there. Normal project sessions continue to use the project path and are unaffected when that project belongs to a workspace.
- Session creation, routing, draft restoration and last-session restore must preserve the neutral directory. A failed workspace lookup must not silently create the session in a member project or in the previous project.
- Selecting a workspace session makes the neutral directory the effective session directory. The existing Files and Terminal surfaces keep their single-directory behavior there; a multi-root file explorer is out of scope.
- A workspace session can be tracked, marked done, archived and restored by the existing session rules. It is a top-level, unarchived, non-chat session like a normal project session.
- In work includes workspace sessions and normal project sessions under the existing rules. The workspace grouping does not remove a workspace session from In work or hide unrelated In work entries. Search and filtering treat the workspace as a group: matching the workspace shows its sessions, and matching a project also surfaces every workspace that contains that project.

### Left sidebar

- Each workspace is a top-level section in the left sidebar, alongside plain project sections. It renders the workspace row and its sessions. It has no repository rows, no repository count and no session count or badge. Plain project sections keep their existing counts and affordances.
- The workspace row has a plus that opens a workspace session, and a three-dot menu whose only entry is Edit. Hover and keyboard focus reveal both controls; the menu is keyboard reachable and closes on Escape.
- Edit opens the same name-and-folders form as create. It saves the workspace name and project list only.
- The old global workspace filter, its header, its "All projects" selector and the `activeWorkspaceId` sidebar scoping are removed. Workspaces and plain projects are listed together; selecting a workspace session does not filter other sections out.
- The workspace section and its sessions must not be produced by pretending a workspace is a project. The sidebar projection and row model need a workspace section variant; a workspace key must not collide with project keys or be passed to project-only controls.
- A workspace session that belongs to a project which is also a normal project appears under the workspace section, not duplicated under the project section. Sessions in the project directory that were not created by the workspace stay under the project.

### Right context panel

- For a workspace session, the right context panel shows one row per member project, in workspace order. Each row shows the live branch and a changed-file summary (count plus additions/deletions when available). A project without git and a failed read are distinct states; neither is shown as a clean zero. One failed project does not hide the others.
- Clicking the branch opens the existing Git view scoped to that project's directory. The existing Git surface currently reads only the panel's effective directory; it must accept an explicit target directory for this entry point. Opening it must not check out or alter anything.
- The panel has no additional project action controls. The existing WorkStatus card keeps its session-activity role and must not become a second workspace project list.

### Runtime scope and compatibility

- The approved scope is web and desktop. VS Code and mobile behavior stays as it is; the routes and controls are not mounted there.
- Existing project sessions, project settings, projects outside a workspace and existing user data remain intact.
- Failed reads never masquerade as authoritative empty success. Late responses must not cross runtime or session boundaries.
- The old primary-based dialog fields (primary radio, alias, branch, access, `.code-workspace` import) and the routes that only exist for them are removed once the new path is in place. The new flow does not call them.

## Testing Decisions

- Tests exercise observable behavior at the existing seams, not private component details. Use the existing workspace service/routes tests, sidebar projection and row-model tests, session-ownership tests, draft/picker tests and Git store tests.
- Workspace service: create/edit/list with name and folders; shared project; duplicate folders; missing or unreadable folder; unreadable settings; concurrent saves; neutral config contains absolute references and edit allow rules; no write into a member repository; legacy primary-based settings read as the new shape without rewriting repos.
- Sidebar: workspace section renders workspace and sessions only; no repository rows or counts; plain project sections unchanged; hover and keyboard controls; menu Edit; plus creates a workspace session; workspace sessions are not duplicated under a project; unmatched/removed workspace data is reported, not hidden.
- Sessions: picker lists and searches workspaces and projects; a project match surfaces containing workspaces; selecting either kind creates the right draft; workspace session creation uses the neutral directory; a normal project session stays normal; draft and last-session restore keep the workspace; a missing workspace fails visibly.
- In work and filtering: tracked and untracked workspace and normal sessions; workspace search; global In work includes both; ordering and reload; workspace grouping does not hide unrelated entries.
- Right panel: one row per project with branch and changed files; unknown, no-git and failed reads stay distinct; branch opens Git scoped to that project; no project action controls; the WorkStatus card does not duplicate the list.
- End-to-end execution: the neutral-directory path must be checked against the pinned OpenCode binary before release, with at least two real repositories, a read and an edit through the session tools, and a restart. The validation recorded above is the reference; static UI tests alone do not prove it.

## Out of Scope

- Mobile and VS Code support in the initial release.
- New Git actions, branch checkout or branch selection during workspace creation.
- Importing `.code-workspace` files, user-defined aliases or a primary project in the new flow.
- Workspace delete, archive or close actions in the workspace row menu. The preview's extra menu entries do not establish those behaviors.
- A multi-root file explorer, a per-workspace terminal, or changing the existing single-directory Files/Terminal behavior.
- Automatic removal or rewriting of references, permissions or any other configuration previously written into member repositories.

## Further Notes

The current implementation stores a primary project, writes references and permissions into that project's OpenCode configuration, and projects primary-project sessions into the workspace sidebar. The new model replaces those assumptions: the workspace is the session owner, the neutral directory is the execution root, and references live only in OpenChamber's workspace directory.

The earlier spec said a neutral directory "does not claim" to provide multi-project execution. That is no longer true on OpenCode `2.2.0`: the neutral-directory test above read and edited two external repos and survived a restart. The remaining implementation work is UI ownership, migration compatibility and Git targeting, not the execution model.

The test fixture and its logs lived outside the repository and were not committed. The installed binary is the pinned `2.2.0`; the model used was a free public OpenCode model, so the test carried no provider secret.
