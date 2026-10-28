import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import {
  createRepoWorkspace,
  fetchRepoWorkspaceConfigTarget,
  importRepoWorkspace,
  retryRepoWorkspaceRefs,
  updateRepoWorkspace,
  RepoWorkspaceRequestError,
  type CreateRepoWorkspaceInput,
  type CreateRepoWorkspaceResult,
  type RepoWorkspaceConfigTarget,
  type RepoWorkspaceImportDraft,
  type RepoWorkspaceRef,
  type RepoWorkspaceResolved,
  type RetryRepoWorkspaceRefsResult,
  type UpdateRepoWorkspaceInput,
} from '@/lib/repoWorkspaces/client';
import { DirectoryExplorerDialog } from '../../DirectoryExplorerDialog';
import {
  aliasForFolder,
  createPayloadFromDraft,
  diffRepoWorkspaceRefs,
  draftFromWorkspace,
  emptyRepoWorkspaceDraft,
  suggestedAlias,
  updatePayloadFromDraft,
  validateRepoWorkspaceDraft,
  type RepoWorkspaceDraft,
  type RepoWorkspaceDraftRow,
  type RepoWorkspaceRowError,
} from './repoWorkspaceDraft';

type PendingRefs = {
  workspaceId: string;
  configTarget: RepoWorkspaceConfigTarget;
  aliases: string[];
  configError: { path: string; message: string } | null;
  retryFailed: string | null;
};

type SubmitErrors = {
  name: boolean;
  primary: boolean;
  rows: Record<string, RepoWorkspaceRowError>;
  form: boolean;
};

const emptySubmitErrors = (): SubmitErrors => ({ name: false, primary: false, rows: {}, form: false });

type RepoWorkspaceCreateFormProps = {
  /** Rows the form opens with; empty for a new workspace. */
  initialDraft?: RepoWorkspaceDraft;
  /** Present when the same form edits an existing workspace. */
  editing?: {
    workspace: RepoWorkspaceResolved;
    refs: readonly RepoWorkspaceRef[];
    refsError: { path: string; message: string } | null;
  };
  titleId: string;
  onClose: () => void;
  /** The workspace exists and is active; refresh the catalog and the filter. */
  onCreated: () => void;
  /** References changed shape while the workspace already existed. */
  onRefsChanged: () => void;
  createWorkspace?: (input: CreateRepoWorkspaceInput) => Promise<CreateRepoWorkspaceResult>;
  updateWorkspace?: (id: string, input: UpdateRepoWorkspaceInput) => Promise<CreateRepoWorkspaceResult>;
  retryRefs?: (id: string, aliases?: string[], confirmRefs?: string[]) => Promise<RetryRepoWorkspaceRefsResult>;
  importWorkspace?: (filePath: string) => Promise<RepoWorkspaceImportDraft>;
  fetchConfigTarget?: (path: string) => Promise<RepoWorkspaceConfigTarget>;
};

const ROW_GRID_COLS = 'grid-cols-[4.5rem_minmax(4.5rem,7rem)_minmax(0,1fr)_7rem_1.75rem]';

const rowIndexFromField = (field: string): number | null => {
  const match = /^repos\[(\d+)\]/.exec(field);
  return match ? Number(match[1]) : null;
};

const RepoRow: React.FC<{
  row: RepoWorkspaceDraftRow;
  isPrimary: boolean;
  registered: boolean;
  error: RepoWorkspaceRowError | undefined;
  suggestion: string | null;
  disabled: boolean;
  /** 0 for the group's single Tab stop, -1 for the other rows. */
  tabIndex: number;
  onPrimary: () => void;
  onAlias: (alias: string) => void;
  onRemove: () => void;
}> = ({ row, isPrimary, registered, error, suggestion, disabled, tabIndex, onPrimary, onAlias, onRemove }) => {
  const { t } = useI18n();
  const status = useGitStatus(row.path);
  const branch = status?.current ?? row.branch ?? '';
  const aliasErrorId = `workspace-alias-error-${row.key}`;

  React.useEffect(() => {
    const git = getRegisteredRuntimeAPIs()?.git;
    if (!git || !row.path) return;
    void useGitStore.getState().ensureStatus(row.path, git).catch(() => undefined);
  }, [row.path]);

  const errorText = !error
    ? null
    : error.alias === 'required'
      ? t('sessions.sidebar.workspace.aliasRequired')
      : error.alias === 'invalid'
        ? t('sessions.sidebar.workspace.aliasInvalid')
        : error.alias === 'duplicate'
          ? t('sessions.sidebar.workspace.aliasDuplicate')
          : error.alias === 'in-use'
            ? t('sessions.sidebar.workspace.aliasInUse', { alias: suggestion ?? row.alias })
            : error.path === 'duplicate'
              ? t('sessions.sidebar.workspace.folderDuplicate')
              : error.path === 'missing'
                ? t('sessions.sidebar.workspace.folderMissing')
                : null;

  return (
    <div className={`grid ${ROW_GRID_COLS} items-start gap-2`}>
      <div className="flex h-8 items-center justify-center">
        <Radio
          checked={isPrimary}
          onChange={onPrimary}
          disabled={disabled}
          tabIndex={tabIndex}
          ariaLabel={t(
            isPrimary ? 'sessions.sidebar.workspace.primaryFor' : 'sessions.sidebar.workspace.secondaryFor',
            { path: row.path },
          )}
        />
      </div>
      <Input
        value={row.alias}
        onChange={(event) => onAlias(event.target.value)}
        disabled={disabled}
        aria-label={t('sessions.sidebar.workspace.aliasFor', { path: row.path })}
        aria-invalid={Boolean(error?.alias)}
        aria-describedby={error ? aliasErrorId : undefined}
        className="h-8 font-mono"
      />
      <div className="flex h-8 min-w-0 items-center">
        <span className={`truncate font-mono typography-micro ${row.missing ? 'text-status-warning' : ''}`} title={row.path || undefined}>
          {row.missing ? t('sessions.sidebar.workspace.missingProject') : row.path}
        </span>
      </div>
      <div className="flex h-8 min-w-0 items-center gap-1 text-muted-foreground">
        <Icon name="git-branch" className="h-3 w-3 shrink-0" />
        <span className="truncate typography-micro" title={branch || undefined}>
          {branch || t('sessions.sidebar.workspace.noGit')}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="size-7 p-0"
        disabled={disabled || isPrimary}
        aria-label={isPrimary
          ? t('sessions.sidebar.workspace.primaryCannotRemove')
          : t('sessions.sidebar.workspace.removeRepo', { path: row.path || row.alias })}
        onClick={onRemove}
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </Button>
      <p
        id={aliasErrorId}
        role={errorText ? 'alert' : undefined}
        className={`col-start-2 col-span-4 min-h-4 truncate typography-micro ${errorText ? 'text-status-error' : 'text-muted-foreground'}`}
        title={errorText ?? undefined}
      >
        {errorText ?? (registered || row.missing ? '' : t('sessions.sidebar.workspace.unregisteredProject'))}
      </p>
    </div>
  );
};

/** A root config file the new `.opencode/` layer will shadow. */
const RootConfigNotice: React.FC<{ path: string }> = ({ path }) => {
  const { t } = useI18n();
  return (
    <>
      <p className="mt-1 typography-micro text-foreground">
        {t('sessions.sidebar.workspace.rootConfigShadowed')}
      </p>
      <p className="break-all font-mono typography-micro text-foreground">{path}</p>
    </>
  );
};

/**
 * The one dialog form. In create mode it owns a new draft; in edit mode it
 * opens on the saved workspace and shows the reference diff and the explicit
 * confirmations a user-edited entry requires.
 */
export const RepoWorkspaceCreateForm: React.FC<RepoWorkspaceCreateFormProps> = ({
  initialDraft,
  editing,
  titleId,
  onClose,
  onCreated,
  onRefsChanged,
  createWorkspace = createRepoWorkspace,
  updateWorkspace = updateRepoWorkspace,
  retryRefs = retryRepoWorkspaceRefs,
  importWorkspace = importRepoWorkspace,
  fetchConfigTarget = fetchRepoWorkspaceConfigTarget,
}) => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const [draft, setDraft] = React.useState<RepoWorkspaceDraft>(() => (
    editing ? draftFromWorkspace(editing.workspace) : (initialDraft ?? emptyRepoWorkspaceDraft())
  ));
  const [submitErrors, setSubmitErrors] = React.useState<SubmitErrors>(emptySubmitErrors);
  const [nameTouched, setNameTouched] = React.useState(false);
  const [submitAttempted, setSubmitAttempted] = React.useState(false);
  const [configError, setConfigError] = React.useState<{ path: string; message: string } | null>(
    editing?.refsError ?? null,
  );
  const [conflictAlias, setConflictAlias] = React.useState<string | null>(null);
  // True means "keep the owned reference" for a repo that leaves the workspace.
  const [keepChoices, setKeepChoices] = React.useState<Record<string, boolean>>({});
  const [confirmations, setConfirmations] = React.useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [pending, setPending] = React.useState<PendingRefs | null>(null);
  const [retryingAlias, setRetryingAlias] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [showContent, setShowContent] = React.useState(false);
  const [importPath, setImportPath] = React.useState('');
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState<'unreadable' | 'invalid' | null>(null);
  const [importSkipped, setImportSkipped] = React.useState<string[]>([]);
  const nextRowKey = React.useRef(draft.rows.length);
  const nameId = React.useId();
  const nameErrorId = React.useId();
  const contentId = React.useId();
  const importErrorId = React.useId();
  const primaryErrorId = React.useId();

  const registeredPaths = React.useMemo(() => new Set(
    projects.map((project) => normalizePath(project.path)).filter((path): path is string => Boolean(path)),
  ), [projects]);
  const projectLabels = React.useMemo(() => new Map(
    projects.map((project) => [normalizePath(project.path) ?? project.path, project.label ?? '']),
  ), [projects]);

  const validation = validateRepoWorkspaceDraft(draft);
  const rowErrors = { ...validation.rows };
  for (const [key, error] of Object.entries(submitErrors.rows)) {
    rowErrors[key] = { ...rowErrors[key], ...error };
  }
  const nameError = validation.nameError || submitErrors.name;
  const primaryError = validation.primaryError || submitErrors.primary;

  const primaryRow = draft.rows.find((row) => row.key === draft.primaryKey) ?? null;
  const tabStopKey = primaryRow?.key ?? draft.rows[0]?.key ?? null;
  const secondaryRows = draft.rows.filter((row) => row.key !== draft.primaryKey && row.alias.trim());
  const primaryPath = primaryRow?.path ? (normalizePath(primaryRow.path) ?? primaryRow.path) : '';
  const [configTarget, setConfigTarget] = React.useState<{
    folderPath: string;
    target: RepoWorkspaceConfigTarget;
  } | null>(null);

  // The server names the exact target, including the canonical folder path the
  // user typed through a symlink. Until it answers, no path is shown at all.
  React.useEffect(() => {
    if (!primaryPath) {
      setConfigTarget(null);
      return undefined;
    }
    let active = true;
    setConfigTarget(null);
    void fetchConfigTarget(primaryPath)
      .then((target) => {
        if (!active) return;
        setConfigTarget({ folderPath: primaryPath, target });
        setConfigError(null);
      })
      .catch((error) => {
        if (!active) return;
        // Only the unreadable-config answer names a file the user must fix.
        // Any other failure leaves the target blank and Save enabled; the
        // server still answers the request if the read was a blip.
        const targetError = error instanceof RepoWorkspaceRequestError ? error.configError : null;
        setConfigError(targetError);
      });
    return () => { active = false; };
  }, [primaryPath, fetchConfigTarget]);
  // The folder guard drops the previous target in the render before the next
  // read starts, so a changed primary never flashes the old path.
  const currentTarget = configTarget?.folderPath === primaryPath ? configTarget.target : null;
  const targetPath = currentTarget?.path ?? '';
  const hasUnregistered = draft.rows.some((row) => (
    !row.projectId && !registeredPaths.has(normalizePath(row.path) ?? row.path)
  ));

  const editingRefs = editing?.refs ?? [];
  const refsByAlias = new Map(editingRefs.map((reference) => [reference.alias, reference]));
  const savedSecondaryRepos = new Map(
    editing
      ? editing.workspace.repos
        .filter((repo) => repo.projectId !== editing.workspace.primaryProjectId)
        .map((repo) => [repo.alias, repo] as const)
      : [],
  );
  const nextSecondaryAliases = React.useMemo(
    () => new Set(secondaryRows.map((row) => row.alias.trim())),
    [secondaryRows],
  );
  const diff = editing
    ? diffRepoWorkspaceRefs({ workspace: editing.workspace, draft, labels: projectLabels })
    : null;
  const oldSecondaryAliases = editing
    ? editing.workspace.repos
      .filter((repo) => repo.projectId !== editing.workspace.primaryProjectId)
      .map((repo) => repo.alias)
    : [];
  const removedOwnedAliases = oldSecondaryAliases.filter((alias) => (
    !nextSecondaryAliases.has(alias) && editing?.workspace.createdRefs.includes(alias)
  ));
  // The removal question belongs to a repo leaving the workspace, not to an
  // alias rename or to the repo that became primary.
  const removedRepoAliases = editing
    ? editing.workspace.repos
      .filter((repo) => (
        repo.projectId !== editing.workspace.primaryProjectId
        && !draft.rows.some((row) => row.projectId === repo.projectId)
      ))
      .map((repo) => repo.alias)
    : [];
  const keepQuestions = removedOwnedAliases.filter((alias) => removedRepoAliases.includes(alias));
  // A `different` entry was edited outside the app: overwriting or removing it
  // needs an explicit check, and the removal question already is one.
  const overwriteDifferent = secondaryRows
    .map((row) => row.alias.trim())
    .filter((alias) => refsByAlias.get(alias)?.status === 'different');
  // An `outside`/`overridden` entry the server skips when this edit writes the
  // same expected value; changing the alias, path or description writes it and
  // needs the same check.
  const changedSecondaryAliases = new Set(secondaryRows.flatMap((row) => {
    const alias = row.alias.trim();
    const saved = savedSecondaryRepos.get(alias);
    if (!saved) return [alias];
    const savedPath = saved.project ? (normalizePath(saved.project.path) ?? saved.project.path) : '';
    const nextPath = normalizePath(row.path) ?? row.path;
    const nextDescription = projectLabels.has(nextPath)
      ? (projectLabels.get(nextPath) ?? '')
      : saved.description;
    return savedPath !== nextPath || saved.description !== nextDescription ? [alias] : [];
  }));
  const overwriteLayered = secondaryRows
    .map((row) => row.alias.trim())
    .filter((alias) => {
      const status = refsByAlias.get(alias)?.status;
      return (status === 'outside' || status === 'overridden') && changedSecondaryAliases.has(alias);
    });
  const overwriteAliases = new Set([...overwriteDifferent, ...overwriteLayered]);
  const removeDifferent = removedOwnedAliases.filter((alias) => (
    refsByAlias.get(alias)?.status === 'different' && !keepQuestions.includes(alias)
  ));
  const neededConfirmations = [...overwriteAliases, ...removeDifferent];
  const pendingConfirmation = neededConfirmations.some((alias) => !confirmations[alias]);

  const showNameError = (nameTouched || submitAttempted) && nameError;

  const canSubmit = !nameError
    && !primaryError
    && Object.keys(rowErrors).length === 0
    && !pendingConfirmation
    && !configError
    && !submitting
    && !importing;

  const updateDraft = (next: (current: RepoWorkspaceDraft) => RepoWorkspaceDraft) => {
    setSubmitErrors(emptySubmitErrors());
    setConflictAlias(null);
    setDraft(next);
  };

  /**
   * Roving focus for the primary column: a radio group moves its selection on
   * the arrow keys, so these rows are one group rather than N Tab stops.
   */
  const handlePrimaryKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    if (key !== 'ArrowDown' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowLeft'
      && key !== 'Home' && key !== 'End') return;
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const current = radios.findIndex((radio) => radio === event.target);
    const enabled = radios.flatMap((radio, index) => (radio.disabled ? [] : [index]));
    if (current < 0 || enabled.length === 0) return;
    event.preventDefault();
    const position = enabled.indexOf(current);
    const next = key === 'Home'
      ? enabled[0]
      : key === 'End'
        ? enabled[enabled.length - 1]
        : key === 'ArrowDown' || key === 'ArrowRight'
          ? enabled[(Math.max(position, -1) + 1) % enabled.length]
          : enabled[(Math.max(position, 0) - 1 + enabled.length) % enabled.length];
    const row = draft.rows[next];
    if (!row) return;
    if (row.key !== draft.primaryKey) {
      updateDraft((currentDraft) => ({ ...currentDraft, primaryKey: row.key }));
    }
    radios[next].focus();
  };

  const addFolder = (pickedPath: string) => {
    setPickerOpen(false);
    const path = normalizePath(pickedPath) ?? pickedPath.trim();
    if (!path) return;
    updateDraft((current) => {
      if (current.rows.some((row) => (normalizePath(row.path) ?? row.path) === path)) return current;
      const row: RepoWorkspaceDraftRow = {
        key: `repo-${nextRowKey.current++}`,
        path,
        alias: aliasForFolder(path, current.rows.map((entry) => entry.alias)),
      };
      return {
        ...current,
        rows: [...current.rows, row],
        primaryKey: current.primaryKey ?? row.key,
      };
    });
  };

  /**
   * Import replaces the draft with the file's folders; the first accepted one
   * is proposed as primary. A rejected folder is listed and the others still
   * land. Nothing is written: this only fills the form.
   */
  const runImport = async () => {
    const filePath = importPath.trim();
    if (!filePath || importing || submitting) return;
    setImporting(true);
    setImportError(null);
    setImportSkipped([]);
    try {
      const result = await importWorkspace(filePath);
      const accepted = result.folders.filter((folder) => folder.error === null);
      setImportSkipped(result.folders.filter((folder) => folder.error !== null).map((folder) => folder.path));
      if (accepted.length === 0) return;
      const rows: RepoWorkspaceDraftRow[] = accepted.map((folder) => ({
        key: `repo-${nextRowKey.current++}`,
        path: folder.path,
        alias: folder.alias,
      }));
      const primaryIndex = accepted.findIndex((folder) => folder.primary);
      updateDraft(() => ({
        name: result.name,
        rows,
        primaryKey: rows[primaryIndex >= 0 ? primaryIndex : 0].key,
      }));
    } catch (error) {
      setImportError(
        error instanceof RepoWorkspaceRequestError && error.importError?.reason === 'invalid-json'
          ? 'invalid'
          : 'unreadable',
      );
    } finally {
      setImporting(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitErrors(emptySubmitErrors());
    setConfigError(null);
    setConflictAlias(null);

    const git = getRegisteredRuntimeAPIs()?.git;
    if (git) {
      await Promise.all(draft.rows.filter((row) => row.path).map(async (row) => {
        try {
          await useGitStore.getState().ensureStatus(row.path, git);
        } catch {
          // A folder without git still belongs in the workspace; the branch stays empty.
        }
      }));
    }
    const branchFor = (path: string) => useGitStore.getState().directories.get(path)?.status?.current ?? '';

    try {
      const result = editing
        ? await updateWorkspace(editing.workspace.id, updatePayloadFromDraft(draft, branchFor, {
          confirmRefs: [
            ...keepQuestions.filter((alias) => !keepChoices[alias]),
            ...neededConfirmations.filter((alias) => confirmations[alias]),
          ],
          keepRefs: keepQuestions.filter((alias) => keepChoices[alias]),
        }))
        : await createWorkspace(createPayloadFromDraft(draft, branchFor));
      onCreated();
      const failedAliases = result.refWrites
        .filter((write) => write.status === 'failed')
        .map((write) => write.alias);
      if (failedAliases.length === 0) {
        onClose();
        return;
      }
      setPending({
        workspaceId: result.workspace.id,
        configTarget: result.configTarget,
        aliases: failedAliases,
        configError: result.refsError,
        retryFailed: null,
      });
    } catch (error) {
      if (error instanceof RepoWorkspaceRequestError) {
        if (error.configError) {
          setConfigError(error.configError);
        } else if (error.status === 409) {
          if (editing) {
            setConflictAlias(error.conflict?.alias ?? error.conflict?.aliases[0] ?? null);
            if (!error.conflict?.alias && (error.conflict?.aliases.length ?? 0) === 0) {
              setSubmitErrors({ ...emptySubmitErrors(), form: true });
            }
          } else {
            const row = draft.rows.find((entry) => entry.alias.trim() === error.conflict?.alias);
            if (row) {
              setSubmitErrors({ ...emptySubmitErrors(), rows: { [row.key]: { alias: 'in-use' } } });
            } else {
              setSubmitErrors({ ...emptySubmitErrors(), form: true });
            }
          }
        } else if (Object.keys(error.fields).length > 0) {
          const next = emptySubmitErrors();
          for (const field of Object.keys(error.fields)) {
            if (field === 'name') next.name = true;
            else if (field === 'primary') next.primary = true;
            else {
              const index = rowIndexFromField(field);
              const row = index === null ? null : draft.rows[index];
              if (!row) continue;
              if (field.endsWith('.alias')) next.rows[row.key] = { ...next.rows[row.key], alias: 'invalid' };
              else next.rows[row.key] = { ...next.rows[row.key], path: 'missing' };
            }
          }
          setSubmitErrors(next);
        } else {
          setSubmitErrors({ ...emptySubmitErrors(), form: true });
        }
      } else {
        setSubmitErrors({ ...emptySubmitErrors(), form: true });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async (alias: string) => {
    if (!pending || retryingAlias) return;
    const current = pending;
    setRetryingAlias(alias);
    setPending({ ...current, retryFailed: null });
    try {
      // The user picked this alias in the pending card: that is the
      // confirmation a user-edited entry needs to be written again.
      const result = await retryRefs(current.workspaceId, [alias], [alias]);
      onRefsChanged();
      const failed = result.refWrites.some((write) => write.alias === alias && write.status === 'failed');
      const remaining = failed ? current.aliases : current.aliases.filter((entry) => entry !== alias);
      if (remaining.length === 0) {
        onClose();
        return;
      }
      setPending({
        ...current,
        configTarget: result.configTarget,
        aliases: remaining,
        configError: result.refsError,
        retryFailed: failed ? alias : null,
      });
    } catch (error) {
      const nextConfigError = error instanceof RepoWorkspaceRequestError ? error.configError : null;
      setPending({ ...current, configError: nextConfigError ?? current.configError, retryFailed: alias });
    } finally {
      setRetryingAlias(null);
    }
  };

  if (pending) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <h2 id={titleId} className="typography-ui-header font-semibold leading-none text-foreground">
            {t(editing ? 'sessions.sidebar.workspace.pendingTitleEdit' : 'sessions.sidebar.workspace.pendingTitle')}
          </h2>
        </div>
        <p className="break-all font-mono typography-micro text-muted-foreground">{pending.configTarget.path}</p>
        <p className="typography-meta text-muted-foreground">{t('sessions.sidebar.workspace.pendingBody')}</p>
        {pending.configError ? (
          <div className="rounded-lg bg-[var(--status-error)]/10 p-3" role="alert">
            <p className="break-all font-mono typography-micro">{pending.configError.path}</p>
            <p className="mt-1 typography-meta text-foreground">{t('sessions.sidebar.workspace.configUnreadable')}</p>
          </div>
        ) : null}
        <ul className="flex flex-col gap-2">
          {pending.aliases.map((alias) => (
            <li key={alias} className="flex items-center gap-2">
              <code className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono typography-micro">{`@${alias}`}</code>
              <Button
                variant="default"
                size="sm"
                className="ms-auto"
                disabled={retryingAlias !== null}
                aria-label={t('sessions.sidebar.workspace.retryAlias', { alias })}
                onClick={() => void retry(alias)}
              >
                {t('sessions.sidebar.workspace.retry')}
              </Button>
            </li>
          ))}
        </ul>
        {pending.retryFailed ? (
          <p className="typography-meta text-status-error" role="alert">
            {t('sessions.sidebar.workspace.pendingRetryFailed')}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <h2 id={titleId} className="typography-ui-header font-semibold leading-none text-foreground">
        {editing
          ? t('sessions.sidebar.workspace.editTitle', { name: editing.workspace.name })
          : t('sessions.sidebar.workspace.new')}
      </h2>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="typography-ui-label font-medium text-foreground">
          {t('sessions.sidebar.workspace.nameLabel')}
        </label>
        <Input
          id={nameId}
          value={draft.name}
          onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
          onBlur={() => setNameTouched(true)}
          disabled={submitting}
          aria-invalid={showNameError}
          aria-describedby={showNameError ? nameErrorId : undefined}
        />
        {showNameError ? (
          <p id={nameErrorId} role="alert" className="typography-micro text-status-error">
            {t('sessions.sidebar.workspace.nameRequired')}
          </p>
        ) : null}
      </div>

      {!editing ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              value={importPath}
              onChange={(event) => setImportPath(event.target.value)}
              disabled={submitting || importing}
              placeholder={t('sessions.sidebar.workspace.importPathPlaceholder')}
              aria-label={t('sessions.sidebar.workspace.importPathLabel')}
              aria-invalid={importError !== null}
              aria-describedby={importError ? importErrorId : undefined}
              className="min-w-0 flex-1 font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              variant="outline"
              onClick={() => void runImport()}
              disabled={submitting || importing || importPath.trim().length === 0}
            >
              {t('sessions.sidebar.workspace.importAction')}
            </Button>
          </div>
          <p
            id={importErrorId}
            role={importError ? 'alert' : undefined}
            className={`min-h-4 typography-micro ${importError ? 'text-status-error' : 'text-muted-foreground'}`}
          >
            {importError
              ? t(importError === 'invalid'
                ? 'sessions.sidebar.workspace.importInvalid'
                : 'sessions.sidebar.workspace.importUnreadable')
              : ''}
          </p>
          {importSkipped.length > 0 ? (
            <div role="alert" className="flex flex-col gap-0.5">
              {importSkipped.map((path) => (
                <p key={path} className="break-all typography-micro text-status-warning">
                  {t('sessions.sidebar.workspace.importUnsupported', { path })}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <fieldset className="min-w-0" aria-describedby={primaryError ? primaryErrorId : undefined}>
        <legend className="sr-only">{t('sessions.sidebar.workspace.primary')}</legend>
        <div className={`grid ${ROW_GRID_COLS} items-center gap-2 pb-1 text-[0.6875rem] uppercase tracking-wide text-muted-foreground`}>
          <span>{t('sessions.sidebar.workspace.primaryColumn')}</span>
          <span>{t('sessions.sidebar.workspace.aliasColumn')}</span>
          <span>{t('sessions.sidebar.workspace.folderColumn')}</span>
          <span>{t('sessions.sidebar.workspace.branchColumn')}</span>
        </div>
        <div
          className="flex flex-col gap-2"
          onKeyDown={handlePrimaryKeyDown}
        >
          {draft.rows.map((row) => (
            <RepoRow
              key={row.key}
              row={row}
              isPrimary={row.key === draft.primaryKey}
              registered={registeredPaths.has(normalizePath(row.path) ?? row.path)}
              error={rowErrors[row.key]}
              suggestion={rowErrors[row.key]?.alias === 'in-use'
                ? suggestedAlias(row.alias.trim(), draft.rows.filter((entry) => entry.key !== row.key).map((entry) => entry.alias.trim()))
                : null}
              disabled={submitting}
              tabIndex={row.key === tabStopKey ? 0 : -1}
              onPrimary={() => updateDraft((current) => ({ ...current, primaryKey: row.key }))}
              onAlias={(alias) => updateDraft((current) => ({
                ...current,
                rows: current.rows.map((entry) => entry.key === row.key ? { ...entry, alias } : entry),
              }))}
              onRemove={() => updateDraft((current) => {
                const rows = current.rows.filter((entry) => entry.key !== row.key);
                return {
                  ...current,
                  rows,
                  primaryKey: current.primaryKey === row.key ? rows[0]?.key ?? null : current.primaryKey,
                };
              })}
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1"
          disabled={submitting}
          onClick={() => setPickerOpen(true)}
        >
          <Icon name="folder-add" className="h-3.5 w-3.5" />
          {t('sessions.sidebar.workspace.addFolder')}
        </Button>
        {primaryError ? (
          <p id={primaryErrorId} role={draft.rows.length === 0 ? undefined : 'alert'} className={`typography-micro ${draft.rows.length === 0 ? 'text-muted-foreground' : 'text-status-error'}`}>
            {draft.rows.length === 0
              ? t('sessions.sidebar.workspace.noRepos')
              : t('sessions.sidebar.workspace.primaryRequired')}
          </p>
        ) : null}
      </fieldset>

      {draft.rows.length > 0 && primaryRow ? (
        editing ? (
          <div className="rounded-lg bg-[var(--status-warning)]/10 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <Icon name="error-warning" className="size-3.5 shrink-0 text-status-warning" />
              <p className="min-w-0 flex-1 typography-ui-label font-medium">
                {t('sessions.sidebar.workspace.diffTitle')}
              </p>
            </div>
            <p className="mt-1 min-h-4 break-all font-mono typography-micro text-foreground">{targetPath}</p>
            {currentTarget?.rootConfigPath ? <RootConfigNotice path={currentTarget.rootConfigPath} /> : null}
            <ul className="mt-1 flex flex-col gap-0.5 font-mono typography-micro text-foreground">
              {diff?.removed.map((alias) => (
                <li key={`removed-${alias}`}>{`- ${t('sessions.sidebar.workspace.diffRemoved', { alias })}`}</li>
              ))}
              {diff?.changed.map((alias) => (
                <li key={`changed-${alias}`}>{`~ ${t('sessions.sidebar.workspace.diffChanged', { alias })}`}</li>
              ))}
              {diff?.added.map((alias) => (
                <li key={`added-${alias}`}>{`+ ${t('sessions.sidebar.workspace.diffAdded', { alias })}`}</li>
              ))}
            </ul>
            {hasUnregistered ? (
              <p className="mt-1 typography-micro text-foreground">
                {t('sessions.sidebar.workspace.noticeUnregistered')}
              </p>
            ) : null}
            {keepQuestions.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {keepQuestions.map((alias) => {
                  const label = t('sessions.sidebar.workspace.removeRefQuestion', { alias });
                  return (
                    <label key={`keep-${alias}`} className="flex items-center gap-2 typography-micro">
                      <Checkbox
                        checked={!keepChoices[alias]}
                        onChange={(checked) => setKeepChoices((current) => ({ ...current, [alias]: !checked }))}
                        ariaLabel={label}
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
            {neededConfirmations.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {neededConfirmations.map((alias) => {
                  const label = overwriteAliases.has(alias)
                    ? t('sessions.sidebar.workspace.confirmOverwrite', { alias })
                    : t('sessions.sidebar.workspace.confirmRemove', { alias });
                  return (
                    <label key={`confirm-${alias}`} className="flex items-center gap-2 typography-micro">
                      <Checkbox
                        checked={Boolean(confirmations[alias])}
                        onChange={(checked) => setConfirmations((current) => ({ ...current, [alias]: checked }))}
                        ariaLabel={label}
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : secondaryRows.length === 0 ? (
          <div className="rounded-lg bg-[var(--status-info)]/10 p-3">
            <p className="typography-meta text-foreground">
              {t('sessions.sidebar.workspace.oneRepoNotice')}
            </p>
            {hasUnregistered ? (
              <p className="mt-1 typography-micro text-foreground">
                {t('sessions.sidebar.workspace.noticeUnregistered')}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg bg-[var(--status-warning)]/10 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <Icon name="error-warning" className="size-3.5 shrink-0 text-status-warning" />
              <p className="min-w-0 flex-1 typography-ui-label font-medium">
                {secondaryRows.length === 1
                  ? t('sessions.sidebar.workspace.noticeSingle', { count: secondaryRows.length })
                  : t('sessions.sidebar.workspace.noticePlural', { count: secondaryRows.length })}
              </p>
              <Button
                variant="link"
                size="sm"
                className="h-auto shrink-0 p-0"
                aria-expanded={showContent}
                aria-controls={showContent ? contentId : undefined}
                onClick={() => setShowContent((current) => !current)}
              >
                {t('sessions.sidebar.workspace.showContent')}
              </Button>
            </div>
            <p className="mt-1 min-h-4 break-all font-mono typography-micro text-foreground">{targetPath}</p>
            {currentTarget?.rootConfigPath ? <RootConfigNotice path={currentTarget.rootConfigPath} /> : null}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {secondaryRows.map((row) => (
                <code key={row.key} className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono typography-micro">
                  {`@${row.alias.trim()}`}
                </code>
              ))}
            </div>
            {hasUnregistered ? (
              <p className="mt-1 typography-micro text-foreground">
                {t('sessions.sidebar.workspace.noticeUnregistered')}
              </p>
            ) : null}
            {showContent ? (
              <pre id={contentId} className="mt-2 max-h-40 overflow-auto rounded bg-[var(--surface-elevated)] p-2 font-mono typography-micro text-foreground">
                {JSON.stringify({
                  references: Object.fromEntries(secondaryRows.map((row) => {
                    const path = normalizePath(row.path) ?? row.path;
                    return [row.alias.trim(), {
                      path,
                      description: projectLabels.get(path) ?? '',
                    }];
                  })),
                }, null, 2)}
              </pre>
            ) : null}
          </div>
        )
      ) : null}

      {configError ? (
        <div className="rounded-lg bg-[var(--status-error)]/10 p-3" role="alert">
          <p className="break-all font-mono typography-micro">{configError.path}</p>
          <p className="mt-1 typography-meta text-foreground">
            {t('sessions.sidebar.workspace.configUnreadable')}
          </p>
        </div>
      ) : null}
      {submitErrors.form ? (
        <p role="alert" className="typography-micro text-status-error">
          {t(editing ? 'sessions.sidebar.workspace.editFailed' : 'sessions.sidebar.workspace.createFailed')}
        </p>
      ) : null}
      {conflictAlias ? (
        <p role="alert" className="typography-micro text-status-error">
          {t('sessions.sidebar.workspace.editConflict', { alias: conflictAlias })}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          {t('dialog.common.actions.cancel')}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {t(editing ? 'sessions.sidebar.workspace.saveAction' : 'sessions.sidebar.workspace.createAction')}
        </Button>
      </div>

      {pickerOpen ? (
        <DirectoryExplorerDialog
          open
          onOpenChange={setPickerOpen}
          onPickDirectory={addFolder}
        />
      ) : null}
    </form>
  );
};
