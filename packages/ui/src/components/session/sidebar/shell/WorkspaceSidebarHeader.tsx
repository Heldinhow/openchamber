import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/lib/i18n';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';

type Props = {
  workspaces: readonly RepoWorkspaceResolved[];
  onNewSession: (workspace: RepoWorkspaceResolved) => void;
  onEdit: (workspace: RepoWorkspaceResolved) => void;
};

/**
 * One row per workspace until the full section (with its sessions) lands.
 * Plus starts a session owned by the workspace; Edit opens the same
 * name-and-folders form as create.
 */
const WorkspaceSidebarList: React.FC<Props> = ({ workspaces, onNewSession, onEdit }) => {
  const { t } = useI18n();
  return (
    <div className="select-none flex-shrink-0 px-2.5 py-1">
      <p className="flex min-h-8 items-center typography-ui-section font-semibold text-foreground">
        {t('sessions.sidebar.workspace.menuLabel')}
      </p>
      {workspaces.map((workspace) => (
        <div
          key={workspace.id}
          className="group/workspace flex min-h-8 items-center gap-2 rounded-md px-1.5 hover:bg-interactive-hover/40"
        >
          <Icon name="stack" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate typography-ui-section text-foreground" dir="auto" title={workspace.name}>
            {workspace.name}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100"
            aria-label={t('sessions.sidebar.workspace.newSessionFor', { name: workspace.name })}
            onClick={() => onNewSession(workspace)}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100"
            aria-label={t('sessions.sidebar.workspace.editFor', { name: workspace.name })}
            onClick={() => onEdit(workspace)}
          >
            <Icon name="pencil" className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
};

/** Stored workspaces the parser dropped: a count, never a rewrite. */
const WorkspaceDiscardedNotice: React.FC<{ count: number }> = ({ count }) => {
  const { t } = useI18n();
  return (
    <p role="status" className="px-2.5 pb-1 typography-micro text-muted-foreground">
      {count === 1
        ? t('sessions.sidebar.workspace.discardedSingle', { count })
        : t('sessions.sidebar.workspace.discardedPlural', { count })}
    </p>
  );
};

const WorkspaceSidebarSkeleton: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2" role="status" aria-label={t('sessions.sidebar.workspace.loading')}>
      <Skeleton className="h-7 w-[72%]" />
      <Skeleton className="h-7 w-[56%]" />
    </div>
  );
};

/** The projects below stay usable; only the workspace list failed. */
const WorkspaceSidebarError: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5" role="status">
      <p className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">
        {t('sessions.sidebar.workspace.loadFailed')}
      </p>
      <Button variant="link" size="xs" className="h-auto shrink-0 p-0 typography-meta" onClick={onRetry}>
        {t('sessions.sidebar.workspace.retry')}
      </Button>
    </div>
  );
};

type WorkspaceSidebarSlotProps = {
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  workspaces: readonly RepoWorkspaceResolved[];
  discarded: number;
  onRetry: () => void;
  onNewSession: (workspace: RepoWorkspaceResolved) => void;
  onEdit: (workspace: RepoWorkspaceResolved) => void;
};

/**
 * Only the list slot waits for the first read; the project list below is never
 * replaced. A reload that fails keeps the last resolved rows.
 */
export const WorkspaceSidebarSlot: React.FC<WorkspaceSidebarSlotProps> = ({
  status,
  workspaces,
  discarded,
  onRetry,
  onNewSession,
  onEdit,
}) => (
  <>
    {status === 'loading' && workspaces.length === 0 ? <WorkspaceSidebarSkeleton /> : null}
    {workspaces.length > 0 ? <WorkspaceSidebarList workspaces={workspaces} onNewSession={onNewSession} onEdit={onEdit} /> : null}
    {status === 'error' ? <WorkspaceSidebarError onRetry={onRetry} /> : null}
    {discarded > 0 ? <WorkspaceDiscardedNotice count={discarded} /> : null}
  </>
);
