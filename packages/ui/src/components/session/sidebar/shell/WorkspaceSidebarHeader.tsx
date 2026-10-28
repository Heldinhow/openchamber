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
  activeWorkspace: RepoWorkspaceResolved;
  activating: boolean;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
};

/**
 * The filter's name, its repo count and the menu that switches workspaces or
 * leaves the filter. "New workspace" opens the create dialog; managing
 * workspaces belongs to ticket 08.
 */
export const WorkspaceSidebarHeader: React.FC<Props> = ({
  workspaces,
  activeWorkspace,
  activating,
  onSelect,
  onCreate,
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
              <span className="truncate typography-ui-section font-semibold text-foreground">{activeWorkspace.name}</span>
              <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[220px] max-w-[calc(100vw-16px)]">
            {workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspace.id;
              return (
                <DropdownMenuItem
                  key={workspace.id}
                  disabled={activating}
                  onClick={() => onSelect(nextActiveWorkspaceId(workspace.id, activeWorkspace.id))}
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
              {emptyColumn}
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
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ms-auto shrink-0 text-[0.6875rem] font-normal text-muted-foreground">
          {repoCountLabel(t, activeWorkspace.repos.length)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t('sessions.sidebar.workspace.new')}
          onClick={onCreate}
        >
          <Icon name="add" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

/**
 * The feature's empty state: a card above the projects, which stay usable
 * without a workspace. It is not the whole sidebar's empty state.
 */
export const WorkspaceEmptyCard: React.FC<{ onCreate: () => void }> = ({ onCreate }) => {
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
export const WorkspaceSidebarSkeleton: React.FC = () => {
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
export const WorkspaceSidebarError: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
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
