import React from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { RepoWorkspaceRef } from '@/lib/repoWorkspaces/client';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { visibleReferenceCount } from './repoWorkspaceSessionMetaLayout';

const CHIP_CLASS = 'inline-flex shrink-0 items-center rounded-full border border-border/60 px-2 py-0.5 font-mono text-[0.6875rem] leading-4 text-muted-foreground';
const OVERFLOW_CLASS = `${CHIP_CLASS} min-h-7 cursor-pointer hover:bg-[var(--surface-muted)] hover:text-foreground focus-visible:bg-[var(--surface-muted)] focus-visible:text-foreground focus-visible:outline-none`;
const STATE_CLASS = 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[0.6875rem] leading-4';
const REFERENCE_GAP = 6;

const stateLabelKey = (status: RepoWorkspaceRef['status']): I18nKey => {
  switch (status) {
    case 'missing': return 'header.repoWorkspace.refMissing';
    case 'different': return 'header.repoWorkspace.refDifferent';
    case 'outside': return 'header.repoWorkspace.refOutside';
    case 'overridden': return 'header.repoWorkspace.refOverridden';
    default: return 'header.repoWorkspace.refUnknown';
  }
};

const stateClass = (status: RepoWorkspaceRef['status']): string =>
  status === 'missing' || status === 'unknown' ? 'text-status-warning' : 'text-muted-foreground';

const refPath = (ref: RepoWorkspaceRef): string | null =>
  ref.status === 'ok' ? ref.path : (ref.current?.path ?? ref.path);

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
 * state, and only an owned missing reference offers the retry. The entries
 * that fit stay visible and the rest move behind a `+N` control that lists
 * them, so a hidden state is never silent.
 */
export const RepoWorkspaceSessionMeta: React.FC<RepoWorkspaceSessionMetaProps> = ({
  workspaceName,
  refs,
  refsError,
  retryingAliases,
  onRetry,
}) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = React.useState(refs.length);
  const retryRef = refs.find((ref) => ref.status === 'missing' && ref.owned) ?? null;

  const visible = Math.min(visibleCount, refs.length);
  const hiddenRefs = refs.slice(visible);

  const renderRef = (ref: RepoWorkspaceRef): React.ReactElement => {
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
    return (
      <span key={ref.alias} className={`${STATE_CLASS} ${stateClass(ref.status)}`} title={title}>
        <span className="font-mono">@{ref.alias}</span>
        <span>{label}</span>
        {path ? <span className="sr-only"> {path}</span> : null}
      </span>
    );
  };

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure || !globalThis.ResizeObserver) {
      return;
    }

    const measureRow = () => {
      const gap = Number.parseFloat(getComputedStyle(measure).columnGap) || REFERENCE_GAP;
      const widths = Array.from(measure.children)
        .slice(0, refs.length)
        .map((entry) => entry.getBoundingClientRect().width);
      const overflowWidth = measure.lastElementChild?.getBoundingClientRect().width ?? 0;
      setVisibleCount(visibleReferenceCount(widths, container.clientWidth, gap, overflowWidth));
    };

    measureRow();
    const observer = new ResizeObserver(measureRow);
    observer.observe(container);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [refs]);

  return (
    // `flex-1` gives the chips a width fixed by the header, not by how many
    // entries are currently rendered; without it the count collapses to just
    // the `+N` control and every entry stays hidden.
    <div className={`app-region-no-drag flex min-w-0 max-w-full items-center gap-2 overflow-hidden ps-2 text-start ${refs.length > 0 ? 'flex-1' : ''}`}>
      <div className="flex min-w-0 flex-col justify-center">
        <span className="truncate typography-meta leading-tight text-muted-foreground" title={workspaceName}>
          {workspaceName}
        </span>
        <span className="truncate typography-micro leading-tight text-muted-foreground">
          {t('header.repoWorkspace.subtitle')}
        </span>
      </div>
      {refs.length > 0 ? (
        // `min-w-8` holds a slot just over the `+N` control's measured width, so
        // a narrow header truncates the name instead of hiding the count.
        <div ref={containerRef} className="relative flex min-w-8 flex-1 items-center overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden" role="group" aria-label={t('header.repoWorkspace.refsAria')}>
            {refs.slice(0, visible).map(renderRef)}
            {hiddenRefs.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={OVERFLOW_CLASS}
                    aria-label={t('header.repoWorkspace.hiddenRefsAria', {
                      count: hiddenRefs.length,
                      aliases: hiddenRefs.map((ref) => `@${ref.alias}`).join(', '),
                    })}
                  >
                    {t('header.repoWorkspace.moreRefs', { count: hiddenRefs.length })}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-[20rem]">
                  <span className="flex flex-col gap-1.5">
                    {hiddenRefs.map((ref) => {
                      const path = refPath(ref);
                      return (
                        <span key={ref.alias} className="flex flex-wrap items-center gap-x-1.5">
                          <span className="font-mono">@{ref.alias}</span>
                          {path ? <span className="break-all text-muted-foreground">{path}</span> : null}
                          {ref.status === 'ok' ? null : (
                            <span className={stateClass(ref.status)}>{t(stateLabelKey(ref.status))}</span>
                          )}
                        </span>
                      );
                    })}
                  </span>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <div
            ref={measureRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute start-0 top-0 flex items-center gap-1.5"
          >
            {refs.map(renderRef)}
            <span className={CHIP_CLASS}>{t('header.repoWorkspace.moreRefs', { count: refs.length })}</span>
          </div>
        </div>
      ) : null}
      {retryRef ? (
        <button
          type="button"
          className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          aria-label={t('sessions.sidebar.workspace.retryAlias', { alias: retryRef.alias })}
          disabled={retryingAliases.has(retryRef.alias)}
          onClick={() => onRetry(retryRef.alias)}
        >
          {t('sessions.sidebar.workspace.retry')}
        </button>
      ) : null}
    </div>
  );
};
