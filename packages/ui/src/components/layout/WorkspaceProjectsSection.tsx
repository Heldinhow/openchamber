import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import {
  projectWorkspaceGitReadout,
  projectWorkspaceRows,
  useWorkspaceProjectFailures,
  type WorkspaceProjectGitReadout,
  type WorkspaceProjectRow,
} from '@/lib/repoWorkspaces/workspaceProjects';
import { useGitStatus, useIsGitRepo } from '@/stores/useGitStore';

type RowProps = {
  row: WorkspaceProjectRow;
  failed: boolean;
  onOpenGit: (path: string) => void;
};

const GitLine: React.FC<{
  readout: WorkspaceProjectGitReadout;
  project: string;
  path: string | null;
  onOpenGit: (path: string) => void;
}> = ({ readout, project, path, onOpenGit }) => {
  const { t } = useI18n();

  if (readout.state === 'ready') {
    const branch = readout.branch ?? t('contextPanel.workspaceProjects.noBranch');
    const hasStats = readout.additions !== null && readout.deletions !== null
      && (readout.additions > 0 || readout.deletions > 0);
    return (
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground">
        <button
          type="button"
          onClick={path ? () => onOpenGit(path) : undefined}
          aria-label={t('contextPanel.workspaceProjects.openGit', { project })}
          title={t('contextPanel.workspaceProjects.openGit', { project })}
          className="inline-flex min-w-0 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="git-branch" className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{branch}</span>
        </button>
        <span aria-hidden="true">·</span>
        {readout.changes === 0 ? (
          <span className="shrink-0">{t('contextPanel.workspaceProjects.noChanges')}</span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1">
            <Icon name="file-edit" className="h-3.5 w-3.5 shrink-0" />
            <span>
              {readout.changes === 1
                ? t('chat.workStatus.git.changedFileSingle', { count: readout.changes })
                : t('chat.workStatus.git.changedFilePlural', { count: readout.changes })}
            </span>
          </span>
        )}
        {hasStats ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 tabular-nums">
            <span className="text-[var(--status-success)]">{`+${readout.additions}`}</span>
            <span aria-hidden="true">/</span>
            <span className="text-[var(--status-error)]">{`−${readout.deletions}`}</span>
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-0.5 typography-micro text-muted-foreground">
      {readout.state === 'no-git'
        ? t('contextPanel.workspaceProjects.noGit')
        : readout.state === 'failed'
          ? t('contextPanel.workspaceProjects.unreadable')
          : t('contextPanel.workspaceProjects.reading')}
    </div>
  );
};

const ProjectRow: React.FC<RowProps> = ({ row, failed, onOpenGit }) => {
  const { t } = useI18n();
  const status = useGitStatus(row.path);
  const isGitRepo = useIsGitRepo(row.path);
  const readout = projectWorkspaceGitReadout({ isGitRepo, status }, failed);

  return (
    <div className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2">
      <div dir="auto" className="truncate typography-ui-label text-foreground" title={row.label ?? undefined}>
        {row.missing ? t('contextPanel.workspaceProjects.missing') : row.label}
      </div>
      {row.missing ? null : (
        <GitLine readout={readout} project={row.label ?? row.projectId} path={row.path} onOpenGit={onOpenGit} />
      )}
    </div>
  );
};

type SectionProps = {
  rows: readonly WorkspaceProjectRow[];
  failedPaths: ReadonlySet<string>;
  onOpenGit: (path: string) => void;
};

/** One row per member project, in workspace order. It carries no project actions. */
export const WorkspaceProjectsSection: React.FC<SectionProps> = ({ rows, failedPaths, onOpenGit }) => {
  const { t } = useI18n();
  if (rows.length === 0) return null;

  return (
    <section aria-label={t('contextPanel.workspaceProjects.title')} className="mb-6">
      <div className="mb-2 typography-micro text-muted-foreground">
        {t('contextPanel.workspaceProjects.title')}
      </div>
      <div className="space-y-1">
        {rows.map((row) => (
          <ProjectRow
            key={row.projectId}
            row={row}
            failed={Boolean(row.path && failedPaths.has(row.path))}
            onOpenGit={onOpenGit}
          />
        ))}
      </div>
    </section>
  );
};

type PanelProps = {
  workspace: RepoWorkspaceResolved;
  sessionDirectory: string | null;
  onOpenGit: (path: string) => void;
};

/** The workspace session's project list, read live from the shared git store. */
export const WorkspaceProjectsPanel: React.FC<PanelProps> = ({ workspace, sessionDirectory, onOpenGit }) => {
  const rows = React.useMemo(() => projectWorkspaceRows(workspace), [workspace]);
  const projectPaths = React.useMemo(
    () => rows.flatMap((row) => (row.path ? [row.path] : [])),
    [rows],
  );
  const failedPaths = useWorkspaceProjectFailures(projectPaths, sessionDirectory, true);

  return <WorkspaceProjectsSection rows={rows} failedPaths={failedPaths} onOpenGit={onOpenGit} />;
};
