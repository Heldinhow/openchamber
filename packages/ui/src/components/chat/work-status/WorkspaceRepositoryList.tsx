import * as React from 'react';
import { useI18n } from '@/lib/i18n';
import type { WorkspaceGitRepoStatus } from '@/lib/repoWorkspaces/useWorkspaceGitStatuses';
import { WorkStatusCollapsibleSection, WorkStatusNote, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';

export type WorkspaceRepositoryRow = {
  projectId: string;
  alias: string;
  primary: boolean;
  /** Project path; null when the project left the catalog. */
  path: string | null;
  /** Branch saved on the workspace when it was created or edited. */
  savedBranch: string;
};

type WorkspaceRepositoryListProps = {
  /** Primary first, then the workspace's repo order. */
  repos: readonly WorkspaceRepositoryRow[];
  statuses: ReadonlyMap<string, WorkspaceGitRepoStatus>;
  /** Missing while the panel has no directory, which also removes the row actions. */
  onOpenRepo?: (path: string) => void;
};

const changedLabel = (
  t: ReturnType<typeof useI18n>['t'],
  count: number,
): string => (count === 1
  ? t('chat.workStatus.repository.changedSingle', { count })
  : t('chat.workStatus.repository.changedPlural', { count }));

/**
 * Every repo of the session's workspace in one collapsible list. A repo whose
 * project is gone keeps its row: it is a missing repo, not a repo without
 * changes. The total in the summary follows the same rule and stays hidden
 * until every listed repo answered, so a partial read cannot read as clean.
 */
export const WorkspaceRepositoryList: React.FC<WorkspaceRepositoryListProps> = ({ repos, statuses, onOpenRepo }) => {
  const { t } = useI18n();

  const totalChanges = React.useMemo(() => {
    let total = 0;
    for (const repo of repos) {
      const status = repo.path === null ? null : statuses.get(repo.projectId);
      if (!status || status.isGitRepo !== true || status.changes === null) return null;
      total += status.changes;
    }
    return total;
  }, [repos, statuses]);

  const repoCount = repos.length;
  const summary = (
    <>
      {repoCount === 1
        ? t('chat.workStatus.repository.repoCountSingle', { count: repoCount })
        : t('chat.workStatus.repository.repoCountPlural', { count: repoCount })}
      {totalChanges !== null ? ` · ${changedLabel(t, totalChanges)}` : null}
    </>
  );

  return (
    <WorkStatusCollapsibleSection
      id="repository-repos"
      title={t('chat.workStatus.repository.title')}
      icon="git-repository"
      defaultExpanded
      summary={summary}
    >
      {repos.map((repo) => {
        const path = repo.path;
        const status = path === null ? null : statuses.get(repo.projectId);
        const missing = path === null;
        const branch = status?.branch ?? null;
        const nonGit = status?.isGitRepo === false;
        const ahead = nonGit ? 0 : status?.ahead ?? 0;
        const behind = nonGit ? 0 : status?.behind ?? 0;
        const changes = nonGit ? null : status?.changes ?? null;
        const primarySuffix = repo.primary ? (
          <span className="text-muted-foreground">{` ${t('chat.workStatus.repository.primary')}`}</span>
        ) : null;
        const aliasLabel = `@${repo.alias}`;
        // A missing row already shows the alias in its leading slot.
        const primaryFallback = missing ? null : (
          <span title={aliasLabel} className="truncate font-mono">{aliasLabel}</span>
        );
        const savedBranchNote = t('chat.workStatus.repository.savedBranch', { branch: repo.savedBranch });

        return (
          <React.Fragment key={repo.projectId}>
            <WorkStatusRow
              icon={repo.primary && !missing ? 'git-branch' : undefined}
              leading={repo.primary && !missing ? undefined : (
                <span title={aliasLabel} className="truncate font-mono text-muted-foreground">{aliasLabel}</span>
              )}
              label={repo.primary ? <>{branch ?? primaryFallback}{primarySuffix}</> : branch}
              muted={missing}
              onClick={!missing && path !== null && onOpenRepo ? () => onOpenRepo(path) : undefined}
              ariaLabel={t('chat.workStatus.action.openChanges')}
              value={missing ? (
                <WorkStatusValue tone="muted">{t('header.repoWorkspace.refMissing')}</WorkStatusValue>
              ) : nonGit ? (
                <WorkStatusValue tone="muted">{t('chat.workStatus.repository.notGit')}</WorkStatusValue>
              ) : (
                <>
                  {ahead > 0 ? <WorkStatusValue tone="muted">{`↑${ahead}`}</WorkStatusValue> : null}
                  {behind > 0 ? <WorkStatusValue tone="muted">{`↓${behind}`}</WorkStatusValue> : null}
                  {changes !== null ? (
                    changes === 0
                      ? <WorkStatusValue tone="muted">{t('chat.workStatus.repository.clean')}</WorkStatusValue>
                      : <WorkStatusValue>{changedLabel(t, changes)}</WorkStatusValue>
                  ) : null}
                </>
              )}
            />
            {!missing && branch !== null && repo.savedBranch !== '' && branch !== repo.savedBranch ? (
              <WorkStatusNote truncate title={savedBranchNote}>
                {savedBranchNote}
              </WorkStatusNote>
            ) : null}
          </React.Fragment>
        );
      })}
    </WorkStatusCollapsibleSection>
  );
};
