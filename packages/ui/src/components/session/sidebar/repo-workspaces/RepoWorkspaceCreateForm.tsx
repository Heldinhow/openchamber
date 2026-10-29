import * as React from 'react';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import {
  createRepoWorkspace,
  updateRepoWorkspace,
  RepoWorkspaceRequestError,
  type RepoWorkspaceFolderInput,
  type RepoWorkspaceResolved,
} from '@/lib/repoWorkspaces/client';
import { DirectoryExplorerDialog } from '../../DirectoryExplorerDialog';

type DraftRow = {
  key: string;
  /** Empty for a project the catalog lost; the id still names the row. */
  path: string;
  projectId?: string;
  missing?: boolean;
};

type RowError = 'duplicate' | 'missing';

type RepoWorkspaceCreateFormProps = {
  /** Present when the same form edits an existing workspace. */
  editing: RepoWorkspaceResolved | null;
  titleId: string;
  onClose: () => void;
  /** The workspace was saved; reload the list. */
  onSaved: () => void;
  createWorkspace?: typeof createRepoWorkspace;
  updateWorkspace?: typeof updateRepoWorkspace;
};

const rowsFromWorkspace = (workspace: RepoWorkspaceResolved | null): DraftRow[] => (
  workspace?.projects.map((entry) => ({
    key: entry.projectId,
    path: entry.project?.path ?? '',
    projectId: entry.projectId,
    missing: entry.missing,
  })) ?? []
);

/** The one dialog form: a name and the folders that belong to the workspace. */
export const RepoWorkspaceCreateForm: React.FC<RepoWorkspaceCreateFormProps> = ({
  editing,
  titleId,
  onClose,
  onSaved,
  createWorkspace = createRepoWorkspace,
  updateWorkspace = updateRepoWorkspace,
}) => {
  const { t } = useI18n();
  const [name, setName] = React.useState(editing?.name ?? '');
  const [rows, setRows] = React.useState<DraftRow[]>(() => rowsFromWorkspace(editing));
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [attempted, setAttempted] = React.useState(false);
  const nextRowKey = React.useRef(0);
  const nameId = React.useId();
  const nameErrorId = React.useId();
  const rowsErrorId = React.useId();
  const formErrorId = React.useId();

  const trimmedName = name.trim();
  const rowErrors = React.useMemo(() => {
    const errors: Record<string, RowError> = {};
    const seen = new Map<string, string>();
    for (const row of rows) {
      if (row.missing) continue;
      const key = normalizePath(row.path) ?? row.path;
      if (!key) continue;
      if (seen.has(key)) {
        errors[row.key] = 'duplicate';
        errors[seen.get(key)!] = 'duplicate';
      } else {
        seen.set(key, row.key);
      }
    }
    return errors;
  }, [rows]);
  const hasRowErrors = Object.keys(rowErrors).length > 0;
  const canSubmit = trimmedName.length > 0 && rows.length > 0 && !hasRowErrors && !submitting;

  const addFolder = (path: string) => {
    const normalized = normalizePath(path) ?? path;
    setRows((current) => {
      const duplicate = current.some((row) => (normalizePath(row.path) ?? row.path) === normalized);
      if (duplicate) {
        setFormError(t('sessions.sidebar.workspace.folderDuplicate'));
        return current;
      }
      nextRowKey.current += 1;
      return [...current, { key: `new-${nextRowKey.current}`, path }];
    });
  };

  const removeRow = (key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
    setServerErrors({});
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setServerErrors({});
    setFormError(null);
    const folders: RepoWorkspaceFolderInput[] = rows.map((row) => (
      row.path ? { path: row.path } : { projectId: row.projectId }
    ));
    try {
      const result = editing
        ? await updateWorkspace(editing.id, { name: trimmedName, folders })
        : await createWorkspace({ name: trimmedName, folders });
      if (result.configError) {
        toast.error(t('sessions.sidebar.workspace.configWriteFailed'), {
          description: result.configError.path,
        });
      }
      onSaved();
      onClose();
    } catch (error) {
      if (error instanceof RepoWorkspaceRequestError) {
        const fields = error.fields;
        const next: Record<string, string> = {};
        for (const [field, message] of Object.entries(fields)) {
          const match = /^folders\[(\d+)\]\.(?:path|projectId)$/.exec(field);
          const row = match ? rows[Number(match[1])] : undefined;
          if (row) next[row.key] = message;
        }
        setServerErrors(next);
        if (Object.keys(next).length === 0 && !fields.name) {
          setFormError(t(editing ? 'sessions.sidebar.workspace.editFailed' : 'sessions.sidebar.workspace.createFailed'));
        }
        if (fields.name) setFormError(t('sessions.sidebar.workspace.nameRequired'));
      } else {
        setFormError(t(editing ? 'sessions.sidebar.workspace.editFailed' : 'sessions.sidebar.workspace.createFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <h2 id={titleId} className="typography-ui-header font-semibold leading-none text-foreground">
          {editing
            ? t('sessions.sidebar.workspace.editTitle', { name: editing.name })
            : t('sessions.sidebar.workspace.create')}
        </h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="typography-ui-label font-medium text-foreground">
            {t('sessions.sidebar.workspace.nameLabel')}
          </label>
          <Input
            id={nameId}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFormError(null);
            }}
            disabled={submitting}
            aria-invalid={attempted && !trimmedName}
            aria-describedby={attempted && !trimmedName ? nameErrorId : undefined}
          />
          <p id={nameErrorId} role={attempted && !trimmedName ? 'alert' : undefined} className="min-h-4 typography-micro text-status-error">
            {attempted && !trimmedName ? t('sessions.sidebar.workspace.nameRequired') : null}
          </p>
        </div>

        <div className="flex flex-col gap-2" aria-describedby={attempted && rows.length === 0 ? rowsErrorId : undefined}>
          {rows.map((row) => {
            const serverMessage = serverErrors[row.key] ?? null;
            // A duplicate is not a missing folder; keep the localized duplicate
            // message and the row styled as valid.
            const duplicateFromServer = Boolean(serverMessage && /already/i.test(serverMessage));
            const rowError = rowErrors[row.key] ?? (serverMessage && !duplicateFromServer ? 'missing' : null);
            const missing = row.missing || Boolean(serverMessage && !duplicateFromServer);
            const label = row.path || t('sessions.sidebar.workspace.missingProject');
            const errorText = rowError === 'duplicate' || duplicateFromServer
              ? t('sessions.sidebar.workspace.folderDuplicate')
              : rowError
                ? t(row.path ? 'sessions.sidebar.workspace.folderMissing' : 'sessions.sidebar.workspace.missingProject')
                : null;
            return (
              <div key={row.key} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-md bg-[var(--surface-elevated)] px-2.5 py-1.5">
                    <Icon name={missing ? 'alert' : 'folder'} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span
                      className={`min-w-0 truncate font-mono typography-micro ${missing ? 'text-status-warning' : 'text-foreground'}`}
                      title={label}
                    >
                      {label}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 shrink-0 p-0"
                    disabled={submitting}
                    aria-label={t('sessions.sidebar.workspace.removeRepo', { path: label })}
                    onClick={() => removeRow(row.key)}
                  >
                    <Icon name="close" className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {errorText ? (
                  <p role="alert" className="min-h-4 typography-micro text-status-error">
                    {errorText}
                  </p>
                ) : null}
              </div>
            );
          })}
          {attempted && rows.length === 0 ? (
            <p id={rowsErrorId} role="alert" className="min-h-4 typography-micro text-status-error">
              {t('sessions.sidebar.workspace.noRepos')}
            </p>
          ) : null}
          <div>
            <Button variant="outline" size="sm" disabled={submitting} onClick={() => setPickerOpen(true)}>
              <Icon name="folder-add" className="h-3.5 w-3.5" />
              {t('sessions.sidebar.workspace.addFolder')}
            </Button>
          </div>
        </div>

        <p id={formErrorId} role={formError ? 'alert' : undefined} className="min-h-4 typography-micro text-status-error">
          {formError}
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {editing ? t('sessions.sidebar.workspace.saveAction') : t('sessions.sidebar.workspace.createAction')}
          </Button>
        </DialogFooter>
      </form>

      {pickerOpen ? (
        <DirectoryExplorerDialog
          open
          onOpenChange={(open) => {
            if (!open) setPickerOpen(false);
          }}
          onPickDirectory={(path) => {
            setPickerOpen(false);
            addFolder(path);
          }}
        />
      ) : null}
    </>
  );
};
