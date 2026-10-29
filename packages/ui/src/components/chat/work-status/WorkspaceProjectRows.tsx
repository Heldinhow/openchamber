import React from 'react';

import { useI18n } from '@/lib/i18n';
import type { RepoWorkspaceResolved } from '@/lib/repoWorkspaces/client';
import {
  projectWorkspaceGitReadout,
  projectWorkspaceRows,
  useWorkspaceProjectFailures,
  type WorkspaceProjectRow,
} from '@/lib/repoWorkspaces/workspaceProjects';
import { useGitStatus, useIsGitRepo } from '@/stores/useGitStore';
import { WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';

type ProjectProps = {
  row: WorkspaceProjectRow;
  failed: boolean;
  /** One line per project: the name and its diffstat, without branch and changes. */
  compact: boolean;
  onOpenGit: (path: string) => void;
};

const Diffstat: React.FC<{ additions: number | null; deletions: number | null }> = ({ additions, deletions }) => (
  additions !== null && deletions !== null && (additions > 0 || deletions > 0) ? (
    <>
      <WorkStatusValue tone="success">{`+${additions}`}</WorkStatusValue>
      <WorkStatusValue tone="muted">/</WorkStatusValue>
      <WorkStatusValue tone="error">{`−${deletions}`}</WorkStatusValue>
    </>
  ) : null
);

/** One member project, read like the single-project card: name, branch, changes. */
const WorkspaceProjectRows: React.FC<ProjectProps> = ({ row, failed, compact, onOpenGit }) => {
  const { t } = useI18n();
  const status = useGitStatus(row.path);
  const isGitRepo = useIsGitRepo(row.path);
  const readout = projectWorkspaceGitReadout({ isGitRepo, status }, failed);
  const name = row.missing ? t('contextPanel.workspaceProjects.missing') : row.label;
  const { path } = row;
  const openGit = path ? () => onOpenGit(path) : undefined;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  return (
    <div className="mt-1.5 first:mt-0">
      <WorkStatusRow
        icon="folder"
        label={<span dir="auto" title={name ?? undefined}>{name}</span>}
        value={compact && readout.state === 'ready' ? <Diffstat additions={readout.additions} deletions={readout.deletions} /> : undefined}
      />
      {compact ? null : readout.state === 'ready' ? (
        <>
          <WorkStatusRow
            icon="git-branch"
            onClick={openGit}
            ariaLabel={t('contextPanel.workspaceProjects.openGit', { project: name ?? row.projectId })}
            label={readout.branch ?? t('contextPanel.workspaceProjects.noBranch')}
            value={ahead > 0 || behind > 0 ? (
              <>
                {ahead > 0 ? <WorkStatusValue tone="muted">{`↑${ahead}`}</WorkStatusValue> : null}
                {behind > 0 ? <WorkStatusValue tone="muted">{`↓${behind}`}</WorkStatusValue> : null}
              </>
            ) : undefined}
          />
          {readout.changes > 0 ? (
            <WorkStatusRow
              icon="file-edit"
              label={readout.changes === 1
                ? t('chat.workStatus.git.changedFileSingle', { count: readout.changes })
                : t('chat.workStatus.git.changedFilePlural', { count: readout.changes })}
              value={<Diffstat additions={readout.additions} deletions={readout.deletions} />}
            />
          ) : null}
        </>
      ) : row.missing ? null : (
        <WorkStatusRow
          muted
          icon="git-branch"
          label={readout.state === 'no-git'
            ? t('contextPanel.workspaceProjects.noGit')
            : readout.state === 'failed'
              ? t('contextPanel.workspaceProjects.unreadable')
              : t('contextPanel.workspaceProjects.reading')}
        />
      )}
    </div>
  );
};

type Props = {
  workspace: RepoWorkspaceResolved;
  sessionDirectory: string | null;
  expanded: boolean;
  onOpenGit: (path: string) => void;
};

/** The workspace session's member projects, read live from the shared git store. */
export const WorkspaceProjectList: React.FC<Props> = ({ workspace, sessionDirectory, expanded, onOpenGit }) => {
  const rows = React.useMemo(() => projectWorkspaceRows(workspace), [workspace]);
  const paths = React.useMemo(() => rows.flatMap((row) => (row.path ? [row.path] : [])), [rows]);
  const failedPaths = useWorkspaceProjectFailures(paths, sessionDirectory, true);

  return (
    <>
      {rows.map((row) => (
        <WorkspaceProjectRows
          key={row.projectId}
          row={row}
          failed={Boolean(row.path && failedPaths.has(row.path))}
          compact={!expanded}
          onOpenGit={onOpenGit}
        />
      ))}
    </>
  );
};
