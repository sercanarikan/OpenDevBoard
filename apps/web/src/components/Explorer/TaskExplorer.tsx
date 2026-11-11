import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Filter,
  ArrowUpDown,
  User,
  Inbox,
  AlertTriangle,
  RotateCcw,
  GitBranch,
  Calendar,
  Layers,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  X,
  ArrowDownLeft,
  ArrowUpRight
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { WorkItem } from '../../types';
import { usePagedList } from '../../hooks/usePagedList';
import { explorerListParams } from '../../utils/listParams';
import { WorkItemInspector } from './WorkItemInspector';
import { UserAvatar } from '../Common/UserAvatar';
import { formatDate as formatLocalizedDate } from '../../i18n/format';
import { stateLabel, priorityLabel } from '../../i18n/labels';

export const TaskExplorer: React.FC = () => {
  const { t, i18n } = useTranslation();
  const {
    filters,
    setFilters,
    resetFilters,
    selectedWorkItem,
    setSelectedWorkItem,
    openWorkItem,
    currentUserName,
    summary,
    booting
  } = useApp();

  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false);

  // Server-side pagination: only the visible page is ever downloaded. Search is debounced, any filter or sort
  // change returns to page 1 and stale responses are dropped (see hooks/usePagedList).
  const listParams = useMemo(
    () => explorerListParams({ filters, currentUser: currentUserName }),
    [filters, currentUserName]
  );
  const list = usePagedList(listParams, { initialPageSize: 50 });
  const rows: WorkItem[] = list.items;

  // Counters come from the same server definitions as the list itself (summary == list.total for the same filter).
  const scope = summary?.scope;
  const myTasksCount = scope?.myTasks ?? 0;
  const blockedCount = scope?.blocked ?? 0;
  const unassignedCount = scope?.unassigned ?? 0;
  const allCount = scope?.total ?? 0;

  // Navigating from the Inspector never touches the user's filters, page or search: the Inspector loads items by id
  // independently from whatever the list currently shows.
  const handleInspectorNavigate = (targetItem: WorkItem) => {
    setSelectedWorkItem(targetItem);
    void openWorkItem(targetItem.id);
  };

  // Facet options come from the server (whole scope), not from the loaded page.
  const availableTypes = useMemo(() => Object.keys(summary?.facets.types ?? {}).sort(), [summary]);
  const availableStates = useMemo(() => Object.keys(summary?.facets.states ?? {}).sort(), [summary]);

  const [openId, setOpenId] = useState('');
  const [openIdError, setOpenIdError] = useState<string | null>(null);
  const submitOpenId = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = Number(openId.replace(/[^\d]/g, ''));
    if (!id) return;
    setOpenIdError(null);
    const found = await openWorkItem(id);
    if (found) setOpenId('');
    else setOpenIdError(t('explorer.openByIdFailed', { id }));
  };

  const activeAdvancedFilterCount =
    filters.selectedTypes.length +
    filters.selectedStates.length +
    filters.selectedPriorities.length;

  const handleTypeToggle = (t: string) => {
    setFilters(prev => ({
      ...prev,
      selectedTypes: prev.selectedTypes.includes(t)
        ? prev.selectedTypes.filter(x => x !== t)
        : [...prev.selectedTypes, t]
    }));
  };

  const handleStateToggle = (s: string) => {
    setFilters(prev => ({
      ...prev,
      selectedStates: prev.selectedStates.includes(s)
        ? prev.selectedStates.filter(x => x !== s)
        : [...prev.selectedStates, s]
    }));
  };

  const handlePriorityToggle = (p: number) => {
    setFilters(prev => ({
      ...prev,
      selectedPriorities: prev.selectedPriorities.includes(p)
        ? prev.selectedPriorities.filter(x => x !== p)
        : [...prev.selectedPriorities, p]
    }));
  };

  // Type dot color helper
  const getTypeDot = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes('bug')) return 'bg-rose-500';
    if (t.includes('epic')) return 'bg-purple-500';
    if (t.includes('feature')) return 'bg-indigo-500';
    if (t.includes('story') || t.includes('pbi')) return 'bg-sky-500';
    return 'bg-emerald-500';
  };

  const formatDate = (isoString: string) => {
    if (!isoString) return '';
    return formatLocalizedDate(isoString, i18n.language?.startsWith('en') ? 'en' : 'tr');
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* 1. Compact KPI Tabs & Toolbar Header */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Compact KPI Tabs (My Tasks default) */}
          <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
            {/* My Tasks Tab (Default) */}
            <button
              onClick={() => setFilters(f => ({ ...f, quickFilter: 'my-tasks' }))}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                filters.quickFilter === 'my-tasks'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <User className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{t('explorer.myTasks')}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                filters.quickFilter === 'my-tasks'
                  ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                  : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}>
                {myTasksCount}
              </span>
            </button>

            {/* All Work Items Tab */}
            <button
              onClick={() => setFilters(f => ({ ...f, quickFilter: 'all' }))}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                filters.quickFilter === 'all'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-slate-500" />
              <span>{t('explorer.allWorkItems')}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                filters.quickFilter === 'all'
                  ? 'bg-brand-100 dark:bg-brand-950 text-brand-800 dark:text-brand-300'
                  : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}>
                {allCount}
              </span>
            </button>

            {/* Blocked Items Tab */}
            <button
              onClick={() => setFilters(f => ({ ...f, quickFilter: 'blocked' }))}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                filters.quickFilter === 'blocked'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
              <span>{t('explorer.blocked')}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                filters.quickFilter === 'blocked'
                  ? 'bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300'
                  : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}>
                {blockedCount}
              </span>
            </button>

            {/* Unassigned Pool Tab */}
            <button
              onClick={() => setFilters(f => ({ ...f, quickFilter: 'unassigned' }))}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                filters.quickFilter === 'unassigned'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Inbox className="w-3.5 h-3.5 text-amber-500" />
              <span>{t('explorer.unassigned')}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                filters.quickFilter === 'unassigned'
                  ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                  : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}>
                {unassignedCount}
              </span>
            </button>
          </div>

          {/* Right Action: Filter Status & Clear Button */}
          {(filters.searchQuery ||
            filters.selectedTypes.length > 0 ||
            filters.selectedStates.length > 0 ||
            filters.selectedPriorities.length > 0 ||
            filters.quickFilter !== 'my-tasks') && (
            <button
              onClick={resetFilters}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950/60 hover:bg-brand-100 rounded-md border border-brand-200 dark:border-brand-800 transition-colors"
              title={t('explorer.resetTitle')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('explorer.resetToMyTasks')}</span>
            </button>
          )}
        </div>

        {/* 2. Unified Search & Facet Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          {/* Main Search Input */}
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filters.searchQuery}
              onChange={e => setFilters(f => ({ ...f, searchQuery: e.target.value }))}
              placeholder={t('explorer.searchPlaceholder')}
              className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg pl-9 pr-8 py-1.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all"
            />
            {filters.searchQuery && (
              <button
                onClick={() => setFilters(f => ({ ...f, searchQuery: '' }))}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 rounded"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Right Filters Dropdown & Sorter */}
          <div className="flex items-center gap-2 text-xs">
            {/* Filters Menu Button */}
            <div className="relative">
              <button
                onClick={() => setIsFilterDropdownOpen(prev => !prev)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-semibold transition-colors ${
                  activeAdvancedFilterCount > 0 || isFilterDropdownOpen
                    ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
                    : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <Filter className="w-3.5 h-3.5" />
                <span>{t('explorer.filters')}</span>
                {activeAdvancedFilterCount > 0 && (
                  <span className="w-4 h-4 rounded-full bg-brand-600 text-white flex items-center justify-center text-[10px] font-bold">
                    {activeAdvancedFilterCount}
                  </span>
                )}
                <ChevronDown className="w-3 h-3 text-slate-400" />
              </button>

              {/* Filter Popover */}
              {isFilterDropdownOpen && (
                <div className="absolute right-0 top-full mt-2 w-72 p-4 rounded-xl bg-white dark:bg-[#111726] border border-slate-200 dark:border-slate-800 shadow-xl z-30 space-y-4 animate-in fade-in zoom-in-95 duration-100">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
                    <span className="font-semibold text-xs text-slate-900 dark:text-slate-100">{t('explorer.filterByProperties')}</span>
                    <button
                      onClick={() => setIsFilterDropdownOpen(false)}
                      className="p-1 text-slate-400 hover:text-slate-600 rounded"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Work Item Types */}
                  <div>
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      {t('explorer.type')}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {availableTypes.map(t => {
                        const sel = filters.selectedTypes.includes(t);
                        return (
                          <button
                            key={t}
                            onClick={() => handleTypeToggle(t)}
                            className={`px-2 py-1 rounded text-xs transition-colors ${
                              sel
                                ? 'bg-brand-600 text-white font-medium'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
                            }`}
                          >
                            {t}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* States */}
                  <div>
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      {t('explorer.state')}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {availableStates.map(s => {
                        const sel = filters.selectedStates.includes(s);
                        return (
                          <button
                            key={s}
                            onClick={() => handleStateToggle(s)}
                            className={`px-2 py-1 rounded text-xs transition-colors ${
                              sel
                                ? 'bg-brand-600 text-white font-medium'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
                            }`}
                          >
                            {stateLabel(t, s)}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Priorities */}
                  <div>
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      {t('explorer.priority')}
                    </span>
                    <div className="flex gap-1.5">
                      {[1, 2, 3, 4].map(p => {
                        const sel = filters.selectedPriorities.includes(p);
                        return (
                          <button
                            key={p}
                            onClick={() => handlePriorityToggle(p)}
                            className={`flex-1 py-1 rounded text-xs font-semibold transition-colors ${
                              sel
                                ? 'bg-brand-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
                            }`}
                          >
                            P{p}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Sorter */}
            <div className="flex items-center gap-1.5 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 text-xs font-medium">
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
              <select
                value={filters.sortBy}
                onChange={e => setFilters(f => ({ ...f, sortBy: e.target.value as any }))}
                aria-label={t('explorer.sortLabel')}
                className="bg-transparent text-xs text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
              >
                <option value="changedDate" className="bg-white dark:bg-slate-900">{t('explorer.sortChanged')}</option>
                <option value="priority" className="bg-white dark:bg-slate-900">{t('explorer.sortPriority')}</option>
                <option value="id" className="bg-white dark:bg-slate-900">{t('explorer.sortId')}</option>
                <option value="title" className="bg-white dark:bg-slate-900">{t('explorer.sortTitle')}</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Main Master-Detail Work Area */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Side: Modern Data Workspace Task Table */}
        <div className="flex-1 overflow-y-auto min-w-0">
          {booting || (list.loading && !list.data) ? (
            <div className="py-24 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="explorer-loading">
              <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{t('explorer.loading')}</span>
            </div>
          ) : list.error && !list.data ? (
            <div className="py-24 flex flex-col items-center justify-center text-center max-w-sm mx-auto px-4" data-testid="explorer-error" role="alert">
              <div className="w-12 h-12 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center text-rose-500 mb-3">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                {t('explorer.loadFailedTitle')}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                {t('explorer.loadFailedDesc')}
              </p>
              <button
                onClick={list.retry}
                data-testid="explorer-retry"
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-md transition-colors"
              >
                {t('explorer.retry')}
              </button>
            </div>
          ) : list.total === 0 ? (
            <div className="py-24 flex flex-col items-center justify-center text-center max-w-sm mx-auto px-4" data-testid="explorer-empty">
              <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
                <Search className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                {t('explorer.noMatchTitle')}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                {t('explorer.noMatchDesc')}
              </p>
              <button
                onClick={resetFilters}
                className="px-3.5 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950 rounded-md border border-brand-200 dark:border-brand-800"
              >
                {t('explorer.clearAll')}
              </button>
            </div>
          ) : (
            <div className="min-w-full" data-testid="explorer-list" aria-busy={list.loading}>
              {/* Aligned Table Column Headers */}
              <div className="sticky top-0 z-10 flex items-center px-5 py-2.5 bg-slate-100/90 dark:bg-[#0B0F17]/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none gap-4">
                <div className="flex-1 min-w-0">
                  {t('explorer.colWorkItem')}
                </div>
                <div className="w-20 sm:w-24 text-center shrink-0">
                  {t('explorer.colPriority')}
                </div>
                <div className="w-24 sm:w-28 text-center shrink-0">
                  {t('explorer.colState')}
                </div>
                {!selectedWorkItem && (
                  <div className="w-36 text-right shrink-0 hidden md:block">
                    {t('explorer.colAssignee')}
                  </div>
                )}
                {!selectedWorkItem && (
                  <div className="w-24 text-right shrink-0 hidden xl:block">
                    {t('explorer.colUpdated')}
                  </div>
                )}
              </div>

              {/* Task Rows */}
              <div className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#0E131F]">
                {rows.map(item => {
                  const isSelected = selectedWorkItem?.id === item.id;

                  return (
                    <div
                      key={item.id}
                      data-testid="explorer-row"
                      data-id={item.id}
                      onClick={() => setSelectedWorkItem(item)}
                      className={`flex items-center px-5 py-3.5 gap-4 cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-brand-50/70 dark:bg-brand-950/40 border-l-4 border-l-brand-600'
                          : 'hover:bg-slate-50/90 dark:hover:bg-slate-800/40 border-l-4 border-l-transparent'
                      }`}
                    >
                      {/* Work Item Column: Title, ID, Type dot, Parent breadcrumb */}
                      <div className="flex-1 min-w-0 pr-2">
                        {/* Parent breadcrumb */}
                        {item.parentTitle && (
                          <div className="flex items-center gap-1.5 min-w-0 text-xs text-slate-500 dark:text-slate-400 mb-1" title={item.parentTitle}>
                            <GitBranch className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span className="truncate min-w-0">{item.parentTitle}</span>
                          </div>
                        )}

                        {/* Title and ID */}
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full ${getTypeDot(item.type)} shrink-0`} />
                          <span className="font-mono text-xs font-bold text-slate-400 shrink-0">
                            #{item.id}
                          </span>
                          <h4
                            className="text-[14.5px] font-semibold text-slate-900 dark:text-slate-100 truncate min-w-0 leading-snug"
                            title={item.title}
                          >
                            {item.title}
                          </h4>
                        </div>

                        {/* Metadata row under title */}
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 min-w-0 mt-1 text-xs text-slate-500 dark:text-slate-400">
                          <span className="font-medium text-slate-600 dark:text-slate-400 truncate max-w-[180px]" title={item.project}>{item.project}</span>
                          <span className="shrink-0">•</span>
                          <span className="shrink-0">{item.type}</span>

                          {/* Blocked Badge */}
                          {item.isBlocked && (
                            <>
                              <span>•</span>
                              <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-bold whitespace-nowrap shrink-0">
                                <AlertTriangle className="w-3.5 h-3.5" /> {t('chip.blocked')}
                              </span>
                            </>
                          )}

                          {/* Dependencies summary */}
                          {item.relations?.predecessors?.length > 0 && (
                            <>
                              <span>•</span>
                              <span className="font-mono text-indigo-600 dark:text-indigo-400 flex items-center gap-0.5 whitespace-nowrap shrink-0">
                                <ArrowDownLeft className="w-3 h-3" />
                                {item.relations.predecessors.length} {t('chip.pred')}
                              </span>
                            </>
                          )}
                          {item.relations?.successors?.length > 0 && (
                            <>
                              <span>•</span>
                              <span className="font-mono text-cyan-600 dark:text-cyan-400 flex items-center gap-0.5 whitespace-nowrap shrink-0">
                                <ArrowUpRight className="w-3 h-3" />
                                {item.relations.successors.length} {t('chip.succ')}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Priority Column */}
                      <div className="w-20 sm:w-24 text-center shrink-0">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${
                          item.priority === 1
                            ? 'text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/50'
                            : item.priority === 2
                            ? 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50'
                            : 'text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800'
                        }`}>
                          {priorityLabel(t, item.priority)}
                        </span>
                      </div>

                      {/* State Column */}
                      <div className="w-24 sm:w-28 text-center shrink-0">
                        <span
                          className="inline-flex max-w-full px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                          title={stateLabel(t, item.state)}
                        >
                          <span className="truncate">{stateLabel(t, item.state)}</span>
                        </span>
                      </div>

                      {/* Assignee Column (visible when full width) */}
                      {!selectedWorkItem && (
                        <div className="w-36 text-right shrink-0 hidden md:flex items-center justify-end gap-1.5 truncate text-xs">
                          {item.isUnassigned ? (
                            <span className="text-amber-600 dark:text-amber-400 font-semibold inline-flex items-center gap-1">
                              <Inbox className="w-3.5 h-3.5" /> {t('fields.unassigned', { ns: 'common' })}
                            </span>
                          ) : (
                            <div className="flex items-center gap-1.5 truncate">
                              <UserAvatar
                                name={item.assignedTo}
                                avatarUrl={item.assignedAvatar}
                                size="sm"
                                className="w-5 h-5 text-[10px]"
                              />
                              <span className="truncate text-slate-800 dark:text-slate-200 font-medium text-xs">
                                {item.assignedTo}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Updated Date (visible when full width) */}
                      {!selectedWorkItem && (
                        <div className="w-24 text-right shrink-0 hidden xl:flex items-center justify-end gap-1 text-slate-400 text-xs font-mono">
                          <Calendar className="w-3 h-3 text-slate-400" />
                          <span>{formatDate(item.changedDate)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right Side: Work Item Inspector */}
        {selectedWorkItem && (
          <WorkItemInspector
            item={selectedWorkItem}
            onClose={() => setSelectedWorkItem(null)}
            onNavigateToItem={handleInspectorNavigate}
          />
        )}
      </div>

      {/* 4. Footer Status Bar */}
      <div
        className="min-h-9 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] px-5 py-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400 select-none shrink-0"
        data-testid="explorer-footer"
      >
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <span data-testid="explorer-range" className="whitespace-nowrap">
            {list.total === 0
              ? t('explorer.footerPagedEmpty')
              : t('explorer.footerPaged', {
                  from: list.offset + 1,
                  to: list.offset + rows.length,
                  total: list.total
                })}
          </span>
          {(list.loading || list.debouncing) && list.data && (
            <span className="inline-flex items-center gap-1.5 text-brand-600 dark:text-brand-400" data-testid="explorer-updating">
              <span className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              {t('explorer.updating')}
            </span>
          )}
          {list.error && list.data && (
            <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400" role="alert" data-testid="explorer-error-inline">
              {t('explorer.loadFailedTitle')}
              <button onClick={list.retry} className="underline font-semibold" data-testid="explorer-retry">
                {t('explorer.retry')}
              </button>
            </span>
          )}
          {filters.selectedProject !== 'all' && (
            <span className="hidden md:inline">• {t('explorer.footerProject')}: <strong>{filters.selectedProject}</strong></span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <form onSubmit={submitOpenId} className="hidden xl:flex items-center gap-1" aria-label={t('explorer.openById')}>
            <input
              type="text"
              inputMode="numeric"
              value={openId}
              onChange={e => { setOpenId(e.target.value); setOpenIdError(null); }}
              placeholder={t('explorer.openByIdPlaceholder')}
              aria-label={t('explorer.openById')}
              data-testid="explorer-open-id"
              className="w-20 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded px-2 py-0.5 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {openIdError && (
              <span className="text-rose-600 dark:text-rose-400" role="alert" data-testid="explorer-open-id-error">{openIdError}</span>
            )}
          </form>

          <select
            value={list.limit}
            onChange={e => list.setPageSize(Number(e.target.value))}
            aria-label={t('explorer.pageSize')}
            data-testid="explorer-page-size"
            className="bg-transparent border border-slate-200 dark:border-slate-800 rounded px-1.5 py-0.5 text-xs text-slate-700 dark:text-slate-300 focus:outline-none cursor-pointer"
          >
            {[25, 50, 100, 200].map(n => (
              <option key={n} value={n} className="bg-white dark:bg-slate-900">{t('explorer.pageSizeOption', { count: n })}</option>
            ))}
          </select>

          <div className="flex items-center gap-0.5" role="navigation" aria-label={t('explorer.pageLabel', { page: list.page, pages: list.totalPages })}>
            <button
              onClick={() => list.goToPage(1)}
              disabled={list.page <= 1}
              aria-label={t('explorer.firstPage')}
              title={t('explorer.firstPage')}
              data-testid="explorer-first"
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronsLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => list.goToPage(list.page - 1)}
              disabled={list.page <= 1}
              aria-label={t('explorer.prevPage')}
              title={t('explorer.prevPage')}
              data-testid="explorer-prev"
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 font-mono text-[11px] text-slate-700 dark:text-slate-300 whitespace-nowrap" data-testid="explorer-page">
              {t('explorer.pageLabel', { page: list.page, pages: list.totalPages })}
            </span>
            <button
              onClick={() => list.goToPage(list.page + 1)}
              disabled={list.page >= list.totalPages}
              aria-label={t('explorer.nextPage')}
              title={t('explorer.nextPage')}
              data-testid="explorer-next"
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => list.goToPage(list.totalPages)}
              disabled={list.page >= list.totalPages}
              aria-label={t('explorer.lastPage')}
              title={t('explorer.lastPage')}
              data-testid="explorer-last"
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronsRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
