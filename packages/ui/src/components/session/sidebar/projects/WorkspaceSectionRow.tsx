import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { RepoWorkspacesStatus } from '@/hooks/useRepoWorkspaces';
import { CrossfadeZoneHeader } from './CrossfadeZoneHeaders';
import type { WorkspaceSection, WorkspaceSidebarIdentity } from './workspaceSections';

type RowProps = {
  section: WorkspaceSection;
  collapsed: boolean;
  forceExpanded: boolean;
  alwaysShowActions: boolean;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  onToggle: () => void;
  onNewSession: (workspace: WorkspaceSidebarIdentity) => void;
  onEdit: (workspaceId: string) => void;
};

/**
 * The workspace's own top-level row. It has no repository rows, repository
 * count or session count: a workspace is an owner, not a project. Hover and
 * keyboard focus reveal the plus and the menu, whose only entry is Edit.
 */
export const WorkspaceSectionRow: React.FC<RowProps> = ({
  section,
  collapsed,
  forceExpanded,
  alwaysShowActions,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  onToggle,
  onNewSession,
  onEdit,
}) => {
  const { t } = useI18n();
  const { workspace } = section;
  const menuKey = `workspace:${workspace.id}`;
  const isMenuOpen = openSidebarMenuKey === menuKey;
  const revealActions = alwaysShowActions || isMenuOpen
    ? 'opacity-100 pointer-events-auto'
    : 'opacity-0 pointer-events-none group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto group-has-[:focus-visible]/workspace:opacity-100 group-has-[:focus-visible]/workspace:pointer-events-auto';

  return (
    <CrossfadeZoneHeader
      className="-ms-2.5 -me-2 text-start group/workspace select-none sticky top-0 z-20 bg-sidebar"
      data-sidebar-sticky-header="true"
    >
      <div className="relative flex items-center gap-1 py-1 ps-4 pe-3.5">
        <button
          type="button"
          onClick={() => { if (!forceExpanded) onToggle(); }}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md pe-[4.5rem] text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
            <Icon
              name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground',
                alwaysShowActions ? 'inline-flex' : 'opacity-0 group-hover/workspace:opacity-100 group-has-[:focus-visible]/workspace:opacity-100',
              )}
            />
            <Icon
              name="stack"
              className={cn(
                'absolute inset-0 m-auto h-3.5 w-3.5 text-muted-foreground',
                alwaysShowActions ? 'hidden' : 'group-hover/workspace:opacity-0 group-has-[:focus-visible]/workspace:opacity-0',
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate typography-ui-section font-semibold text-foreground" dir="auto" title={workspace.name}>
            {workspace.name}
          </span>
        </button>

        <div className="absolute inset-e-0.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={cn('size-6 shrink-0 text-muted-foreground hover:text-foreground', revealActions)}
            aria-label={t('sessions.sidebar.workspace.newSessionFor', { name: workspace.name })}
            onClick={() => onNewSession(workspace)}
          >
            <Icon name="add" className="h-4 w-4" />
          </Button>
          <DropdownMenu open={isMenuOpen} onOpenChange={(open) => setOpenSidebarMenuKey(open ? menuKey : null)}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn('size-6 shrink-0 text-muted-foreground hover:text-foreground', revealActions)}
                aria-label={t('sessions.sidebar.workspace.menuFor', { name: workspace.name })}
              >
                <Icon name="more-2" className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem onClick={() => { setOpenSidebarMenuKey(null); onEdit(workspace.id); }}>
                <Icon name="pencil" className="me-1.5 h-4 w-4" />
                {t('sessions.sidebar.workspace.edit')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </CrossfadeZoneHeader>
  );
};

type StatusProps = {
  status: RepoWorkspacesStatus;
  hasRows: boolean;
  discarded: number;
  onRetry: () => void;
};

/**
 * Workspace read state and dropped stored entries. It sits beside the list and
 * never replaces it: the last resolved rows and every project stay usable.
 */
export const WorkspaceSidebarStatus: React.FC<StatusProps> = ({ status, hasRows, discarded, onRetry }) => {
  const { t } = useI18n();
  return (
    <>
      {status === 'loading' && !hasRows ? (
        <div className="px-2.5 py-2" role="status" aria-label={t('sessions.sidebar.workspace.loading')}>
          <Skeleton className="h-7 w-[72%]" />
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="flex items-center gap-2 px-2.5 py-1.5" role="status">
          <p className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">
            {t('sessions.sidebar.workspace.loadFailed')}
          </p>
          <Button variant="link" size="xs" className="h-auto shrink-0 p-0 typography-meta" onClick={onRetry}>
            {t('sessions.sidebar.workspace.retry')}
          </Button>
        </div>
      ) : null}
      {discarded > 0 ? (
        <p role="status" className="px-2.5 pb-1 typography-micro text-muted-foreground">
          {discarded === 1
            ? t('sessions.sidebar.workspace.discardedSingle', { count: discarded })
            : t('sessions.sidebar.workspace.discardedPlural', { count: discarded })}
        </p>
      ) : null}
    </>
  );
};
