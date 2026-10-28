import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { RepoWorkspaceRef, RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import {
  changeStatusKey,
  projectWorkspaceReview,
  type WorkspaceReviewGitReadout,
  type WorkspaceReviewRepo,
} from '@/lib/repoWorkspaces/workspaceReview';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

const refStateKey = (status: RepoWorkspaceRef['status']): I18nKey => {
  switch (status) {
    case 'missing': return 'header.repoWorkspace.refMissing';
    case 'different': return 'header.repoWorkspace.refDifferent';
    case 'outside': return 'header.repoWorkspace.refOutside';
    case 'overridden': return 'header.repoWorkspace.refOverridden';
    default: return 'header.repoWorkspace.refUnknown';
  }
};

const gitStateLabel = (
  t: ReturnType<typeof useI18n>['t'],
  state: WorkspaceReviewRepo['git']['state'],
): string => {
  switch (state) {
    case 'missing': return t('sessions.sidebar.workspace.missingProject');
    case 'not-git': return t('sessions.sidebar.workspace.noGit');
    case 'error': return t('sessions.sidebar.workspace.reviewReadFailed');
    case 'loading': return t('common.loading');
    default: return '';
  }
};

/**
 * Reads each repo through the existing git store, once per open. There is no
 * watcher and no per-branch background refresh: the panel shows what it read
 * when it opened. An error is kept for its repo alone.
 */
const useWorkspaceReviewGit = (
  open: boolean,
  workspace: RepoWorkspaceResolved | null,
): ReadonlyMap<string, WorkspaceReviewGitReadout> => {
  const { git } = useRuntimeAPIs();
  const directories = useGitStore((state) => state.directories);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const [loading, setLoading] = React.useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = React.useState<ReadonlySet<string>>(() => new Set());

  React.useEffect(() => {
    if (!open || !workspace) return;
    const targets = workspace.repos.flatMap((repo) => (
      !repo.missing && repo.project
        ? [{ projectId: repo.projectId, path: repo.project.path }]
        : []
    ));
    setLoading(new Set(targets.map((target) => target.projectId)));
    setErrors(new Set());
    let cancelled = false;

    const settle = (projectId: string, failed: boolean) => {
      if (cancelled) return;
      setLoading((current) => {
        if (!current.has(projectId)) return current;
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
      if (failed) setErrors((current) => new Set(current).add(projectId));
    };

    for (const target of targets) {
      void fetchStatus(target.path, git, { silent: true, force: true, throwOnError: true }).then(
        () => settle(target.projectId, false),
        () => settle(target.projectId, true),
      );
    }

    return () => {
      cancelled = true;
    };
  }, [open, workspace, git, fetchStatus, runtimeKey]);

  return React.useMemo(() => {
    const readouts = new Map<string, WorkspaceReviewGitReadout>();
    for (const repo of workspace?.repos ?? []) {
      if (repo.missing || !repo.project) continue;
      if (loading.has(repo.projectId)) {
        readouts.set(repo.projectId, { state: 'loading' });
        continue;
      }
      if (errors.has(repo.projectId)) {
        readouts.set(repo.projectId, { state: 'error' });
        continue;
      }
      const state = directories.get(repo.project.path);
      if (!state || state.isGitRepo === null) {
        readouts.set(repo.projectId, { state: 'loading' });
        continue;
      }
      if (state.isGitRepo === false) {
        readouts.set(repo.projectId, { state: 'not-git' });
        continue;
      }
      if (!state.status) {
        readouts.set(repo.projectId, { state: 'loading' });
        continue;
      }
      readouts.set(repo.projectId, { state: 'ready', status: state.status });
    }
    return readouts;
  }, [directories, errors, loading, workspace]);
};

const changeLabel = (t: ReturnType<typeof useI18n>['t'], count: number): string => (
  count === 1
    ? t('sessions.sidebar.workspace.changeCountSingle', { count })
    : t('sessions.sidebar.workspace.changeCountPlural', { count })
);

const repoCountLabel = (t: ReturnType<typeof useI18n>['t'], count: number): string => (
  count === 1
    ? t('sessions.sidebar.workspace.repoCountSingle', { count })
    : t('sessions.sidebar.workspace.repoCountPlural', { count })
);

const RepoReviewCard: React.FC<{
  repo: WorkspaceReviewRepo;
  refsError: { path: string; message: string } | null;
  onOpenDiff: (path: string) => void;
}> = ({ repo, refsError, onOpenDiff }) => {
  const { t } = useI18n();
  const branch = repo.branchSnapshot || (repo.git.state === 'ready' ? repo.git.branch : null);
  const ahead = repo.git.state === 'ready' ? repo.git.ahead : 0;
  const behind = repo.git.state === 'ready' ? repo.git.behind : 0;
  const repositoryPath = repo.path;
  const reference = repo.reference;
  const refState = reference && reference.status !== 'ok' ? reference : null;

  return (
    <div className="flex min-w-0 flex-col rounded-lg bg-[var(--surface-elevated)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate typography-ui-label font-medium text-foreground" title={repo.path ?? repo.label}>
              {repo.label}
            </span>
            {repo.primary ? (
              <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                · {t('sessions.sidebar.workspace.reviewPrimary')}
              </span>
            ) : null}
          </div>
          {branch ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted-foreground">
              <Icon name="git-branch" className="h-3 w-3 flex-shrink-0" />
              <span className="truncate font-mono" title={branch}>{branch}</span>
              {ahead > 0 || behind > 0 ? (
                <span className="shrink-0" title={t('sessions.sidebar.workspace.reviewAheadBehind', { ahead, behind })}>
                  {ahead > 0 ? `↑${ahead}` : ''}
                  {ahead > 0 && behind > 0 ? ' ' : ''}
                  {behind > 0 ? `↓${behind}` : ''}
                </span>
              ) : null}
            </div>
          ) : null}
          {repo.branchDiverged && repo.currentBranch ? (
            <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
              {t('sessions.sidebar.workspace.reviewCurrentBranch', { branch: repo.currentBranch })}
            </p>
          ) : null}
        </div>
        {repo.git.state === 'ready' ? (
          repo.git.changes === 0 ? (
            <span
              className="mt-1 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-status-success"
              title={t('sessions.sidebar.workspace.noChanges')}
              role="img"
              aria-label={t('sessions.sidebar.workspace.noChanges')}
            />
          ) : (
            <span className="flex shrink-0 items-center gap-0.5 text-[0.6875rem] font-medium text-muted-foreground">
              <Icon name="pencil" className="h-3 w-3" aria-hidden="true" />
              <span aria-hidden="true">{repo.git.changes}</span>
              <span className="sr-only">{changeLabel(t, repo.git.changes)}</span>
            </span>
          )
        ) : null}
      </div>

      {repo.git.state === 'ready' ? (
        repo.git.files.length > 0 ? (
          <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto">
            {repo.git.files.map((file) => (
              <li key={file.path} className="flex min-w-0 items-center gap-1.5">
                <span className="w-4 shrink-0 font-mono text-[0.6875rem] text-muted-foreground" aria-hidden="true">
                  {file.status}
                </span>
                <span className="sr-only">{t(changeStatusKey(file.status))}</span>
                <span className="truncate font-mono text-[0.6875rem] text-muted-foreground" title={file.path}>
                  {file.path}
                </span>
              </li>
            ))}
          </ul>
        ) : null
      ) : (
        <p className={`mt-1 text-[0.6875rem] ${repo.git.state === 'error' ? 'text-status-warning' : 'text-muted-foreground'}`}>
          {gitStateLabel(t, repo.git.state)}
        </p>
      )}

      {refState ? (
        <p
          className={`mt-1 flex min-w-0 items-center gap-1 text-[0.6875rem] ${refState.status === 'missing' || refState.status === 'unknown' ? 'text-status-warning' : 'text-muted-foreground'}`}
          title={refState.status === 'unknown' && refsError ? `${refsError.path}: ${refsError.message}` : undefined}
        >
          <span className="shrink-0 font-mono">@{refState.alias}</span>
          <span className="truncate">{t(refStateKey(refState.status))}</span>
        </p>
      ) : null}

      {repo.git.state === 'ready' && repositoryPath ? (
        <Button
          variant="link"
          size="xs"
          className="mt-1 h-auto justify-start p-0 typography-meta"
          onClick={() => onOpenDiff(repositoryPath)}
        >
          {t('sessions.sidebar.workspace.viewDiff')}
        </Button>
      ) : null}
    </div>
  );
};

type RepoWorkspaceReviewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: RepoWorkspaceResolved | null;
  refs: readonly RepoWorkspaceRef[];
  refsError: { path: string; message: string } | null;
  onEdit: () => void;
  onOpenSession: () => void;
  onOpenDiff: (path: string) => void;
};

/**
 * The workspace's review panel: one card per repo with its live git state, the
 * reference state it owns, the header total over the repos that could be read,
 * and the two ways out — edit the workspace or open a session in the primary.
 */
export const RepoWorkspaceReview: React.FC<RepoWorkspaceReviewProps> = ({
  open,
  onOpenChange,
  workspace,
  refs,
  refsError,
  onEdit,
  onOpenSession,
  onOpenDiff,
}) => {
  const { t } = useI18n();
  const titleId = React.useId();
  const gitByProject = useWorkspaceReviewGit(open, workspace);
  const review = React.useMemo(() => (
    workspace ? projectWorkspaceReview({ workspace, refs, gitByProject }) : null
  ), [gitByProject, refs, workspace]);
  const primaryAvailable = review?.repos.some((repo) => repo.primary && repo.path !== null) ?? false;

  return (
    <Dialog open={open && workspace !== null} onOpenChange={onOpenChange}>
      {open && workspace && review ? (
        <DialogContent aria-labelledby={titleId} className="sm:max-w-2xl">
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle id={titleId}>{review.workspaceName}</DialogTitle>
            <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
              <span>{repoCountLabel(t, review.repoCount)}</span>
              <span aria-hidden="true">·</span>
              {review.loading ? (
                <span>{t('common.loading')}</span>
              ) : (
                <span>{changeLabel(t, review.totalChanges)}</span>
              )}
              {!review.loading && review.changesPartial ? (
                <span title={t('sessions.sidebar.workspace.reviewPartialHint')}>
                  · {t('sessions.sidebar.workspace.reviewPartial')}
                </span>
              ) : null}
            </div>
          </div>

          <div className="grid max-h-[60vh] gap-2 overflow-y-auto sm:grid-cols-2">
            {review.repos.map((repo) => (
              <RepoReviewCard
                key={repo.projectId}
                repo={repo}
                refsError={refsError}
                onOpenDiff={onOpenDiff}
              />
            ))}
          </div>

          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" onClick={onEdit}>
              {t('sessions.sidebar.workspace.edit')}
            </Button>
            <Button disabled={!primaryAvailable} onClick={onOpenSession}>
              {t('sessions.sidebar.workspace.openSession')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
