import * as React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import { RepoWorkspaceCreateForm } from './RepoWorkspaceCreateForm';

type RepoWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** Present when editing a workspace; absent for a new one. */
  editing?: RepoWorkspaceResolved | null;
};

export const RepoWorkspaceDialog: React.FC<RepoWorkspaceDialogProps> = ({
  open,
  onOpenChange,
  onSaved,
  editing = null,
}) => {
  const titleId = React.useId();
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent aria-labelledby={titleId} className="sm:max-w-xl">
          <RepoWorkspaceCreateForm
            editing={editing}
            titleId={titleId}
            onClose={close}
            onSaved={onSaved}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
