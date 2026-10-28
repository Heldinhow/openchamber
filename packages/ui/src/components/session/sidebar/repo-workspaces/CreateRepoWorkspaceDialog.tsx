import * as React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { RepoWorkspaceCreateForm } from './RepoWorkspaceCreateForm';

type CreateRepoWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onRefsChanged: () => void;
};

export const CreateRepoWorkspaceDialog: React.FC<CreateRepoWorkspaceDialogProps> = ({
  open,
  onOpenChange,
  onCreated,
  onRefsChanged,
}) => {
  const titleId = React.useId();
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent aria-labelledby={titleId} className="sm:max-w-xl">
          <RepoWorkspaceCreateForm
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
