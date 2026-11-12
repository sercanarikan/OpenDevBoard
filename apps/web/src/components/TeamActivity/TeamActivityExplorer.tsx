import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Users,
  GitCommit,
  Search,
  RotateCcw,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  FolderGit2,
  X,
  AlertTriangle
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type {
  TeamActivitySummary,
  TeamContributor,
  TeamCommit
} from '../../types/paging';

export const TeamActivityExplorer: React.FC = () => {
  const { t } = useTranslation(['teamActivity', 'common']);
  const {
    api,
    filters,
    refreshToken
  } = useApp();

  const [days, setDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<'contributors' | 'repositories' | 'commits'>('contributors');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Sorting for contributors
  const [contributorSortBy, setContributorSortBy] = useState<'commits' | 'prs' | 'reviews' | 'name' | 'activity'>('commits');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Selected contributor for detail drawer
  const [selectedContributor, setSelectedContributor] = useState<TeamContributor | null>(null);

  // Pagination for commits
  const [commitPage, setCommitPage] = useState(1);
  const pageSize = 25;

  const [summary, setSummary] = useState<TeamActivitySummary | null>(null);
  const [commits, setCommits] = useState<TeamCommit[]>([]);
  const [commitsTotal, setCommitsTotal] = useState(0);

  const [settled, setSettled] = useState<{ request: object; error: string | null } | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setCommitPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const request = useMemo(() => ({ api, days, project: filters.selectedProject, debouncedSearch, commitPage, refreshToken, refreshNonce }),
    [api, days, filters.selectedProject, debouncedSearch, commitPage, refreshToken, refreshNonce]);
  const loading = settled?.request !== request;
  const error = loading ? null : settled.error;

  useEffect(() => {
    const ctrl = new AbortController();
    request.api.teamActivitySummary(request.days, request.project, ctrl.signal).then(async sum => {
      if (ctrl.signal.aborted) return;
      setSummary(sum);

      const offset = (request.commitPage - 1) * pageSize;
      const cRes = await request.api.teamCommits(
        {
          project: request.project,
          search: request.debouncedSearch,
          days: request.days,
          limit: pageSize,
          offset
        },
        ctrl.signal
      );
      if (ctrl.signal.aborted) return;
      setCommits(cRes.items);
      setCommitsTotal(cRes.total);

      setSettled({ request, error: null });
    }).catch((e: any) => {
      if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.isAbort) return;
      setSettled({ request, error: e?.message || 'Failed to load team activity' });
    });
    return () => ctrl.abort();
  }, [request]);

  const isReady = summary !== null;

  // Filter & sort contributors
  const filteredContributors = useMemo(() => {
    if (!summary?.contributors) return [];
    let list = [...summary.contributors];
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      let valA: any = a.commitCount;
      let valB: any = b.commitCount;
      if (contributorSortBy === 'prs') {
        valA = a.authoredPRs;
        valB = b.authoredPRs;
      } else if (contributorSortBy === 'reviews') {
        valA = a.reviewsCount;
        valB = b.reviewsCount;
      } else if (contributorSortBy === 'name') {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      } else if (contributorSortBy === 'activity') {
        valA = a.lastActivity;
        valB = b.lastActivity;
      }
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [summary, debouncedSearch, contributorSortBy, sortOrder]);

  // Max daily count for chart scaling
  const maxDaily = useMemo(() => {
    if (!summary?.dailyStats?.length) return 1;
    return Math.max(1, ...summary.dailyStats.map(d => d.total));
  }, [summary]);

  const commitTotalPages = Math.max(1, Math.ceil(commitsTotal / pageSize));

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* 1. Header Metrics Top Strip */}
      <div className="p-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] shrink-0 space-y-3">
        <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              {t('summary.scopeLabel', {
                days,
                project: filters.selectedProject === 'all' ? t('projects.all', { ns: 'common' }) : filters.selectedProject
              })}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* Card 1: Total Commits */}
          <div className="p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
            <div className="text-[11px] font-medium text-slate-500 truncate">{t('summary.totalCommits')}</div>
            <div className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-1">
              {isReady ? summary.totalCommits : '—'}
            </div>
          </div>

          {/* Card 2: Active Contributors */}
          <div className="p-3 rounded-xl border border-brand-200/80 dark:border-brand-900/50 bg-brand-50/50 dark:bg-brand-950/20">
            <div className="text-[11px] font-medium text-brand-700 dark:text-brand-400 truncate">{t('summary.activeContributors')}</div>
            <div className="text-xl font-bold text-brand-700 dark:text-brand-300 mt-1">
              {isReady ? summary.activeContributors : '—'}
            </div>
          </div>

          {/* Card 3: Total PRs */}
          <div className="p-3 rounded-xl border border-indigo-200/80 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/20">
            <div className="text-[11px] font-medium text-indigo-700 dark:text-indigo-400 truncate">{t('summary.totalPRs')}</div>
            <div className="text-xl font-bold text-indigo-700 dark:text-indigo-300 mt-1">
              {isReady ? summary.totalPRs : '—'}
            </div>
          </div>

          {/* Card 4: Daily Period Selector */}
          <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 flex flex-col justify-between">
            <div className="text-[11px] font-medium text-slate-500">{t('filters.periodLabel')}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <button
                onClick={() => setDays(7)}
                className={`px-2.5 py-0.5 rounded text-xs font-semibold border transition-all ${
                  days === 7
                    ? 'border-brand-500 bg-white dark:bg-slate-800 text-brand-600 dark:text-brand-400 shadow-xs'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`}
              >
                {t('summary.period7d')}
              </button>
              <button
                onClick={() => setDays(30)}
                className={`px-2.5 py-0.5 rounded text-xs font-semibold border transition-all ${
                  days === 30
                    ? 'border-brand-500 bg-white dark:bg-slate-800 text-brand-600 dark:text-brand-400 shadow-xs'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`}
              >
                {t('summary.period30d')}
              </button>
            </div>
          </div>
        </div>

        {/* Daily Activity Trend Bar Chart */}
        {isReady && summary.dailyStats?.length > 0 && (
          <div data-testid="team-trend-chart" className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/40 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
              <span className="flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5 text-brand-500" />
                <span>{t('sections.activityTrend')} ({days} {days === 7 ? 'gün' : 'gün'})</span>
              </span>
              <div className="flex items-center gap-3 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-brand-500" />
                  <span className="text-slate-500">{t('columns.commits')}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-indigo-500" />
                  <span className="text-slate-500">PR</span>
                </div>
              </div>
            </div>

            <div className="h-20 flex items-end gap-1 pt-2 overflow-x-auto">
              {summary.dailyStats.map((d, i) => {
                const cPct = (d.commits / maxDaily) * 100;
                const pPct = (d.prs / maxDaily) * 100;

                return (
                  <div key={i} className="flex-1 min-w-[12px] flex flex-col items-center gap-1 h-full justify-end group relative">
                    <div className="w-full flex flex-col justify-end h-full">
                      {d.prs > 0 && (
                        <div
                          style={{ height: `${Math.max(4, pPct)}%` }}
                          className="w-full bg-indigo-500 rounded-t-xs"
                          title={`${d.date}: ${d.prs} PR`}
                        />
                      )}
                      {d.commits > 0 && (
                        <div
                          style={{ height: `${Math.max(4, cPct)}%` }}
                          className="w-full bg-brand-500 rounded-t-xs"
                          title={`${d.date}: ${d.commits} commits`}
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
      </div>

      {/* 2. Subviews Navigation & Search Toolbar */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-semibold">
          <button
            onClick={() => setActiveTab('contributors')}
            data-testid="tab-contributors"
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
              activeTab === 'contributors'
                ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>{t('sections.contributors')}</span>
          </button>

          <button
            onClick={() => setActiveTab('repositories')}
            data-testid="tab-repositories"
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
              activeTab === 'repositories'
                ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            <FolderGit2 className="w-3.5 h-3.5" />
            <span>{t('sections.repositories')}</span>
          </button>

          <button
            onClick={() => setActiveTab('commits')}
            data-testid="tab-commits"
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
              activeTab === 'commits'
                ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            <GitCommit className="w-3.5 h-3.5" />
            <span>{t('sections.recentCommits')}</span>
          </button>
        </div>

        {/* Search & Refresh */}
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

      {/* 3. Main Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 overflow-x-auto overflow-y-auto p-4 sm:p-5 flex flex-col">
          {loading && !summary ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="team-loading">
              <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">{t('empty.loading')}</span>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-6" role="alert" data-testid="team-error">
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
          ) : (
            <>
              {/* Tab 1: Contributors Table */}
              {activeTab === 'contributors' && (
                <div data-testid="contributors-view" className="min-w-[680px] bg-white dark:bg-[#0E131F] rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-[#0B0F17]/95 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
                        <th className="py-2.5 px-3.5 w-12 text-center text-slate-400 font-mono">#</th>
                        <th className="py-2.5 px-3">{t('columns.contributor')}</th>
                        <th
                          onClick={() => { setContributorSortBy('commits'); setSortOrder(o => o === 'desc' ? 'asc' : 'desc'); }}
                          className="py-2.5 px-3 text-center cursor-pointer hover:text-brand-600"
                          title={t('columns.commitsTooltip')}
                        >
                          {t('columns.commits')} {contributorSortBy === 'commits' ? (sortOrder === 'desc' ? '▼' : '▲') : ''}
                        </th>
                        <th
                          onClick={() => { setContributorSortBy('prs'); setSortOrder(o => o === 'desc' ? 'asc' : 'desc'); }}
                          className="py-2.5 px-3 text-center cursor-pointer hover:text-brand-600"
                        >
                          {t('columns.authoredPRs')} {contributorSortBy === 'prs' ? (sortOrder === 'desc' ? '▼' : '▲') : ''}
                        </th>
                        <th
                          onClick={() => { setContributorSortBy('reviews'); setSortOrder(o => o === 'desc' ? 'asc' : 'desc'); }}
                          className="py-2.5 px-3 text-center cursor-pointer hover:text-brand-600"
                        >
                          {t('columns.reviews')} {contributorSortBy === 'reviews' ? (sortOrder === 'desc' ? '▼' : '▲') : ''}
                        </th>
                        <th className="py-2.5 px-3 text-right">{t('columns.lastActivity')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                      {filteredContributors.map((c, i) => {
                        const isSelected = selectedContributor?.name === c.name;

                        return (
                          <tr
                            key={c.name}
                            onClick={() => setSelectedContributor(c)}
                            data-testid="contributor-row"
                            className={`cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-brand-50/70 dark:bg-brand-950/40 border-l-4 border-l-brand-600'
                                : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40 border-l-4 border-l-transparent'
                            }`}
                          >
                            <td className="py-2.5 px-3 text-center font-mono text-slate-400 text-xs">
                              {i + 1}
                            </td>

                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-2">
                                <div className="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center font-bold text-[10px]">
                                  {c.name.charAt(0)}
                                </div>
                                <div>
                                  <div className="font-semibold text-slate-900 dark:text-slate-100">{c.name}</div>
                                  {c.email && <div className="text-[10px] text-slate-400 font-mono">{c.email}</div>}
                                </div>
                              </div>
                            </td>

                            <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-800 dark:text-slate-200">
                              {c.commitCount}
                            </td>

                            <td className="py-2.5 px-3 text-center font-mono text-indigo-600 dark:text-indigo-400 font-semibold">
                              {c.authoredPRs}
                            </td>

                            <td className="py-2.5 px-3 text-center font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                              {c.reviewsCount}
                            </td>

                            <td className="py-2.5 px-3 text-right font-mono text-[11px] text-slate-500">
                              {c.lastActivity ? new Date(c.lastActivity).toLocaleDateString() : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Tab 2: Repositories Breakdown */}
              {activeTab === 'repositories' && summary && (
                <div data-testid="repositories-view" className="min-w-[680px] bg-white dark:bg-[#0E131F] rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-[#0B0F17]/95 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
                        <th className="py-2.5 px-3">{t('columns.repository')}</th>
                        <th className="py-2.5 px-3">{t('columns.project')}</th>
                        <th className="py-2.5 px-3 text-center">{t('columns.commits')}</th>
                        <th className="py-2.5 px-3 text-center">{t('columns.authoredPRs')}</th>
                        <th className="py-2.5 px-3 text-right">{t('columns.lastActivity')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                      {summary.repositories.map(r => (
                        <tr key={`${r.project}/${r.repository}`} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                          <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-slate-100 font-mono">
                            {r.repository}
                          </td>
                          <td className="py-2.5 px-3 text-slate-500">
                            {r.project}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-800 dark:text-slate-200">
                            {r.commitCount}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono text-indigo-600 dark:text-indigo-400 font-semibold">
                            {r.prCount}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-[11px] text-slate-500">
                            {r.lastActivity ? new Date(r.lastActivity).toLocaleDateString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Tab 3: Recent Commits Stream */}
              {activeTab === 'commits' && (
                <div data-testid="commits-view" className="space-y-2">
                  <div className="bg-white dark:bg-[#0E131F] rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-[#0B0F17]/95 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
                          <th className="py-2.5 px-3 w-24">Commit</th>
                          <th className="py-2.5 px-3">{t('columns.message')}</th>
                          <th className="py-2.5 px-3 w-40">{t('columns.contributor')}</th>
                          <th className="py-2.5 px-3 w-36">{t('columns.repository')}</th>
                          <th className="py-2.5 px-3 w-28 text-right">{t('columns.date')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                        {commits.map(c => (
                          <tr key={c.commitId} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                            <td className="py-2 px-3 font-mono font-bold text-brand-600 dark:text-brand-400">
                              {c.url ? (
                                <a href={c.url} target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-1">
                                  <span>{c.commitId.slice(0, 8)}</span>
                                  <ExternalLink className="w-3 h-3 text-slate-400" />
                                </a>
                              ) : (
                                c.commitId.slice(0, 8)
                              )}
                            </td>
                            <td className="py-2 px-3 text-slate-800 dark:text-slate-200 font-medium truncate max-w-md" title={c.comment}>
                              {c.comment}
                            </td>
                            <td className="py-2 px-3 text-slate-600 dark:text-slate-400 truncate">
                              {c.author}
                            </td>
                            <td className="py-2 px-3 font-mono text-[11px] text-slate-500 truncate">
                              {c.repository}
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-[11px] text-slate-500">
                              {c.date ? new Date(c.date).toLocaleDateString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Commits Pagination */}
                  {commitsTotal > pageSize && (
                    <div className="h-9 px-4 flex items-center justify-between text-xs text-slate-500 select-none">
                      <span>{commitsTotal} commit bulundu</span>
                      <div className="flex items-center gap-2">
                        <span>{commitPage} / {commitTotalPages}</span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setCommitPage(p => Math.max(1, p - 1))}
                            disabled={commitPage <= 1}
                            className="p-1 rounded border border-slate-200 dark:border-slate-800 disabled:opacity-30"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setCommitPage(p => Math.min(commitTotalPages, p + 1))}
                            disabled={commitPage >= commitTotalPages}
                            className="p-1 rounded border border-slate-200 dark:border-slate-800 disabled:opacity-30"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Right Detail Inspector Drawer for Contributor */}
        {selectedContributor && (
          <aside
            data-testid="contributor-drawer"
            className="w-80 min-w-[300px] border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] flex flex-col h-full z-10 p-4 space-y-4 select-text shrink-0 shadow-lg"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300 font-bold flex items-center justify-center text-xs">
                  {selectedContributor.name.charAt(0)}
                </div>
                <div>
                  <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">{selectedContributor.name}</h3>
                  {selectedContributor.email && <p className="text-[10px] text-slate-400 font-mono">{selectedContributor.email}</p>}
                </div>
              </div>
              <button
                onClick={() => setSelectedContributor(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">{t('columns.commits')}:</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">{selectedContributor.commitCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{t('columns.authoredPRs')}:</span>
                  <span className="font-bold text-indigo-600 dark:text-indigo-400">{selectedContributor.authoredPRs}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{t('columns.reviews')}:</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">{selectedContributor.reviewsCount}</span>
                </div>
                <div className="flex justify-between pt-1 border-t border-slate-200/50 dark:border-slate-800/50">
                  <span className="text-slate-500">{t('columns.lastActivity')}:</span>
                  <span className="font-mono text-slate-700 dark:text-slate-300">
                    {selectedContributor.lastActivity ? new Date(selectedContributor.lastActivity).toLocaleDateString() : '—'}
                  </span>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};
