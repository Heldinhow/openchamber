import React from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/lib/i18n';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import { nextActiveWorkspaceId } from '../projects/repoWorkspaceSections';

const repoCountLabel = (t: ReturnType<typeof useI18n>['t'], count: number): string => (
  count === 1
    ? t('sessions.sidebar.workspace.repoCountSingle', { count })
    : t('sessions.sidebar.workspace.repoCountPlural', { count })
);

type Props = {
  workspaces: readonly RepoWorkspaceResolved[];
  /** Null when every project is shown: the header then names "All projects". */
  activeWorkspace: RepoWorkspaceResolved | null;
  activating: boolean;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onEdit: () => void;
  onManage: () => void;
};

/**
 * The filter's name, its repo count and the menu that switches workspaces or
 * leaves the filter. "New workspace" opens the create dialog; "Edit workspace"
 * opens the same dialog on the active one.
 */
const WorkspaceSidebarHeader: React.FC<Props> = ({
  workspaces,
  activeWorkspace,
  activating,
  onSelect,
  onCreate,
  onEdit,
  onManage,
}) => {
  const { t } = useI18n();
  const check = <Icon name="check" className="h-4 w-4 flex-shrink-0 text-interactive-selection-foreground" />;
  const checkColumn = <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">{check}</span>;
  const emptyColumn = <span className="inline-flex h-4 w-4 flex-shrink-0" aria-hidden="true" />;

  return (
    <div className="select-none flex-shrink-0 px-2.5 py-1">
      <div className="flex min-h-8 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('sessions.sidebar.workspace.menuLabel')}
            >
              <span className="truncate typography-ui-section font-semibold text-foreground">
                {activeWorkspace ? activeWorkspace.name : t('sessions.sidebar.workspace.allProjects')}
              </span>
              <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[220px] max-w-[calc(100vw-16px)]">
            {workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspace?.id;
              return (
                <DropdownMenuItem
                  key={workspace.id}
                  disabled={activating}
                  onClick={() => onSelect(nextActiveWorkspaceId(workspace.id, activeWorkspace?.id ?? null))}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {active ? checkColumn : emptyColumn}
                    <span className="truncate">{workspace.name}</span>
                  </span>
                  <span className="shrink-0 text-[0.6875rem] font-normal text-muted-foreground">
                    {repoCountLabel(t, workspace.repos.length)}
                  </span>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={activating}
              onClick={() => onSelect(null)}
              className="flex items-center gap-2"
            >
              {activeWorkspace === null ? checkColumn : emptyColumn}
              <span className="truncate">{t('sessions.sidebar.workspace.allProjects')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onCreate}
              className="flex items-center gap-2"
            >
              <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">
                <Icon name="add" className="h-4 w-4" />
              </span>
              <span className="truncate">{t('sessions.sidebar.workspace.new')}</span>
            </DropdownMenuItem>
            {activeWorkspace ? (
              <DropdownMenuItem
                onClick={onEdit}
                className="flex items-center gap-2"
              >
                <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  <Icon name="pencil" className="h-4 w-4" />
                </span>
                <span className="truncate">{t('sessions.sidebar.workspace.edit')}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={onManage}
              className="flex items-center gap-2"
            >
              <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">
                <Icon name="settings-3" className="h-4 w-4" />
              </span>
              <span className="truncate">{t('sessions.sidebar.workspace.manage')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {activeWorkspace ? (
          <span className="ms-auto shrink-0 text-[0.6875rem] font-normal text-muted-foreground">
            {repoCountLabel(t, activeWorkspace.repos.length)}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className={activeWorkspace ? 'size-7 shrink-0' : 'ms-auto size-7 shrink-0'}
          aria-label={t('sessions.sidebar.workspace.new')}
          onClick={onCreate}
        >
          <Icon name="add" className="h-4 w-4" />
        </Button>
      </div>
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

/**
 * The feature's empty state: a card above the projects, which stay usable
 * without a workspace. It is not the whole sidebar's empty state.
 */
const WorkspaceEmptyCard: React.FC<{ onCreate: () => void }> = ({ onCreate }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 px-2.5 py-1">
      <div className="flex min-h-8 items-center gap-2">
        <span className="typography-ui-section font-semibold text-foreground">
          {t('sessions.sidebar.workspace.menuLabel')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto size-7 shrink-0"
          aria-label={t('sessions.sidebar.workspace.new')}
          onClick={onCreate}
        >
          <Icon name="add" className="h-4 w-4" />
        </Button>
      </div>
      <div className="rounded-lg bg-[var(--surface-elevated)] px-4 py-4 text-center">
        <p className="typography-ui-section font-semibold text-foreground">
          {t('sessions.sidebar.workspace.emptyTitle')}
        </p>
        <p className="mt-1 typography-meta text-muted-foreground">
          {t('sessions.sidebar.workspace.emptyBody')}
        </p>
        <Button size="sm" className="mt-3" onClick={onCreate}>
          <Icon name="add" className="h-3.5 w-3.5" />
          {t('sessions.sidebar.workspace.create')}
        </Button>
        <p className="mt-2 typography-micro text-muted-foreground">
          {t('sessions.sidebar.workspace.emptyNote')}
        </p>
      </div>
    </div>
  );
};

/** Three lines where the repo list will be, so the header does not jump in. */
const WorkspaceSidebarSkeleton: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2" role="status" aria-label={t('sessions.sidebar.workspace.loading')}>
      <Skeleton className="h-7 w-[72%]" />
      <Skeleton className="h-7 w-[56%]" />
      <Skeleton className="h-7 w-[40%]" />
    </div>
  );
};

/** The projects below stay usable; only the filter failed. */
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
  activeWorkspace: RepoWorkspaceResolved | null;
  discarded: number;
  activating: boolean;
  onRetry: () => void;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onEdit: () => void;
  onManage: () => void;
};

/**
 * Only the header slot waits for the first read; the project list below is
 * never replaced. A reload that fails keeps the last resolved header.
 */
export const WorkspaceSidebarSlot: React.FC<WorkspaceSidebarSlotProps> = ({
  status,
  workspaces,
  activeWorkspace,
  discarded,
  activating,
  onRetry,
  onSelect,
  onCreate,
  onEdit,
  onManage,
}) => (
  <>
    {status === 'loading' && workspaces.length === 0 ? <WorkspaceSidebarSkeleton /> : null}
    {workspaces.length > 0 ? (
      <WorkspaceSidebarHeader
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        activating={activating}
        onSelect={onSelect}
        onCreate={onCreate}
        onEdit={onEdit}
        onManage={onManage}
      />
    ) : null}
    {status === 'error' ? <WorkspaceSidebarError onRetry={onRetry} /> : null}
    {status === 'ready' && workspaces.length === 0 ? <WorkspaceEmptyCard onCreate={onCreate} /> : null}
    {discarded > 0 ? <WorkspaceDiscardedNotice count={discarded} /> : null}
  </>
);
