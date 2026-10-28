import * as React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { RepoWorkspaceRef, RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import { RepoWorkspaceCreateForm } from './RepoWorkspaceCreateForm';

type RepoWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onRefsChanged: () => void;
  /** Present when editing any workspace; absent for a new one. */
  editing?: {
    workspace: RepoWorkspaceResolved;
    refs: readonly RepoWorkspaceRef[];
    refsError: { path: string; message: string } | null;
  } | null;
};

export const RepoWorkspaceDialog: React.FC<RepoWorkspaceDialogProps> = ({
  open,
  onOpenChange,
  onCreated,
  onRefsChanged,
  editing = null,
}) => {
  const titleId = React.useId();
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent aria-labelledby={titleId} className="sm:max-w-xl">
          <RepoWorkspaceCreateForm
            editing={editing ?? undefined}
            titleId={titleId}
            onClose={close}
            onCreated={onCreated}
            onRefsChanged={onRefsChanged}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
