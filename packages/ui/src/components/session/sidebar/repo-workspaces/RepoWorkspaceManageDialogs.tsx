import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import {
  deleteRepoWorkspace,
  RepoWorkspaceRequestError,
  type DeleteRepoWorkspaceResult,
  type RepoWorkspaceResolved,
} from '@/lib/repoWorkspaces/client';

const repoCountLabel = (t: ReturnType<typeof useI18n>['t'], count: number): string => (
  count === 1
    ? t('sessions.sidebar.workspace.repoCountSingle', { count })
    : t('sessions.sidebar.workspace.repoCountPlural', { count })
);

type ManageListProps = {
  workspaces: readonly RepoWorkspaceResolved[];
  activeWorkspaceId: string | null;
  activating: boolean;
  onActivate: (workspace: RepoWorkspaceResolved) => void;
  onEdit: (workspace: RepoWorkspaceResolved) => void;
  onDelete: (workspace: RepoWorkspaceResolved) => void;
};

/** The list inside "Manage workspaces"; the dialog around it is only a window. */
const RepoWorkspaceManageList: React.FC<ManageListProps> = ({
  workspaces,
  activeWorkspaceId,
  activating,
  onActivate,
  onEdit,
  onDelete,
}) => {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-0.5">
      {workspaces.map((workspace) => {
        const active = workspace.id === activeWorkspaceId;
        return (
          <li key={workspace.id} className="flex min-h-10 items-center gap-2 rounded-md px-2 py-1">
            <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
              {active ? <Icon name="check" className="h-4 w-4 text-interactive-selection-foreground" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate typography-ui-label font-medium text-foreground">{workspace.name}</span>
              <span className="block typography-micro text-muted-foreground">
                {repoCountLabel(t, workspace.repos.length)}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={active || activating}
              aria-label={t('sessions.sidebar.workspace.activateFor', { name: workspace.name })}
              onClick={() => onActivate(workspace)}
            >
              {active ? t('sessions.sidebar.workspace.active') : t('sessions.sidebar.workspace.activate')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={t('sessions.sidebar.workspace.editFor', { name: workspace.name })}
              onClick={() => onEdit(workspace)}
            >
              <Icon name="pencil" className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={t('sessions.sidebar.workspace.deleteFor', { name: workspace.name })}
              onClick={() => onDelete(workspace)}
            >
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
};

type ManageDialogProps = ManageListProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const RepoWorkspaceManageDialog: React.FC<ManageDialogProps> = ({
  open,
  onOpenChange,
  workspaces,
  activeWorkspaceId,
  activating,
  onActivate,
  onEdit,
  onDelete,
}) => {
  const { t } = useI18n();
  const titleId = React.useId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent aria-labelledby={titleId} className="sm:max-w-md">
          <h2 id={titleId} className="typography-ui-header font-semibold leading-none text-foreground">
            {t('sessions.sidebar.workspace.manage')}
          </h2>
          <RepoWorkspaceManageList
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            activating={activating}
            onActivate={onActivate}
            onEdit={onEdit}
            onDelete={onDelete}
          />
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('dialog.common.actions.close')}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

type DeleteFailure = {
  alias: string | null;
  configError: { path: string; message: string } | null;
};

type DeleteContentProps = {
  titleId: string;
  workspace: RepoWorkspaceResolved;
  onClose: () => void;
  onDeleted: () => void;
  deleteWorkspace?: (id: string, removeCreatedRefs: boolean) => Promise<DeleteRepoWorkspaceResult>;
};

/**
 * The delete question with the choice about the references this workspace
 * created. Only `createdRefs` can leave; the sessions are never touched.
 */
const RepoWorkspaceDeleteContent: React.FC<DeleteContentProps> = ({
  titleId,
  workspace,
  onClose,
  onDeleted,
  deleteWorkspace = deleteRepoWorkspace,
}) => {
  const { t } = useI18n();
  const ownedAliases = workspace.createdRefs;
  const [removeRefs, setRemoveRefs] = React.useState(ownedAliases.length > 0);
  const [deleting, setDeleting] = React.useState(false);
  const [failure, setFailure] = React.useState<DeleteFailure | null>(null);
  const aliasList = ownedAliases.map((alias) => `@${alias}`).join(', ');

  const submit = async () => {
    if (deleting) return;
    setDeleting(true);
    setFailure(null);
    try {
      const result = await deleteWorkspace(workspace.id, removeRefs);
      if (result.removed) {
        onDeleted();
        onClose();
        return;
      }
      setFailure({ alias: result.failedAlias, configError: result.configError });
    } catch (error) {
      setFailure({
        alias: error instanceof RepoWorkspaceRequestError
          ? error.conflict?.alias ?? error.conflict?.aliases[0] ?? null
          : null,
        configError: error instanceof RepoWorkspaceRequestError ? error.configError : null,
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 id={titleId} className="typography-ui-header font-semibold leading-none text-foreground">
          {t('sessions.sidebar.workspace.deleteTitle', { name: workspace.name })}
        </h2>
        <p className="typography-meta text-muted-foreground">
          {t('sessions.sidebar.workspace.deleteSessionsNote')}
        </p>
      </div>

      {ownedAliases.length > 0 ? (
        <label className="flex items-start gap-2 typography-meta text-foreground">
          <Checkbox
            checked={removeRefs}
            onChange={setRemoveRefs}
            disabled={deleting}
            ariaLabel={t('sessions.sidebar.workspace.deleteRemoveRefs', { aliases: aliasList })}
          />
          <span className="min-w-0">
            <span className="block">
              {t('sessions.sidebar.workspace.deleteRemoveRefs', { aliases: aliasList })}
            </span>
            <span className="mt-0.5 block typography-micro text-muted-foreground">
              {t('sessions.sidebar.workspace.deleteOwnedNote')}
            </span>
          </span>
        </label>
      ) : null}

      {failure ? (
        <div className="flex flex-col gap-1" role="alert">
          <p className="typography-micro text-status-error">
            {failure.alias
              ? t('sessions.sidebar.workspace.deleteFailedAlias', { alias: failure.alias })
              : t('sessions.sidebar.workspace.deleteFailed')}
          </p>
          {failure.configError ? (
            <>
              <p className="break-all font-mono typography-micro">{failure.configError.path}</p>
              <p className="typography-micro text-muted-foreground">
                {t('sessions.sidebar.workspace.configUnreadable')}
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={deleting}>
          {t('dialog.common.actions.cancel')}
        </Button>
        <Button variant="destructive" onClick={() => void submit()} disabled={deleting}>
          {t('sessions.sidebar.workspace.deleteAction')}
        </Button>
      </div>
    </div>
  );
};

type DeleteDialogProps = {
  open: boolean;
  workspace: RepoWorkspaceResolved | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  deleteWorkspace?: (id: string, removeCreatedRefs: boolean) => Promise<DeleteRepoWorkspaceResult>;
};

export const RepoWorkspaceDeleteDialog: React.FC<DeleteDialogProps> = ({
  open,
  workspace,
  onOpenChange,
  onDeleted,
  deleteWorkspace,
}) => {
  const titleId = React.useId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && workspace ? (
        <DialogContent aria-labelledby={titleId} className="sm:max-w-md">
          <RepoWorkspaceDeleteContent
            key={workspace.id}
            titleId={titleId}
            workspace={workspace}
            onClose={() => onOpenChange(false)}
            onDeleted={onDeleted}
            deleteWorkspace={deleteWorkspace}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
