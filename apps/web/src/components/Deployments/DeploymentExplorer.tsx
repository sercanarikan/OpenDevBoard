import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  PlayCircle,
  XCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  BarChart3,
  Building2,
  X,
  Inbox
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { DeploymentEnvironmentStat, DeploymentRecord, DeploymentSummary } from '../../types/paging';
import { DeploymentInspector } from './DeploymentInspector';

const emptyEnvironments: DeploymentEnvironmentStat[] = [];

export const DeploymentExplorer: React.FC = () => {
  const { t } = useTranslation(['deployments', 'common']);
  const {
    api,
    filters,
    refreshToken,
    selectedDeployment,
    setSelectedDeployment
  } = useApp();

  const [days, setDays] = useState<number>(30);
  const [envFilter, setEnvFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Environment filter expansion & search
  const [isEnvExpanded, setIsEnvExpanded] = useState(false);
  const [envSearchQuery, setEnvSearchQuery] = useState('');
  const [analyticsView, setAnalyticsView] = useState<'none' | 'trend' | 'projects'>('trend');

  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectionScope, setSelectionScope] = useState<string | null>(null);
  const scope = JSON.stringify([filters.selectedProject, envFilter, statusFilter, debouncedSearch, days, page]);
  // A selection belongs to one continuous visit to a scope, not future visits to the same scope.
  if (selectionScope !== null && selectionScope !== scope) {
    setSelectionScope(null);
  }
  const request = useMemo(() => ({ scope, api, refreshToken, refreshNonce }), [scope, api, refreshToken, refreshNonce]);
  const [result, setResult] = useState<{
    request: typeof request;
    scope: string;
    deployments: DeploymentRecord[];
    total: number;
    summary: DeploymentSummary | null;
    error: string | null;
  } | null>(null);
  const sameScope = result?.scope === scope;
  const deployments = sameScope ? result.deployments : [];
  const total = sameScope ? result.total : 0;
  const summary = sameScope ? result.summary : null;
  const loading = result?.request !== request;
  const error = loading ? null : result?.error ?? null;

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery !== debouncedSearch) {
        setSelectedDeployment(null);
        setDebouncedSearch(searchQuery);
        setPage(1);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, debouncedSearch, setSelectedDeployment]);

  useEffect(() => {
    const ctrl = new AbortController();
    const offset = (page - 1) * pageSize;
    api.deployments({
      project: filters.selectedProject,
      environment: envFilter,
      status: statusFilter,
      search: debouncedSearch,
      days,
      limit: pageSize,
      offset
    }, ctrl.signal).then(res => {
      if (ctrl.signal.aborted) return;
      setResult(previous => ({
        request, scope, deployments: res.items, total: res.total,
        summary: res.summary ?? (previous?.scope === scope ? previous.summary : null), error: null
      }));
    }).catch((e: any) => {
      if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.isAbort) return;
      setResult(previous => ({
        request, scope,
        deployments: previous?.scope === scope ? previous.deployments : [],
        total: previous?.scope === scope ? previous.total : 0,
        summary: previous?.scope === scope ? previous.summary : null,
        error: e?.message || 'Failed to load deployment records'
      }));
    });
    return () => ctrl.abort();
  }, [api, filters.selectedProject, envFilter, statusFilter, debouncedSearch, days, page, request, scope]);

  // Local scope controls invalidate the shared selection at the event that changes scope.
  const invalidateSelection = () => {
    setSelectionScope(null);
    setSelectedDeployment(null);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const formatDuration = (seconds: number) => {
    if (!seconds) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  };

  const getStatusBadge = (status: string) => {
    const s = (status || '').toLowerCase();
    switch (s) {
      case 'succeeded':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            <span>{t('status.succeeded')}</span>
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
            <AlertTriangle className="w-3 h-3 text-rose-500" />
            <span>{t('status.failed')}</span>
          </span>
        );
      case 'inprogress':
      case 'in_progress':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
            <PlayCircle className="w-3 h-3 text-sky-500 animate-spin" />
            <span>{t('status.inProgress')}</span>
          </span>
        );
      case 'canceled':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
            <XCircle className="w-3 h-3 text-slate-400" />
            <span>{t('status.canceled')}</span>
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-50 text-slate-600 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
            {status}
          </span>
        );
    }
  };

  const isReady = !loading && summary !== null;

  // Filtered and visible environments
  const allEnvironments = summary?.environments ?? emptyEnvironments;
  const visibleEnvironments = useMemo(() => {
    let list = allEnvironments;
    if (envSearchQuery.trim()) {
      const q = envSearchQuery.toLowerCase();
      return list.filter(e => e.name.toLowerCase().includes(q));
    }
    if (isEnvExpanded) {
      return list;
    }
    // Limited view: top 6 environments + selected environment if outside top 6
    const top = list.slice(0, 6);
    if (envFilter !== 'all' && !top.some(e => e.name === envFilter)) {
      const selected = list.find(e => e.name === envFilter);
      if (selected) top.push(selected);
    }
    return top;
  }, [allEnvironments, envSearchQuery, isEnvExpanded, envFilter]);

  // Max daily total for trend chart scaling
  const maxDaily = useMemo(() => {
    if (!summary?.dailyStats?.length) return 1;
    return Math.max(1, ...summary.dailyStats.map(d => d.total));
  }, [summary]);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* 1. Overview Metrics Top Strip */}
      <div className="p-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] shrink-0 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* Card 1: Total Deployments */}
          <div className="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
            <div className="text-[11px] font-medium text-slate-500 truncate">{t('summary.totalDeployments')}</div>
            <div className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-1">
              {isReady ? summary.totalDeployments : '—'}
            </div>
          </div>

          {/* Card 2: Succeeded */}
          <div className="p-3 rounded-xl border border-emerald-200/80 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20">
            <div className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 truncate">{t('summary.succeeded')}</div>
            <div className="text-xl font-bold text-emerald-700 dark:text-emerald-300 mt-1">
              {isReady ? summary.succeeded : '—'}
            </div>
          </div>

          {/* Card 3: Failed */}
          <div className="p-3 rounded-xl border border-rose-200/80 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20">
            <div className="text-[11px] font-medium text-rose-700 dark:text-rose-400 truncate">{t('summary.failed')}</div>
            <div className="text-xl font-bold text-rose-700 dark:text-rose-300 mt-1">
              {isReady ? summary.failed : '—'}
            </div>
          </div>

          {/* Card 4: Success Rate */}
          <div className="p-3 rounded-xl border border-brand-200/80 dark:border-brand-900/50 bg-brand-50/50 dark:bg-brand-950/20">
            <div className="text-[11px] font-medium text-brand-700 dark:text-brand-400 truncate">{t('summary.successRate')}</div>
            <div className="text-xl font-bold text-brand-700 dark:text-brand-300 mt-1">
              {isReady ? `%${summary.successRate}` : '—'}
            </div>
          </div>
        </div>

        {/* Analytics Toggle (Trend / Project Breakdown) */}
        {isReady && (
          <div className="pt-1 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mr-1">Analitik:</span>
              <button
                onClick={() => setAnalyticsView(v => v === 'trend' ? 'none' : 'trend')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-semibold border transition-all ${
                  analyticsView === 'trend'
                    ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
                    : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" />
                <span>{t('sections.trend')}</span>
              </button>

              <button
                onClick={() => setAnalyticsView(v => v === 'projects' ? 'none' : 'projects')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-semibold border transition-all ${
                  analyticsView === 'projects'
                    ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
                    : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900'
                }`}
              >
                <Building2 className="w-3.5 h-3.5" />
                <span>{t('sections.projectBreakdown')}</span>
              </button>
            </div>

            <div className="text-[11px] text-slate-400 font-mono">
              {t('sources.supportedNote')}
            </div>
          </div>
        )}

        {/* 1.A. Trend Chart View */}
        {isReady && analyticsView === 'trend' && summary.dailyStats?.length > 0 && (
          <div data-testid="deployment-trend-chart" className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/40 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
              <span>{t('sections.trend')} ({days} {days === 7 ? 'gün' : 'gün'})</span>
              <div className="flex items-center gap-3 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500" />
                  <span className="text-slate-500">{t('summary.succeeded')}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-rose-500" />
                  <span className="text-slate-500">{t('summary.failed')}</span>
                </div>
              </div>
            </div>

            <div className="h-20 flex items-end gap-1 pt-2 overflow-x-auto">
              {summary.dailyStats.map((d, i) => {
                const sPct = (d.succeeded / maxDaily) * 100;
                const fPct = (d.failed / maxDaily) * 100;

                return (
                  <div key={i} className="flex-1 min-w-[12px] flex flex-col items-center gap-1 h-full justify-end group relative">
                    <div className="w-full flex flex-col justify-end h-full">
                      {d.failed > 0 && (
                        <div
                          style={{ height: `${Math.max(4, fPct)}%` }}
                          className="w-full bg-rose-500 rounded-t-xs"
                          title={`${d.date}: ${d.failed} hatalı`}
                        />
                      )}
                      {d.succeeded > 0 && (
                        <div
                          style={{ height: `${Math.max(4, sPct)}%` }}
                          className="w-full bg-emerald-500 rounded-t-xs"
                          title={`${d.date}: ${d.succeeded} başarılı`}
                        />
                      )}
                      {d.total === 0 && (
                        <div className="w-full h-0.5 bg-slate-200 dark:bg-slate-800 rounded-full" />
                      )}
                    </div>
                    {i % (days === 30 ? 5 : 1) === 0 && (
                      <span className="text-[9px] text-slate-400 whitespace-nowrap">{d.date}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 1.B. Project Breakdown Table */}
        {isReady && analyticsView === 'projects' && summary.projects && summary.projects.length > 0 && (
          <div data-testid="deployment-project-breakdown" className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] overflow-hidden text-xs">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  <th className="py-2 px-3">{t('columns.project')}</th>
                  <th className="py-2 px-3 text-center">{t('summary.totalDeployments')}</th>
                  <th className="py-2 px-3 text-center text-emerald-600 dark:text-emerald-400">{t('summary.succeeded')}</th>
                  <th className="py-2 px-3 text-center text-rose-600 dark:text-rose-400">{t('summary.failed')}</th>
                  <th className="py-2 px-3 text-right">{t('summary.successRate')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {summary.projects.map(p => (
                  <tr key={p.project} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                    <td className="py-1.5 px-3 font-semibold text-slate-900 dark:text-slate-100">{p.project}</td>
                    <td className="py-1.5 px-3 text-center font-mono">{p.total}</td>
                    <td className="py-1.5 px-3 text-center font-mono text-emerald-600 dark:text-emerald-400 font-bold">{p.succeeded}</td>
                    <td className="py-1.5 px-3 text-center font-mono text-rose-600 dark:text-rose-400 font-bold">{p.failed}</td>
                    <td className="py-1.5 px-3 text-right font-mono font-semibold">%{p.successRate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Collapsible & Searchable Environment Filter Section */}
        {isReady && allEnvironments.length > 0 && (
          <div className="space-y-2 pt-1 border-t border-slate-100 dark:border-slate-800/80">
            <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  {t('sections.environments')} ({allEnvironments.length}):
                </span>
                {envFilter !== 'all' && (
                  <button
                    onClick={() => { invalidateSelection(); setEnvFilter('all'); setPage(1); }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline"
                  >
                    <X className="w-3 h-3" />
                    <span>{t('filters.clearFilter')}</span>
                  </button>
                )}
              </div>

              {/* Inline Environment Search & Expand Toggle */}
              <div className="flex items-center gap-2">
                {allEnvironments.length > 6 && (
                  <div className="relative">
                    <Search className="w-3 h-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={envSearchQuery}
                      onChange={e => setEnvSearchQuery(e.target.value)}
                      placeholder={t('filters.searchEnvsPlaceholder')}
                      className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md pl-6 pr-2 py-0.5 text-[11px] w-36 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                )}

                {allEnvironments.length > 6 && !envSearchQuery && (
                  <button
                    onClick={() => setIsEnvExpanded(v => !v)}
                    className="flex items-center gap-1 text-[11px] font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700"
                  >
                    <span>{isEnvExpanded ? t('filters.showLessEnvs') : t('filters.showAllEnvs', { count: allEnvironments.length })}</span>
                    {isEnvExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                )}
              </div>
            </div>

            {/* Environment Chips Grid */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {visibleEnvironments.map(env => (
                <button
                  key={env.name}
                  onClick={() => { invalidateSelection(); setEnvFilter(envFilter === env.name ? 'all' : env.name); setPage(1); }}
                  data-testid="env-chip"
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                    envFilter === env.name
                      ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300 shadow-xs'
                      : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:text-slate-900'
                  }`}
                >
                  <span>{env.name}</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white dark:bg-slate-800 font-bold">
                    {env.total}
                  </span>
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono">
                    %{env.successRate}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2. Filters Toolbar */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* Status Filter Tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 text-xs">
            <button
              onClick={() => { if (statusFilter !== 'all' || page !== 1) invalidateSelection(); setStatusFilter('all'); setPage(1); }}
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                statusFilter === 'all'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.all')}
            </button>
            <button
              onClick={() => { if (statusFilter !== 'succeeded' || page !== 1) invalidateSelection(); setStatusFilter('succeeded'); setPage(1); }}
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                statusFilter === 'succeeded'
                  ? 'bg-white dark:bg-[#161F2E] text-emerald-700 dark:text-emerald-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('status.succeeded')}
            </button>
            <button
              onClick={() => { if (statusFilter !== 'failed' || page !== 1) invalidateSelection(); setStatusFilter('failed'); setPage(1); }}
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                statusFilter === 'failed'
                  ? 'bg-white dark:bg-[#161F2E] text-rose-700 dark:text-rose-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('status.failed')}
            </button>
          </div>

          {/* Period Selector (7d vs 30d) */}
          <div className="flex items-center gap-1.5 text-xs text-slate-500 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 bg-slate-50 dark:bg-slate-900">
            <span className="text-[11px]">{t('filters.periodLabel')}</span>
            <select
              value={days}
              onChange={e => { if (days !== Number(e.target.value) || page !== 1) invalidateSelection(); setDays(Number(e.target.value)); setPage(1); }}
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
              onChange={e => { if (e.target.value !== searchQuery) invalidateSelection(); setSearchQuery(e.target.value); }}
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

      {/* 3. Main Body: Deployments Table + Inspector Drawer */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 overflow-x-auto overflow-y-auto p-4 sm:p-5 flex flex-col">
          {loading && deployments.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="deployment-loading">
              <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">{t('empty.loading')}</span>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-6" role="alert" data-testid="deployment-error">
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
          ) : deployments.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3 py-16" data-testid="deployment-empty">
              <Inbox className="w-10 h-10 text-slate-300 dark:text-slate-700" />
              <span className="text-xs">{t('empty.noDeployments')}</span>
            </div>
          ) : (
            <div className="min-w-[760px] bg-white dark:bg-[#0E131F] rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs overflow-hidden">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-[#0B0F17]/95 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
                    <th className="py-2.5 px-3.5 w-20">{t('columns.release')}</th>
                    <th className="py-2.5 px-3">{t('columns.pipeline')}</th>
                    <th className="py-2.5 px-3 w-36">{t('columns.environment')}</th>
                    <th className="py-2.5 px-3 w-32 text-center">{t('columns.status')}</th>
                    <th className="py-2.5 px-3 w-24 text-center">{t('columns.duration')}</th>
                    <th className="py-2.5 px-3 w-36">{t('columns.deployedBy')}</th>
                    <th className="py-2.5 px-3 w-28 text-right">{t('columns.date')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {deployments.map(dep => {
                    const isSelected = selectionScope === scope && selectedDeployment?.id === dep.id;

                    return (
                      <tr
                        key={dep.id}
                        onClick={() => { setSelectionScope(scope); setSelectedDeployment(dep); }}
                        data-testid="deployment-row"
                        data-id={dep.id}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-brand-50/70 dark:bg-brand-950/40 border-l-4 border-l-brand-600'
                            : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40 border-l-4 border-l-transparent'
                        }`}
                      >
                        {/* Release Name */}
                        <td className="py-2.5 px-3.5 font-mono font-bold text-slate-400">
                          {dep.releaseName}
                        </td>

                        {/* Pipeline / Definition */}
                        <td className="py-2.5 px-3 min-w-[180px]">
                          <div className="font-semibold text-slate-900 dark:text-slate-100 text-[13px] truncate max-w-sm" title={dep.definitionName}>
                            {dep.definitionName}
                          </div>
                          <span className="text-[11px] text-slate-400">{dep.project}</span>
                        </td>

                        {/* Target Environment */}
                        <td className="py-2.5 px-3">
                          <span className="inline-flex px-2 py-0.5 rounded-md text-xs font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200">
                            {dep.environmentName}
                          </span>
                        </td>

                        {/* Status */}
                        <td className="py-2.5 px-3 text-center">
                          {getStatusBadge(dep.status)}
                        </td>

                        {/* Duration */}
                        <td className="py-2.5 px-3 text-center font-mono text-slate-600 dark:text-slate-400">
                          {formatDuration(dep.durationSeconds)}
                        </td>

                        {/* Deployed By */}
                        <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300 font-medium truncate max-w-[120px]" title={dep.requestedBy}>
                          {dep.requestedBy}
                        </td>

                        {/* Date */}
                        <td className="py-2.5 px-3 text-right text-slate-500 font-mono text-[11px]">
                          {dep.startedOn ? new Date(dep.startedOn).toLocaleDateString() : '—'}
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
        {selectedDeployment && selectionScope === scope && (
          <DeploymentInspector deployment={selectedDeployment} onClose={() => setSelectedDeployment(null)} />
        )}
      </div>

      {/* 4. Footer Pagination Bar */}
      <div className="h-9 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] px-5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 select-none shrink-0">
        <div className="flex items-center gap-3">
          <span>{loading && deployments.length === 0 ? '—' : `${total} dağıtım kaydı gösteriliyor`}</span>
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
                onClick={() => { invalidateSelection(); setPage(p => Math.max(1, p - 1)); }}
                disabled={page <= 1}
                aria-label="Previous Page"
                className="p-1 rounded border border-slate-200 dark:border-slate-800 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => { invalidateSelection(); setPage(p => Math.min(totalPages, p + 1)); }}
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
