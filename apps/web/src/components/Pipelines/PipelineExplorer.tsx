import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PlayCircle,
  Search,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Inbox
} from 'lucide-react';
import { useApp } from '../../context/useApp';
import type { PipelineRun, PipelineSummary } from '../../types/paging';
import { PipelineInspector } from './PipelineInspector';

export const PipelineExplorer: React.FC = () => {
  const { t } = useTranslation(['pipelines', 'common', 'dashboard']);
  const {
    api,
    filters,
    refreshToken,
    selectedPipelineRun,
    setSelectedPipelineRun
  } = useApp();

  const [days, setDays] = useState<number>(30);
  const [resultFilter, setResultFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [cacheStatus, setCacheStatus] = useState<PipelineSummary['cacheStatus']>();

  const [settled, setSettled] = useState<{ request: object; error: string | null } | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchPipelines = useCallback((signal: AbortSignal) => {
    const offset = (page - 1) * pageSize;
    return api.pipelines(
      {
        project: filters.selectedProject,
        result: resultFilter,
        search: debouncedSearch,
        days,
        limit: pageSize,
        offset
      },
      signal
    );
  }, [api, filters.selectedProject, resultFilter, debouncedSearch, days, page]);

  // A changed request is loading until that specific request settles.
  const request = useMemo(() => ({ fetchPipelines, refreshToken, refreshNonce }), [fetchPipelines, refreshToken, refreshNonce]);
  const loading = settled?.request !== request;
  const error = loading ? null : settled.error;

  useEffect(() => {
    const ctrl = new AbortController();
    request.fetchPipelines(ctrl.signal).then(res => {
      if (ctrl.signal.aborted) return;
      setRuns(res.items);
      setTotal(res.total);
      if (res.summary) setSummary(res.summary);
      setCacheStatus(res.cacheStatus);
      setSettled({ request, error: null });
    }, (e: any) => {
      if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.isAbort) return;
      setSettled({ request, error: e?.message || 'Failed to load pipeline runs' });
    });
    return () => ctrl.abort();
  }, [request]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

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

  const isReady = !loading && summary !== null && !(cacheStatus?.outcome === 'failed' && !cacheStatus.lastSyncedAt);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {!loading && !error && cacheStatus && (cacheStatus.outcome === 'partial' || cacheStatus.outcome === 'failed' || cacheStatus.stale) && (
        <div role="status" className="m-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
          {t(cacheStatus.outcome === 'failed' ? 'cache.pipelineFailed' : cacheStatus.outcome === 'partial' ? 'cache.pipelinePartial' : 'cache.pipelineStale', { ns: 'dashboard' })}
        </div>
      )}
      {/* 1. Summary Cards Top Strip */}
      <div className="p-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] shrink-0">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* Card 1: Total Pipelines */}
          <div className="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
            <div className="text-[11px] font-medium text-slate-500 truncate">{t('summary.totalPipelines')}</div>
            <div className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-1">
              {isReady ? summary.totalPipelines : '—'}
            </div>
          </div>

          {/* Card 2: Total Runs */}
          <div className="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
            <div className="text-[11px] font-medium text-slate-500 truncate">{t('summary.totalRuns')}</div>
            <div className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-1">
              {isReady ? summary.totalRuns : '—'}
            </div>
          </div>

          {/* Card 3: Succeeded */}
          <div className="p-3 rounded-xl border border-emerald-200/80 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20">
            <div className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 truncate">{t('summary.succeeded')}</div>
            <div className="text-xl font-bold text-emerald-700 dark:text-emerald-300 mt-1">
              {isReady ? summary.succeeded : '—'}
            </div>
          </div>

          {/* Card 4: Failed */}
          <div className="p-3 rounded-xl border border-rose-200/80 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20">
            <div className="text-[11px] font-medium text-rose-700 dark:text-rose-400 truncate">{t('summary.failed')}</div>
            <div className="text-xl font-bold text-rose-700 dark:text-rose-300 mt-1">
              {isReady ? summary.failed : '—'}
            </div>
          </div>

          {/* Card 5: In Progress */}
          <div className="p-3 rounded-xl border border-sky-200/80 dark:border-sky-900/50 bg-sky-50/50 dark:bg-sky-950/20">
            <div className="text-[11px] font-medium text-sky-700 dark:text-sky-400 truncate">{t('summary.inProgress')}</div>
            <div className="text-xl font-bold text-sky-700 dark:text-sky-300 mt-1">
              {isReady ? summary.inProgress : '—'}
            </div>
          </div>

          {/* Card 6: Success Rate */}
          <div className="p-3 rounded-xl border border-brand-200/80 dark:border-brand-900/50 bg-brand-50/50 dark:bg-brand-950/20">
            <div className="text-[11px] font-medium text-brand-700 dark:text-brand-400 truncate">{t('summary.successRate')}</div>
            <div className="text-xl font-bold text-brand-700 dark:text-brand-300 mt-1">
              {isReady ? `%${summary.successRate}` : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* 2. Filters Toolbar */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* Result Filter Tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 text-xs">
            <button
              onClick={() => { setResultFilter('all'); setPage(1); }}
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                resultFilter === 'all'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.all')}
            </button>
            <button
              onClick={() => { setResultFilter('succeeded'); setPage(1); }}
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                resultFilter === 'succeeded'
                  ? 'bg-white dark:bg-[#161F2E] text-emerald-700 dark:text-emerald-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.succeeded')}
            </button>
            <button
              onClick={() => { setResultFilter('failed'); setPage(1); }}
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                resultFilter === 'failed'
                  ? 'bg-white dark:bg-[#161F2E] text-rose-700 dark:text-rose-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.failed')}
            </button>
          </div>

          {/* Period Selector (7d vs 30d) */}
          <div className="flex items-center gap-1.5 text-xs text-slate-500 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 bg-slate-50 dark:bg-slate-900">
            <span className="text-[11px]">{t('filters.periodLabel')}</span>
            <select
              value={days}
              onChange={e => { setDays(Number(e.target.value)); setPage(1); }}
              className="bg-transparent font-semibold text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value={7}>{t('summary.period7d')}</option>
              <option value={30}>{t('summary.period30d')}</option>
            </select>
          </div>
        </div>

        {/* Right Search and Refresh */}
        <div className="flex items-center gap-2.5">
          <div className="relative min-w-[200px] sm:min-w-[240px]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('filters.searchPlaceholder')}
              className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <button
            onClick={() => setRefreshNonce(n => n + 1)}
            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title={t('actions.refresh', { ns: 'common' })}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 3. Main Body: Runs Table + Inspector Drawer */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 overflow-x-auto overflow-y-auto p-4 sm:p-5 flex flex-col">
          {loading && runs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="pipeline-loading">
              <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">{t('empty.loading')}</span>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-6" role="alert" data-testid="pipeline-error">
              <AlertTriangle className="w-8 h-8 text-rose-500" />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('empty.loadFailed')}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 max-w-sm">{error}</span>
              <button
                onClick={() => setRefreshNonce(n => n + 1)}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-md transition-colors"
              >
                {t('empty.retry')}
              </button>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3 py-16" data-testid="pipeline-empty">
              <Inbox className="w-10 h-10 text-slate-300 dark:text-slate-700" />
              <span className="text-xs">{t('empty.noPipelines')}</span>
            </div>
          ) : (
            <div className="min-w-[760px] bg-white dark:bg-[#0E131F] rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs overflow-hidden">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-[#0B0F17]/95 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
                    <th className="py-2.5 px-3.5 w-20">{t('columns.build')}</th>
                    <th className="py-2.5 px-3">{t('columns.pipeline')}</th>
                    <th className="py-2.5 px-3 w-40">{t('columns.branch')}</th>
                    <th className="py-2.5 px-3 w-32 text-center">{t('columns.status')}</th>
                    <th className="py-2.5 px-3 w-24 text-center">{t('columns.duration')}</th>
                    <th className="py-2.5 px-3 w-36">{t('columns.triggeredBy')}</th>
                    <th className="py-2.5 px-3 w-28 text-right">{t('columns.date')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {runs.map(run => {
                    const isSelected = selectedPipelineRun?.id === run.id;

                    return (
                      <tr
                        key={run.id}
                        onClick={() => setSelectedPipelineRun(run)}
                        data-testid="pipeline-row"
                        data-id={run.id}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-brand-50/70 dark:bg-brand-950/40 border-l-4 border-l-brand-600'
                            : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40 border-l-4 border-l-transparent'
                        }`}
                      >
                        {/* Build ID & Number */}
                        <td className="py-2.5 px-3.5 font-mono font-bold text-slate-400">
                          #{run.id}
                        </td>

                        {/* Pipeline Name & Type Badge */}
                        <td className="py-2.5 px-3 min-w-[180px]">
                          <div className="flex items-center gap-2">
                            <span
                              title={run.pipelineName}
                              className="font-semibold text-slate-900 dark:text-slate-100 text-[13px] truncate max-w-sm"
                            >
                              {run.pipelineName}
                            </span>
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                              {run.pipelineType}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-400">{run.project}</span>
                        </td>

                        {/* Source Branch */}
                        <td className="py-2.5 px-3 font-mono text-[11px]">
                          <div className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300 truncate" title={run.sourceBranch}>
                            <GitBranch className="w-3.5 h-3.5 text-brand-500 shrink-0" />
                            <span className="truncate">{run.sourceBranch || '—'}</span>
                          </div>
                        </td>

                        {/* Status / Result Badge */}
                        <td className="py-2.5 px-3 text-center">
                          {getResultBadge(run.status, run.result)}
                        </td>

                        {/* Duration */}
                        <td className="py-2.5 px-3 text-center font-mono text-slate-600 dark:text-slate-400">
                          {formatDuration(run.durationSeconds)}
                        </td>

                        {/* Triggered By */}
                        <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300 font-medium truncate max-w-[120px]" title={run.requestedBy}>
                          {run.requestedBy}
                        </td>

                        {/* Date */}
                        <td className="py-2.5 px-3 text-right text-slate-500 font-mono text-[11px]">
                          {run.finishTime ? new Date(run.finishTime).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right Detail Inspector */}
        {selectedPipelineRun && (
          <PipelineInspector run={selectedPipelineRun} onClose={() => setSelectedPipelineRun(null)} />
        )}
      </div>

      {/* 4. Footer Pagination Bar */}
      <div className="h-9 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] px-5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 select-none shrink-0">
        <div className="flex items-center gap-3">
          <span>{loading && runs.length === 0 ? '—' : t('runCount', { count: total })}</span>
          {filters.selectedProject !== 'all' && (
            <span>• {t('filters.project', { ns: 'kanban', project: filters.selectedProject })}</span>
          )}
        </div>

        {total > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-slate-400">
              {page} / {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label="Previous Page"
                className="p-1 rounded border border-slate-200 dark:border-slate-800 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                aria-label="Next Page"
                className="p-1 rounded border border-slate-200 dark:border-slate-800 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
