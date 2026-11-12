import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GitPullRequest,
  Search,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  UserCheck,
  User,
  Inbox
} from 'lucide-react';
import { useApp } from '../../context/useApp';
import type { PullRequest, PRQuickFilter, PRStatus, PullRequestReviewer } from '../../types/paging';
import { PullRequestInspector } from './PullRequestInspector';
import { WorkItemInspector } from '../Explorer/WorkItemInspector';

export const PullRequestExplorer: React.FC = () => {
  const { t } = useTranslation(['pullRequests', 'common']);
  const {
    api,
    filters,
    refreshToken,
    selectedWorkItem,
    setSelectedWorkItem,
    selectedPR,
    setSelectedPR
  } = useApp();

  const [quickFilter, setQuickFilter] = useState<PRQuickFilter>('needs-my-review');
  const [statusFilter, setStatusFilter] = useState<PRStatus>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ needsMyReview: 0, createdByMe: 0, involved: 0, totalActive: 0 });

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

  // Fetch PRs
  const fetchPRs = useCallback((signal: AbortSignal) => {
    const offset = (page - 1) * pageSize;
    return api.pullRequests(
      {
        project: filters.selectedProject,
        status: statusFilter,
        quickFilter,
        search: debouncedSearch,
        limit: pageSize,
        offset
      },
      signal
    );
  }, [api, filters.selectedProject, statusFilter, quickFilter, debouncedSearch, page, pageSize]);

  // A changed request is loading until that specific request settles.
  const request = useMemo(() => ({ fetchPRs, refreshToken, refreshNonce }), [fetchPRs, refreshToken, refreshNonce]);
  const loading = settled?.request !== request;
  const error = loading ? null : settled.error;

  useEffect(() => {
    const ctrl = new AbortController();
    request.fetchPRs(ctrl.signal).then(res => {
      if (ctrl.signal.aborted) return;
      setPrs(res.items);
      setTotal(res.total);
      if (res.summary) setSummary(res.summary);
      setSettled({ request, error: null });
    }, (e: any) => {
      if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.isAbort) return;
      setSettled({ request, error: e?.message || 'Failed to load pull requests' });
    });
    return () => ctrl.abort();
  }, [request]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const renderPrCount = (val: number): number | string => (loading && prs.length === 0 ? '—' : val);

  const getVoteIcon = (r: PullRequestReviewer) => {
    switch (r.vote) {
      case 10:
        return (
          <span title={t('votes.approved')}>
            <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
          </span>
        );
      case 5:
        return (
          <span title={t('votes.approvedWithSuggestions')}>
            <CheckCircle2 className="w-3 h-3 text-teal-500 shrink-0" />
          </span>
        );
      case -5:
        return (
          <span title={t('votes.waitingForAuthor')}>
            <AlertCircle className="w-3 h-3 text-amber-500 shrink-0" />
          </span>
        );
      case -10:
        return (
          <span title={t('votes.rejected')}>
            <AlertCircle className="w-3 h-3 text-rose-500 shrink-0" />
          </span>
        );
      default:
        return (
          <span title={t('votes.noVote')}>
            <HelpCircle className="w-3 h-3 text-slate-400 shrink-0" />
          </span>
        );
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* 1. Header Toolbar */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Quick Filter Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
            <button
              onClick={() => { setQuickFilter('needs-my-review'); setPage(1); }}
              data-testid="pr-filter-needs-my-review"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                quickFilter === 'needs-my-review'
                  ? 'bg-white dark:bg-[#161F2E] text-brand-600 dark:text-brand-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <UserCheck className="w-3.5 h-3.5 text-brand-500" />
              <span>{t('filters.needsMyReview')}</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                {renderPrCount(summary.needsMyReview)}
              </span>
            </button>

            <button
              onClick={() => { setQuickFilter('created-by-me'); setPage(1); }}
              data-testid="pr-filter-created-by-me"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                quickFilter === 'created-by-me'
                  ? 'bg-white dark:bg-[#161F2E] text-brand-600 dark:text-brand-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <User className="w-3.5 h-3.5 text-slate-500" />
              <span>{t('filters.createdByMe')}</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                {renderPrCount(summary.createdByMe)}
              </span>
            </button>

            <button
              onClick={() => { setQuickFilter('involved'); setPage(1); }}
              data-testid="pr-filter-involved"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                quickFilter === 'involved'
                  ? 'bg-white dark:bg-[#161F2E] text-brand-600 dark:text-brand-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <GitPullRequest className="w-3.5 h-3.5 text-slate-500" />
              <span>{t('filters.involved')}</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                {renderPrCount(summary.involved)}
              </span>
            </button>

            <button
              onClick={() => { setQuickFilter('all'); setPage(1); }}
              data-testid="pr-filter-all"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                quickFilter === 'all'
                  ? 'bg-white dark:bg-[#161F2E] text-brand-600 dark:text-brand-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <span>{t('filters.all')}</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                {renderPrCount(summary.totalActive)}
              </span>
            </button>
          </div>

          {/* Right: Status selector, Search and Refresh */}
          <div className="flex items-center gap-2.5">
            {/* Status Filter */}
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="text-[11px] font-medium hidden sm:inline">{t('filters.statusLabel')}</span>
              <select
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value as PRStatus); setPage(1); }}
                className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-800 dark:text-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none cursor-pointer"
              >
                <option value="active">{t('status.active')}</option>
                <option value="completed">{t('status.completed')}</option>
                <option value="abandoned">{t('status.abandoned')}</option>
                <option value="all">{t('status.all')}</option>
              </select>
            </div>

            {/* Search Input */}
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

            {/* Refresh Button */}
            <button
              onClick={() => setRefreshNonce(n => n + 1)}
              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t('actions.refresh', { ns: 'common' })}
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 2. Main Body: Table + Inspector Drawer */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 overflow-x-auto overflow-y-auto p-4 sm:p-5 flex flex-col">
          {loading && prs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="pr-loading">
              <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">{t('empty.loading')}</span>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-6" role="alert" data-testid="pr-error">
              <AlertCircle className="w-8 h-8 text-rose-500" />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('empty.loadFailed')}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 max-w-sm">{error}</span>
              <button
                onClick={() => setRefreshNonce(n => n + 1)}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-md transition-colors"
              >
                {t('empty.retry')}
              </button>
            </div>
          ) : prs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3 py-16" data-testid="pr-empty">
              <Inbox className="w-10 h-10 text-slate-300 dark:text-slate-700" />
              <span className="text-xs">{t('empty.noPRs')}</span>
            </div>
          ) : (
            <div className="min-w-[760px] bg-white dark:bg-[#0E131F] rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs overflow-hidden">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-[#0B0F17]/95 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
                    <th className="py-2.5 px-3.5 w-16">{t('columns.pr')}</th>
                    <th className="py-2.5 px-3">{t('columns.title')}</th>
                    <th className="py-2.5 px-3 w-48">{t('columns.repoBranch')}</th>
                    <th className="py-2.5 px-3 w-36">{t('columns.author')}</th>
                    <th className="py-2.5 px-3 w-40">{t('columns.reviewers')}</th>
                    <th className="py-2.5 px-3 w-24 text-center">{t('columns.status')}</th>
                    <th className="py-2.5 px-3 w-28 text-right">{t('columns.date')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {prs.map(pr => {
                    const isSelected = selectedPR?.id === pr.id;

                    return (
                      <tr
                        key={pr.id}
                        onClick={() => setSelectedPR(pr)}
                        data-testid="pr-row"
                        data-id={pr.id}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-brand-50/70 dark:bg-brand-950/40 border-l-4 border-l-brand-600'
                            : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40 border-l-4 border-l-transparent'
                        }`}
                      >
                        {/* ID */}
                        <td className="py-2.5 px-3.5 font-mono font-bold text-slate-400">
                          #{pr.id}
                        </td>

                        {/* Title & Draft Badge */}
                        <td className="py-2.5 px-3 min-w-[200px]">
                          <div className="flex items-center gap-2">
                            <span
                              title={pr.title}
                              className="font-semibold text-slate-900 dark:text-slate-100 text-[13.5px] truncate max-w-md"
                            >
                              {pr.title}
                            </span>
                            {Boolean(pr.isDraft) && (
                              <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 shrink-0">
                                {t('status.draft')}
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-slate-400">{pr.project}</span>
                        </td>

                        {/* Repository & Branches */}
                        <td className="py-2.5 px-3 font-mono text-[11px]">
                          <div className="font-semibold text-slate-700 dark:text-slate-300 truncate">
                            {pr.repository}
                          </div>
                          <div className="text-[10px] text-slate-400 truncate flex items-center gap-1">
                            <GitBranch className="w-3 h-3 text-brand-500" />
                            <span className="truncate max-w-[90px]">{pr.sourceBranch}</span>
                            <span>➔</span>
                            <span className="truncate max-w-[90px]">{pr.targetBranch}</span>
                          </div>
                        </td>

                        {/* Author */}
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2 min-w-0">
                            {pr.authorAvatar ? (
                              <img src={pr.authorAvatar} alt={pr.authorName} className="w-5 h-5 rounded-full object-cover shrink-0" />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-[9px] font-bold text-slate-600 shrink-0">
                                {pr.authorName.charAt(0)}
                              </div>
                            )}
                            <span className="text-slate-700 dark:text-slate-300 font-medium truncate max-w-[120px]" title={pr.authorName}>
                              {pr.authorName}
                            </span>
                          </div>
                        </td>

                        {/* Reviewers Summary */}
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {pr.reviewers.slice(0, 3).map((r, idx) => (
                              <div key={idx} className="flex items-center gap-0.5" title={`${r.displayName}: ${r.voteLabel}`}>
                                {r.avatar ? (
                                  <img src={r.avatar} alt={r.displayName} className="w-4 h-4 rounded-full object-cover" />
                                ) : (
                                  <div className="w-4 h-4 rounded-full bg-slate-100 dark:bg-slate-800 text-[8px] flex items-center justify-center font-bold">
                                    {r.displayName.charAt(0)}
                                  </div>
                                )}
                                {getVoteIcon(r)}
                              </div>
                            ))}
                            {pr.reviewers.length > 3 && (
                              <span className="text-[10px] text-slate-400 font-bold">+{pr.reviewers.length - 3}</span>
                            )}
                            {pr.reviewers.length === 0 && (
                              <span className="text-slate-400 italic text-[11px]">—</span>
                            )}
                          </div>
                        </td>

                        {/* Status */}
                        <td className="py-2.5 px-3 text-center">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold capitalize ${
                            pr.status === 'active'
                              ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 border border-sky-200 dark:border-sky-800'
                              : pr.status === 'completed'
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                              : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                          }`}>
                            {t(`status.${pr.status}`)}
                          </span>
                        </td>

                        {/* Creation Date */}
                        <td className="py-2.5 px-3 text-right text-slate-500 font-mono text-[11px]">
                          {pr.creationDate ? new Date(pr.creationDate).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right Side: PR Inspector */}
        {selectedPR && (
          <PullRequestInspector pr={selectedPR} onClose={() => setSelectedPR(null)} />
        )}

        {/* Work Item Inspector if a linked work item was clicked */}
        {selectedWorkItem && (
          <WorkItemInspector
            item={selectedWorkItem}
            onClose={() => setSelectedWorkItem(null)}
            onNavigateToItem={item => setSelectedWorkItem(item)}
          />
        )}
      </div>

      {/* 3. Footer Pagination Bar */}
      <div className="h-9 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] px-5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 select-none shrink-0">
        <div className="flex items-center gap-3">
          <span>{loading && prs.length === 0 ? '—' : t('summary.totalMatching', { total })}</span>
          {filters.selectedProject !== 'all' && (
            <span>• {t('filters.project', { ns: 'kanban', project: filters.selectedProject })}</span>
          )}
        </div>

        {/* Pager */}
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
