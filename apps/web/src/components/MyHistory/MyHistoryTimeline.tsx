import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  GitCommit,
  GitPullRequest,
  UserCheck,
  Search,
  RotateCcw,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Inbox,
  AlertTriangle
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { HistoryEvent, HistorySummary } from '../../types/paging';
import { WorkItemInspector } from '../Explorer/WorkItemInspector';
import { PullRequestInspector } from '../PullRequests/PullRequestInspector';
import { groupTimelineEvents } from './timelineGroups';

export const MyHistoryTimeline: React.FC = () => {
  const { t } = useTranslation(['myHistory', 'common']);
  const {
    api,
    filters,
    refreshToken,
    selectedWorkItem,
    setSelectedWorkItem,
    selectedPR,
    setSelectedPR
  } = useApp();

  const [days, setDays] = useState<number>(30);
  const [activityType, setActivityType] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [timeline, setTimeline] = useState<{ events: HistoryEvent[]; asOf: number }>({ events: [], asOf: 0 });
  const { events, asOf } = timeline;
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<HistorySummary | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const sum = await api.myHistorySummary(days, filters.selectedProject, signal, {
        activityType,
        search: debouncedSearch
      });
      setSummary(sum);

      const offset = (page - 1) * pageSize;
      const res = await api.myHistoryTimeline(
        {
          project: filters.selectedProject,
          activityType,
          search: debouncedSearch,
          days,
          limit: pageSize,
          offset
        },
        signal
      );
      if (sum.totalMatchingEvents !== undefined && sum.totalMatchingEvents !== res.total) {
        throw new Error(`History scope mismatch: summary=${sum.totalMatchingEvents}, timeline=${res.total}`);
      }
      setTimeline({ events: res.items, asOf: Date.now() });
      setTotal(res.total);
      setLoading(false);
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.isAbort) return;
      setError(e?.message || 'Failed to load activity history');
      setLoading(false);
    }
  }, [api, days, filters.selectedProject, activityType, debouncedSearch, page]);

  useEffect(() => {
    const ctrl = new AbortController();
    loadHistory(ctrl.signal);
    return () => ctrl.abort();
  }, [loadHistory, refreshToken, refreshNonce]);

  const isReady = !loading && summary !== null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Chronological grouping
  const timelineGroups = useMemo(() => groupTimelineEvents(events, asOf), [events, asOf]);

  const handleEventClick = async (ev: HistoryEvent) => {
    if (ev.entity.type === 'workItem' && typeof ev.entity.id === 'number') {
      try {
        const item = await api.item(ev.entity.id);
        if (item) setSelectedWorkItem(item);
      } catch {
        if (ev.url) window.open(ev.url, '_blank');
      }
    } else if (ev.entity.type === 'pullRequest') {
      const prId = typeof ev.entity.id === 'number' ? ev.entity.id : parseInt(String(ev.entity.id), 10);
      if (!isNaN(prId)) {
        try {
          const pr = await api.pullRequest(prId);
          if (pr) setSelectedPR(pr);
        } catch {
          if (ev.url) window.open(ev.url, '_blank');
        }
      }
    } else if (ev.url) {
      window.open(ev.url, '_blank');
    }
  };

  const getEventIcon = (eventType: string) => {
    if (eventType.includes('workItem')) return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
    if (eventType.includes('commit')) return <GitCommit className="w-3.5 h-3.5 text-brand-500 shrink-0" />;
    if (eventType.includes('reviewed')) return <UserCheck className="w-3.5 h-3.5 text-purple-500 shrink-0" />;
    return <GitPullRequest className="w-3.5 h-3.5 text-indigo-500 shrink-0" />;
  };

  const getEventTypeBadge = (eventType: string) => {
    if (eventType === 'workItem.closed') {
      return <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">Tamamlandı</span>;
    }
    if (eventType === 'git.commit') {
      return <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300 border border-brand-200 dark:border-brand-800">Commit</span>;
    }
    if (eventType === 'git.pullRequest.merged') {
      return <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200 dark:border-purple-800">PR Merge</span>;
    }
    if (eventType === 'git.pullRequest.reviewed') {
      return <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">İnceleme</span>;
    }
    return <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700">Aktivite</span>;
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* 1. Overview Metrics Top Strip */}
      <div className="p-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] shrink-0 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {/* Card 1: Total Events */}
          <div className="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
            <div className="text-[11px] font-medium text-slate-500 truncate">{t('summary.totalEvents')}</div>
            <div className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-1">
              {isReady ? summary.totalEvents : '—'}
            </div>
          </div>

          {/* Card 2: Completed Work Items */}
          <div className="p-3 rounded-xl border border-emerald-200/80 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20">
            <div className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 truncate">{t('summary.completedWorkItems')}</div>
            <div className="text-xl font-bold text-emerald-700 dark:text-emerald-300 mt-1">
              {isReady ? summary.completedWorkItems : '—'}
            </div>
          </div>

          {/* Card 3: Commits */}
          <div className="p-3 rounded-xl border border-brand-200/80 dark:border-brand-900/50 bg-brand-50/50 dark:bg-brand-950/20">
            <div className="text-[11px] font-medium text-brand-700 dark:text-brand-400 truncate">{t('summary.commits')}</div>
            <div className="text-xl font-bold text-brand-700 dark:text-brand-300 mt-1">
              {isReady ? summary.commitsCount : '—'}
            </div>
          </div>

          {/* Card 4: Pull Requests */}
          <div className="p-3 rounded-xl border border-purple-200/80 dark:border-purple-900/50 bg-purple-50/50 dark:bg-purple-950/20">
            <div className="text-[11px] font-medium text-purple-700 dark:text-purple-400 truncate">{t('summary.pullRequests')}</div>
            <div className="text-xl font-bold text-purple-700 dark:text-purple-300 mt-1">
              {isReady ? summary.prsCount : '—'}
            </div>
          </div>

          {/* Card 5: Reviews */}
          <div className="p-3 rounded-xl border border-indigo-200/80 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/20">
            <div className="text-[11px] font-medium text-indigo-700 dark:text-indigo-400 truncate">{t('summary.reviews')}</div>
            <div className="text-xl font-bold text-indigo-700 dark:text-indigo-300 mt-1">
              {isReady ? summary.reviewsCount : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* 2. Filters & Search Toolbar */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* Activity Type Filters */}
          <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 text-xs">
            <button
              onClick={() => { setActivityType('all'); setPage(1); }}
              data-testid="history-filter-all"
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                activityType === 'all'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.all')}
            </button>
            <button
              onClick={() => { setActivityType('workItem'); setPage(1); }}
              data-testid="history-filter-workitem"
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                activityType === 'workItem'
                  ? 'bg-white dark:bg-[#161F2E] text-emerald-700 dark:text-emerald-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.workItem')}
            </button>
            <button
              onClick={() => { setActivityType('commit'); setPage(1); }}
              data-testid="history-filter-commit"
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                activityType === 'commit'
                  ? 'bg-white dark:bg-[#161F2E] text-brand-700 dark:text-brand-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.commit')}
            </button>
            <button
              onClick={() => { setActivityType('pullRequest'); setPage(1); }}
              data-testid="history-filter-pr"
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                activityType === 'pullRequest'
                  ? 'bg-white dark:bg-[#161F2E] text-purple-700 dark:text-purple-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.pullRequest')}
            </button>
            <button
              onClick={() => { setActivityType('review'); setPage(1); }}
              data-testid="history-filter-review"
              className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                activityType === 'review'
                  ? 'bg-white dark:bg-[#161F2E] text-indigo-700 dark:text-indigo-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t('filters.review')}
            </button>
          </div>

          {/* Period Selector (7d vs 30d) */}
          <div className="flex items-center gap-1.5 text-xs text-slate-500 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 bg-slate-50 dark:bg-slate-900">
            <span className="text-[11px]">{t('summary.period7d')}:</span>
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

      {/* 3. Main Timeline Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {loading && events.length === 0 ? (
            <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="history-loading">
              <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">{t('empty.loading')}</span>
            </div>
          ) : error ? (
            <div className="py-20 flex flex-col items-center justify-center text-center gap-3 px-6" role="alert" data-testid="history-error">
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
          ) : events.length === 0 ? (
            <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="history-empty">
              <Inbox className="w-10 h-10 text-slate-300 dark:text-slate-700" />
              <span className="text-xs">{t('empty.noEvents')}</span>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-6" data-testid="history-timeline">
              {(['today', 'yesterday', 'thisWeek', 'earlier'] as const).map(groupKey => {
                const groupEvents = timelineGroups[groupKey];
                if (!groupEvents || groupEvents.length === 0) return null;

                return (
                  <div key={groupKey} className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                        {t(`timeline.${groupKey}`)}
                      </span>
                      <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono">
                        {groupEvents.length}
                      </span>
                      <div className="flex-1 h-px bg-slate-200 dark:border-slate-800" />
                    </div>

                    <div className="space-y-2">
                      {groupEvents.map(ev => (
                        <div
                          key={ev.id}
                          onClick={() => handleEventClick(ev)}
                          data-testid="history-event-card"
                          data-id={ev.id}
                          className="cursor-pointer p-3 rounded-xl bg-white dark:bg-[#0E131F] border border-slate-200 dark:border-slate-800 hover:border-brand-400 dark:hover:border-brand-800 shadow-2xs hover:shadow-xs transition-all flex items-start gap-3"
                        >
                          <div className="mt-0.5">{getEventIcon(ev.eventType)}</div>

                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              {getEventTypeBadge(ev.eventType)}
                              <span className="font-bold text-xs text-slate-900 dark:text-slate-100 truncate">
                                {ev.entity.title}
                              </span>
                              <span className="text-[10px] font-mono text-slate-400 truncate">
                                {ev.project}
                              </span>
                            </div>

                            <p className="text-xs text-slate-600 dark:text-slate-400 truncate">
                              {ev.summary}
                            </p>
                          </div>

                          <div className="shrink-0 flex items-center gap-2 text-right">
                            <span className="text-[11px] font-mono text-slate-400">
                              {ev.occurredAt ? new Date(ev.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                            </span>
                            {ev.url && (
                              <a
                                href={ev.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="text-slate-400 hover:text-brand-600"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* WorkItem or PullRequest Slide-over Inspector */}
        {selectedWorkItem && (
          <WorkItemInspector
            item={selectedWorkItem}
            onClose={() => setSelectedWorkItem(null)}
            onNavigateToItem={item => setSelectedWorkItem(item)}
          />
        )}
        {selectedPR && (
          <PullRequestInspector
            pr={selectedPR}
            onClose={() => setSelectedPR(null)}
          />
        )}
      </div>

      {/* 4. Footer Pagination Bar */}
      <div className="h-9 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] px-5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 select-none shrink-0">
        <span>{loading && events.length === 0 ? '—' : `${total} aktivite · ${events.length} bu sayfada`}</span>
        {total > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-slate-400">{page} / {totalPages}</span>
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
