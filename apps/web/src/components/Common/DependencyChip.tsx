import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, AlertCircle, ArrowUpRight, ArrowDownLeft, Link2 } from 'lucide-react';
import type { WorkItemRelations } from '../../types';

interface DependencySummaryProps {
  relations: WorkItemRelations;
  isBlocked?: boolean;
  isBlocking?: boolean;
  compact?: boolean;
}

export const DependencySummary: React.FC<DependencySummaryProps> = ({
  relations,
  isBlocked,
  isBlocking,
  compact = false
}) => {
  const { t } = useTranslation();
  const predCount = relations.predecessors?.length || 0;
  const succCount = relations.successors?.length || 0;
  const relCount = relations.related?.length || 0;

  if (predCount === 0 && succCount === 0 && relCount === 0) {
    return <span className="text-xs text-slate-400 dark:text-slate-600 font-mono">—</span>;
  }

  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap">
      {/* Blocked indicator */}
      {isBlocked && (
        <span
          title={t('chip.blockedTitle')}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-200 dark:border-rose-900/50"
        >
          <AlertCircle className="w-3 h-3 text-rose-500 animate-pulse" />
          <span>{t('chip.blocked')}</span>
        </span>
      )}

      {/* Blocking indicator */}
      {isBlocking && (
        <span
          title={t('chip.blockingTitle')}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-200 dark:border-amber-900/50"
        >
          <ArrowLeftRight className="w-3 h-3 text-amber-500" />
          <span>{t('chip.blocking')}</span>
        </span>
      )}

      {/* Predecessors count */}
      {predCount > 0 && (
        <span
          title={t('chip.predTitle', { count: predCount })}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-mono rounded bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
        >
          <ArrowDownLeft className="w-3 h-3 text-indigo-500" />
          <span>{predCount} {t('chip.pred')}</span>
        </span>
      )}

      {/* Successors count */}
      {succCount > 0 && !compact && (
        <span
          title={t('chip.succTitle', { count: succCount })}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-mono rounded bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
        >
          <ArrowUpRight className="w-3 h-3 text-cyan-500" />
          <span>{succCount} {t('chip.succ')}</span>
        </span>
      )}

      {/* Related count */}
      {relCount > 0 && !compact && (
        <span
          title={t('chip.relTitle', { count: relCount })}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-mono rounded bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-400 border border-slate-200 dark:border-slate-700"
        >
          <Link2 className="w-3 h-3 text-slate-400" />
          <span>{relCount}</span>
        </span>
      )}
    </div>
  );
};
