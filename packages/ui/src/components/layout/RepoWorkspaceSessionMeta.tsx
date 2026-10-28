import React from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { RepoWorkspaceRef } from '@/lib/repoWorkspaces/client';

const CHIP_CLASS = 'inline-flex shrink-0 items-center rounded-full border border-border/60 px-2 py-0.5 font-mono text-[0.6875rem] leading-4 text-muted-foreground';
const STATE_CLASS = 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[0.6875rem] leading-4';

const stateLabelKey = (status: RepoWorkspaceRef['status']): I18nKey => {
  switch (status) {
    case 'missing': return 'header.repoWorkspace.refMissing';
    case 'different': return 'header.repoWorkspace.refDifferent';
    case 'outside': return 'header.repoWorkspace.refOutside';
    case 'overridden': return 'header.repoWorkspace.refOverridden';
    default: return 'header.repoWorkspace.refUnknown';
  }
};

type RepoWorkspaceSessionMetaProps = {
  workspaceName: string;
  refs: readonly RepoWorkspaceRef[];
  refsError: { path: string; message: string } | null;
  retryingAliases: ReadonlySet<string>;
  onRetry: (alias: string) => void;
};

/**
 * The workspace context of a session in the active workspace's primary repo:
 * its name, the fact that the session is in the primary, and one entry per
 * reference. Only `ok` references are chips; every other status stays a text
 * state, and only an owned missing reference offers the retry.
 */
export const RepoWorkspaceSessionMeta: React.FC<RepoWorkspaceSessionMetaProps> = ({
  workspaceName,
  refs,
  refsError,
  retryingAliases,
  onRetry,
}) => {
  const { t } = useI18n();

  return (
    <div className="app-region-no-drag flex min-w-0 max-w-full items-center gap-2 overflow-hidden ps-2 text-start">
      <div className="flex min-w-0 flex-col justify-center">
        <span className="truncate typography-meta leading-tight text-muted-foreground" title={workspaceName}>
          {workspaceName}
        </span>
        <span className="truncate typography-micro leading-tight text-muted-foreground">
          {t('header.repoWorkspace.subtitle')}
        </span>
      </div>
      {refs.length > 0 ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden" role="group" aria-label={t('header.repoWorkspace.refsAria')}>
          {refs.map((ref) => {
            if (ref.status === 'ok') {
              return (
                <span key={ref.alias} className={CHIP_CLASS} title={ref.path ?? `@${ref.alias}`}>
                  @{ref.alias}
                  {ref.path ? <span className="sr-only"> {ref.path}</span> : null}
                </span>
              );
            }

            const label = t(stateLabelKey(ref.status));
            const path = ref.current?.path ?? ref.path;
            const title = ref.status === 'unknown' && refsError
              ? `${refsError.path}: ${refsError.message}`
              : [label, path].filter(Boolean).join(' · ');
            const retryable = ref.status === 'missing' && ref.owned;
            return (
              <span
                key={ref.alias}
                className={`${STATE_CLASS} ${ref.status === 'missing' || ref.status === 'unknown' ? 'text-status-warning' : 'text-muted-foreground'}`}
                title={title}
              >
                <span className="font-mono">@{ref.alias}</span>
                <span>{label}</span>
                {path ? <span className="sr-only"> {path}</span> : null}
                {retryable ? (
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    aria-label={t('sessions.sidebar.workspace.retryAlias', { alias: ref.alias })}
                    disabled={retryingAliases.has(ref.alias)}
                    onClick={() => onRetry(ref.alias)}
                  >
                    {t('sessions.sidebar.workspace.retry')}
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
