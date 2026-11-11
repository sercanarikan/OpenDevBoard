import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  ExternalLink,
  GitBranch,
  User,
  Clock,
  CheckCircle2,
  AlertTriangle,
  PlayCircle,
  XCircle,
  FileCode
} from 'lucide-react';
import type { PipelineRun } from '../../types/paging';

interface PipelineInspectorProps {
  run: PipelineRun;
  onClose: () => void;
}

export const PipelineInspector: React.FC<PipelineInspectorProps> = ({ run, onClose }) => {
  const { t } = useTranslation(['pipelines', 'common']);

  const formatDuration = (seconds: number) => {
    if (!seconds) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  };

  const getResultBadge = (status: string, result?: string | null) => {
    const st = (status || '').toLowerCase();
    const res = (result || '').toLowerCase();

    if (st === 'inprogress') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
          <PlayCircle className="w-3 h-3 text-sky-500 animate-spin" />
          <span>{t('status.inProgress')}</span>
        </span>
      );
    }

    switch (res) {
      case 'succeeded':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            <span>{t('result.succeeded')}</span>
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
            <AlertTriangle className="w-3 h-3 text-rose-500" />
            <span>{t('result.failed')}</span>
          </span>
        );
      case 'partiallysucceeded':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="w-3 h-3 text-amber-500" />
            <span>{t('result.partiallySucceeded')}</span>
          </span>
        );
      case 'canceled':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
            <XCircle className="w-3 h-3 text-slate-400" />
            <span>{t('result.canceled')}</span>
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-50 text-slate-600 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
            {t('result.none')}
          </span>
        );
    }
  };

  return (
    <aside
      data-testid="pipeline-inspector"
      data-id={run.id}
      className="w-96 min-w-[340px] max-w-md border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] flex flex-col h-full z-10 select-text shrink-0 shadow-lg"
    >
      {/* Top Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-3 bg-slate-50/50 dark:bg-slate-900/40 shrink-0">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400">
              #{run.id}
            </span>
            {getResultBadge(run.status, run.result)}
            <span className="text-xs text-slate-400 truncate">
              {run.project}
            </span>
          </div>
          <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-100 leading-snug break-words">
            {run.pipelineName}
          </h2>
        </div>

        <button
          onClick={onClose}
          aria-label={t('actions.close', { ns: 'common' })}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Main Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs">
        {/* Open in Azure DevOps Button */}
        {run.url && (
          <a
            href={run.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-lg bg-brand-50 hover:bg-brand-100 dark:bg-brand-950/60 dark:hover:bg-brand-900/60 text-brand-700 dark:text-brand-300 font-semibold border border-brand-200 dark:border-brand-800 transition-colors"
          >
            <span>{t('inspector.openInDevops')}</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}

        {/* Pipeline Information Card */}
        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 space-y-2.5">
          <div className="flex items-center gap-1.5 font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
            <FileCode className="w-3.5 h-3.5 text-brand-500" />
            <span>{t('inspector.pipelineInfo')}</span>
          </div>

          <div className="space-y-1.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('inspector.type')}</span>
              <span className="font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-800">
                {run.pipelineType}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('inspector.buildNumber')}</span>
              <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                {run.buildNumber}
              </span>
            </div>
          </div>
        </div>

        {/* Timing and Duration Card */}
        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 space-y-2.5">
          <div className="flex items-center gap-1.5 font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
            <Clock className="w-3.5 h-3.5 text-brand-500" />
            <span>{t('inspector.timing')}</span>
          </div>

          <div className="space-y-1.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('inspector.duration')}</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100 font-mono">
                {formatDuration(run.durationSeconds)}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('inspector.startTime')}</span>
              <span className="text-slate-700 dark:text-slate-300 font-mono">
                {run.startTime ? new Date(run.startTime).toLocaleString() : '—'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('inspector.finishTime')}</span>
              <span className="text-slate-700 dark:text-slate-300 font-mono">
                {run.finishTime ? new Date(run.finishTime).toLocaleString() : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Source Branch & Commit */}
        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 space-y-2.5">
          <div className="flex items-center gap-1.5 font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
            <GitBranch className="w-3.5 h-3.5 text-brand-500" />
            <span>{t('inspector.sourceCommit')}</span>
          </div>

          <div className="space-y-1.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('inspector.branch')}</span>
              <span className="font-mono font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[180px]" title={run.sourceBranch}>
                {run.sourceBranch || '—'}
              </span>
            </div>

            {run.sourceVersion && (
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('inspector.commit')}</span>
                <span className="font-mono text-[10px] text-slate-600 dark:text-slate-400 truncate max-w-[180px]" title={run.sourceVersion}>
                  {run.sourceVersion.slice(0, 8)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Triggered By User */}
        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 space-y-2">
          <div className="flex items-center gap-1.5 font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
            <User className="w-3.5 h-3.5 text-brand-500" />
            <span>{t('inspector.triggeredBy')}</span>
          </div>

          <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200 font-medium">
            <div className="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center font-bold text-[10px]">
              {run.requestedBy.charAt(0)}
            </div>
            <span className="truncate">{run.requestedBy}</span>
          </div>
        </div>
      </div>
    </aside>
  );
};
