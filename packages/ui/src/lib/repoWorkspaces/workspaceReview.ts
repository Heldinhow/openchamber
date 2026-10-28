import type { RepoWorkspaceRef, RepoWorkspaceResolved } from './client';

type WorkspaceReviewFile = {
  path: string;
  /** The status columns joined, e.g. `M`, `AM`, `??`; empty when git reports neither. */
  status: string;
};

/** The subset of `GitStatus` the review reads. */
export type WorkspaceReviewStatus = {
  current: string;
  ahead: number;
  behind: number;
  files: ReadonlyArray<{ path: string; index: string; working_dir: string }>;
};

/**
 * What the panel knows about one repository's git. `loading`, `error` and
 * `not-git` are real states: none of them may become an empty, clean
 * repository.
 */
export type WorkspaceReviewGitReadout =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'not-git' }
  | { state: 'ready'; status: WorkspaceReviewStatus };

export type WorkspaceReviewRepoGit =
  | { state: 'missing' }
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'not-git' }
  | {
    state: 'ready';
    branch: string | null;
    ahead: number;
    behind: number;
    changes: number;
    files: readonly WorkspaceReviewFile[];
  };

export type WorkspaceReviewRepo = {
  projectId: string;
  alias: string;
  label: string;
  path: string | null;
  primary: boolean;
  /** The branch saved when the workspace was created or edited; a label, never a checkout. */
  branchSnapshot: string;
  currentBranch: string | null;
  branchDiverged: boolean;
  git: WorkspaceReviewRepoGit;
  /** The reference state of a secondary repo; the primary has none. */
  reference: RepoWorkspaceRef | null;
};

type WorkspaceReview = {
  workspaceName: string;
  repoCount: number;
  /** The sum of the repositories whose changes could be read. */
  totalChanges: number;
  /** True when a repo is gone or could not be read, so the total leaves it out. */
  changesPartial: boolean;
  loading: boolean;
  repos: readonly WorkspaceReviewRepo[];
};

type Args = {
  workspace: RepoWorkspaceResolved;
  refs: readonly RepoWorkspaceRef[];
  gitByProject: ReadonlyMap<string, WorkspaceReviewGitReadout>;
};

const fileStatus = (file: WorkspaceReviewStatus['files'][number]): string => (
  `${file.index}${file.working_dir}`.replace(/\s+/g, '')
);

const repoGit = (
  repo: RepoWorkspaceResolved['repos'][number],
  gitByProject: ReadonlyMap<string, WorkspaceReviewGitReadout>,
): WorkspaceReviewRepoGit => {
  if (repo.missing || !repo.project) return { state: 'missing' };
  const readout = gitByProject.get(repo.projectId) ?? { state: 'loading' };
  if (readout.state !== 'ready') return readout;
  const branch = readout.status.current.trim();
  return {
    state: 'ready',
    branch: branch || null,
    ahead: readout.status.ahead,
    behind: readout.status.behind,
    changes: readout.status.files.length,
    files: readout.status.files.map((file) => ({ path: file.path, status: fileStatus(file) })),
  };
};

/**
 * The review panel's only projection: workspace, its reference states and the
 * per-repo git readout become the cards and the header total. A repo whose
 * project is gone, whose git failed, or whose read is still running is never
 * counted as a clean zero; gone or failed repos make the total partial, and a
 * running read is reported as loading.
 */
export const projectWorkspaceReview = ({
  workspace,
  refs,
  gitByProject,
}: Args): WorkspaceReview => {
  const refsByAlias = new Map(refs.map((ref) => [ref.alias, ref]));

  const repos = workspace.repos.map((repo): WorkspaceReviewRepo => {
    const git = repoGit(repo, gitByProject);
    const branchSnapshot = repo.branch.trim();
    const currentBranch = git.state === 'ready' ? git.branch : null;
    return {
      projectId: repo.projectId,
      alias: repo.alias,
      label: repo.project?.label || repo.alias,
      path: repo.project?.path ?? null,
      primary: repo.projectId === workspace.primaryProjectId,
      branchSnapshot,
      currentBranch,
      branchDiverged: branchSnapshot.length > 0 && currentBranch !== null && branchSnapshot !== currentBranch,
      git,
      reference: repo.projectId === workspace.primaryProjectId ? null : refsByAlias.get(repo.alias) ?? null,
    };
  });

  return {
    workspaceName: workspace.name,
    repoCount: repos.length,
    totalChanges: repos.reduce((total, repo) => (
      repo.git.state === 'ready' ? total + repo.git.changes : total
    ), 0),
    changesPartial: repos.some((repo) => (
      repo.git.state === 'missing' || repo.git.state === 'error'
    )),
    loading: repos.some((repo) => repo.git.state === 'loading'),
    repos,
  };
};
