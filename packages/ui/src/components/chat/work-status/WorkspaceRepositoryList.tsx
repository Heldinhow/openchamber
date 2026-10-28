import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { WorkspaceGitRepoStatus } from '@/lib/repoWorkspaces/useWorkspaceGitStatuses';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusNote, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';

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

/** Up to this many repos open expanded until the user folds them. */
const EXPANDED_BY_DEFAULT_MAX = 3;

type RepoProps = {
  repo: WorkspaceRepositoryRow;
  status: WorkspaceGitRepoStatus | null;
  defaultExpanded: boolean;
  onOpenRepo?: (path: string) => void;
};

const WorkspaceRepository: React.FC<RepoProps> = ({ repo, status, defaultExpanded, onOpenRepo }) => {
  const { t } = useI18n();
  const id = `repository-repo:${repo.projectId}`;
  const stored = useUIStore(React.useCallback((state) => state.workStatusExpandedSections[id], [id]));
  const setExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);

  const path = repo.path;
  const missing = path === null;
  const nonGit = status?.isGitRepo === false;
  // A missing or non-git repo has nothing to unfold: the trigger already says it all.
  const expandable = !missing && !nonGit;
  const expanded = expandable && (stored ?? defaultExpanded);
  const branch = expandable ? status?.branch ?? null : null;
  const changes = expandable ? status?.changes ?? null : null;
  const ahead = expandable ? status?.ahead ?? 0 : 0;
  const behind = expandable ? status?.behind ?? 0 : 0;
  const savedBranchNote = t('chat.workStatus.repository.savedBranch', { branch: repo.savedBranch });

  // The same compact signals the left sidebar shows; an unknown status shows none,
  // never a false clean.
  let state: React.ReactNode = null;
  if (missing) {
    state = <WorkStatusValue tone="warning">{t('header.repoWorkspace.refMissing')}</WorkStatusValue>;
  } else if (nonGit) {
    state = <WorkStatusValue tone="muted">{t('chat.workStatus.repository.notGit')}</WorkStatusValue>;
  } else if (!expanded && changes === 0) {
    const label = t('sessions.sidebar.workspace.noChanges');
    state = <span role="img" aria-label={label} title={label} className="size-1.5 shrink-0 rounded-full bg-status-success" />;
  } else if (!expanded && changes !== null) {
    const label = changes === 1
      ? t('sessions.sidebar.workspace.changeCountSingle', { count: changes })
      : t('sessions.sidebar.workspace.changeCountPlural', { count: changes });
    state = (
      <span title={label} className="inline-flex shrink-0 items-center gap-0.5 tabular-nums">
        <Icon name="pencil" className="size-3.5" aria-hidden="true" />
        <span aria-hidden="true">{changes}</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  const name = (
    <>
      <span dir="auto" title={repo.alias} className="min-w-0 truncate text-foreground">{repo.alias}</span>
      {repo.primary ? (
        <span className="shrink-0">
          <span aria-hidden="true" className="opacity-50">{' · '}</span>
          {t('chat.workStatus.repository.primary')}
        </span>
      ) : null}
    </>
  );
  const trailing = (
    <span className="ms-auto flex min-w-0 items-center gap-2">
      {state}
      {branch ? (
        <span title={branch} className="flex min-w-0 items-center gap-1">
          <Icon name="git-branch" className="size-3.5 shrink-0" />
          <span dir="auto" className="truncate">{branch}</span>
        </span>
      ) : null}
    </span>
  );
  const triggerClass = 'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-start text-[0.8125rem] text-muted-foreground';

  return (
    <>
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(id, !expanded)}
          // Hover shows through the text, as everywhere in the panel.
          className={cn(triggerClass, 'transition-colors hover:text-foreground')}
        >
          <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
          {name}
          {trailing}
        </button>
      ) : (
        <div className={triggerClass}>
          {/* Keeps the name in line with the expandable rows' names. */}
          <span className="size-3.5 shrink-0" />
          {name}
          {trailing}
        </div>
      )}
      {expanded && changes !== null ? (
        <WorkStatusRow
          icon="file-edit"
          // Under the repo name, past the chevron.
          className="ps-6"
          onClick={changes > 0 && path !== null && onOpenRepo ? () => onOpenRepo(path) : undefined}
          ariaLabel={t('chat.workStatus.action.openChanges')}
          label={changes === 0
            ? t('sessions.sidebar.workspace.noChanges')
            : changes === 1
              ? t('chat.workStatus.git.changedFileSingle', { count: changes })
              : t('chat.workStatus.git.changedFilePlural', { count: changes })}
          value={ahead > 0 || behind > 0 ? (
            <>
              {ahead > 0 ? <WorkStatusValue tone="muted">{`↑${ahead}`}</WorkStatusValue> : null}
              {behind > 0 ? <WorkStatusValue tone="muted">{`↓${behind}`}</WorkStatusValue> : null}
            </>
          ) : undefined}
        />
      ) : null}
      {expanded && branch !== null && repo.savedBranch !== '' && branch !== repo.savedBranch ? (
        <div className="ps-5">
          <WorkStatusNote truncate title={savedBranchNote}>{savedBranchNote}</WorkStatusNote>
        </div>
      ) : null}
    </>
  );
};

/**
 * Every repo of the session's workspace, each its own disclosure. A repo whose
 * project is gone keeps its row: it is a missing repo, not a repo without
 * changes.
 */
export const WorkspaceRepositoryList: React.FC<WorkspaceRepositoryListProps> = ({ repos, statuses, onOpenRepo }) => {
  const defaultExpanded = repos.length <= EXPANDED_BY_DEFAULT_MAX;
  return (
    <>
      {repos.map((repo) => (
        <WorkspaceRepository
          key={repo.projectId}
          repo={repo}
          status={repo.path === null ? null : statuses.get(repo.projectId) ?? null}
          defaultExpanded={defaultExpanded}
          onOpenRepo={onOpenRepo}
        />
      ))}
    </>
  );
};
