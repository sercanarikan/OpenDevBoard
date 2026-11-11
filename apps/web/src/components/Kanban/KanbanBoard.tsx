import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Filter,
  ArrowUpDown,
  User,
  Inbox,
  AlertTriangle,
  RotateCcw,
  Layers,
  ChevronDown,
  X,
  ChevronRight,
  ChevronLeft,
  FolderGit2,
  ChevronsLeft,
  ChevronsRight,
  Maximize2,
  Minimize2,
  GitFork,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { WorkItem } from '../../types';
import type { KanbanLane, KanbanParams, KanbanResponse } from '../../types/paging';
import { WorkItemInspector } from '../Explorer/WorkItemInspector';
import { TypeBadge, PriorityBadge } from '../Common/Badge';
import { UserAvatar } from '../Common/UserAvatar';
import {
  KANBAN_COLUMNS,
  type KanbanColumnId,
  type KanbanSwimlaneMode,
  type KanbanSortBy
} from '../../utils/kanbanEngine';
import { kanbanParams } from '../../utils/listParams';
import { kanbanScopeSplit } from '../../utils/layout';
import { useKanban, remainingCount } from '../../hooks/useKanban';

const renderedCount = (lane: KanbanLane): number =>
  KANBAN_COLUMNS.reduce((n, col) => n + (lane.columns[col.id]?.length ?? 0), 0);

/** Scope total of a column: the whole board column in the standard view, the lane's own count inside a lane. */
const columnTotal = (board: KanbanResponse, lane: KanbanLane, colId: KanbanColumnId): number =>
  board.laneMode === 'none' ? board.columns[colId] : lane.counts[colId];

export const KanbanBoard: React.FC = () => {
  const { t } = useTranslation(['kanban', 'common']);
  const {
    filters,
    setFilters,
    resetFilters,
    selectedWorkItem,
    setSelectedWorkItem,
    openWorkItem,
    currentUserName,
    summary,
    density,
    toggleDensity
  } = useApp();

  // Kanban view customization states
  const [swimlaneMode, setSwimlaneMode] = useState<KanbanSwimlaneMode>('none');
  const [collapsedColumns, setCollapsedColumns] = useState<Set<KanbanColumnId>>(new Set());
  const [collapsedSwimlanes, setCollapsedSwimlanes] = useState<Set<string>>(new Set());
  const cardDensity = density;
  const [hideCompleted, setHideCompleted] = useState<boolean>(false);
  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState<boolean>(false);
  const [sortBy, setSortBy] = useState<KanbanSortBy>('priority');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const boardParams = useMemo<KanbanParams>(
    () =>
      kanbanParams(
        { filters: { ...filters, sortBy, sortOrder }, currentUser: currentUserName },
        { swimlane: swimlaneMode, hideCompleted }
      ),
    [filters, sortBy, sortOrder, currentUserName, swimlaneMode, hideCompleted]
  );

  const {
    board,
    updating,
    error,
    retry,
    loadMoreCards,
    loadMoreLanes,
    cellStatus,
    lanesStatus,
    canLoadMoreLanes
  } = useKanban(boardParams);

  // Tab counters: the same numbers the sidebar and Task Explorer show.
  const myTasksCount = summary?.scope.myTasks ?? 0;
  const blockedCount = summary?.scope.blocked ?? 0;
  const unassignedCount = summary?.scope.unassigned ?? 0;
  const allCount = summary?.scope.total ?? 0;

  // Facet options come from the server summary (same scope as the list endpoints).
  const availableTypes = useMemo(() => Object.keys(summary?.facets.types ?? {}).sort(), [summary]);
  const availableStates = useMemo(() => Object.keys(summary?.facets.states ?? {}).sort(), [summary]);
  const availablePriorities = useMemo(
    () => Object.keys(summary?.facets.priorities ?? {}).map(Number).sort((a, b) => a - b),
    [summary]
  );

  const laneMode: KanbanSwimlaneMode = board?.laneMode ?? swimlaneMode;
  const lanesRemaining = board ? Math.max(0, board.laneTotal - board.lanes.length) : 0;
  const shownCards = board ? board.lanes.reduce((n, lane) => n + renderedCount(lane), 0) : 0;
  const scopeSplit = kanbanScopeSplit(board?.total ?? 0, board?.columns.done ?? 0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 10);
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    checkScroll();
    const handleResize = () => checkScroll();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [checkScroll, board, selectedWorkItem]);

  // Toggle column collapse
  const toggleColumnCollapse = (colId: KanbanColumnId) => {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      if (next.has(colId)) {
        next.delete(colId);
      } else {
        next.add(colId);
      }
      return next;
    });
  };

  // Toggle swimlane collapse
  const toggleSwimlaneCollapse = (laneId: string) => {
    setCollapsedSwimlanes(prev => {
      const next = new Set(prev);
      if (next.has(laneId)) {
        next.delete(laneId);
      } else {
        next.add(laneId);
      }
      return next;
    });
  };

  const activeAdvancedFilterCount =
    filters.selectedTypes.length +
    filters.selectedStates.length +
    filters.selectedPriorities.length +
    (hideCompleted ? 1 : 0);

  const handleTypeToggle = (type: string) => {
    setFilters(prev => ({
      ...prev,
      selectedTypes: prev.selectedTypes.includes(type)
        ? prev.selectedTypes.filter(x => x !== type)
        : [...prev.selectedTypes, type]
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

  const getColTitle = (colId: KanbanColumnId, fallback: string) => {
    const map: Record<KanbanColumnId, string> = {
      todo: t('columns.todo'),
      'in-progress': t('columns.inProgress'),
      resolved: t('columns.resolved'),
      done: t('columns.done')
    };
    return map[colId] || fallback;
  };

  const getColShortTitle = (colId: KanbanColumnId, fallback: string) => {
    const map: Record<KanbanColumnId, string> = {
      todo: t('columns.todoShort'),
      'in-progress': t('columns.inProgressShort'),
      resolved: t('columns.resolvedShort'),
      done: t('columns.doneShort')
    };
    return map[colId] || fallback;
  };

  const renderCard = (item: WorkItem) => {
    const isSelected = selectedWorkItem?.id === item.id;

    if (cardDensity === 'compact') {
      // High-density Compact Card
      return (
        <div
          key={item.id}
          data-testid="kanban-card"
          data-id={item.id}
          onClick={() => setSelectedWorkItem(item)}
          className={`p-2.5 rounded-lg border transition-all cursor-pointer group select-none space-y-1.5 ${
            isSelected
              ? 'bg-brand-50/50 dark:bg-brand-950/30 border-brand-500 dark:border-brand-500 ring-2 ring-brand-500/80 shadow-xs'
              : item.isBlocked
              ? 'bg-white dark:bg-[#141B2D] border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 border-l-4 border-l-rose-500 hover:shadow-xs'
              : 'bg-white dark:bg-[#141B2D] border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-xs'
          }`}
        >
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5 truncate">
              <span className="font-mono text-[11px] font-bold text-slate-500 group-hover:text-brand-600 dark:group-hover:text-brand-400">
                #{item.id}
              </span>
              <span className="text-slate-300 dark:text-slate-700">•</span>
              <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400">
                {item.title}
              </h4>
            </div>
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                item.priority === 1 ? 'bg-rose-500' : item.priority === 2 ? 'bg-amber-500' : 'bg-slate-400'
              }`}
              title={t('cards.priorityTitle', { priority: item.priority })}
            />
          </div>

          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span className="truncate max-w-[120px] font-medium text-slate-500">{item.type}</span>
            {item.isBlocked ? (
              <span className="text-rose-600 dark:text-rose-400 font-semibold flex items-center gap-0.5">
                <AlertTriangle className="w-2.5 h-2.5" /> {t('chip.blocked', { ns: 'common' })}
              </span>
            ) : item.isUnassigned ? (
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                {t('fields.unassigned', { ns: 'common' })}
              </span>
            ) : (
              <span className="truncate max-w-[100px] text-slate-600 dark:text-slate-300">{item.assignedTo}</span>
            )}
          </div>
        </div>
      );
    }

    // Comfortable Full Card
    return (
      <div
        key={item.id}
        data-testid="kanban-card"
        data-id={item.id}
        onClick={() => setSelectedWorkItem(item)}
        className={`p-3.5 rounded-xl border transition-all cursor-pointer group select-none space-y-2.5 ${
          isSelected
            ? 'bg-brand-50/40 dark:bg-brand-950/30 border-brand-500 dark:border-brand-500 ring-2 ring-brand-500/80 shadow-xs'
            : item.isBlocked
            ? 'bg-white dark:bg-[#141B2D] border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 border-l-4 border-l-rose-500 hover:shadow-xs'
            : item.priority === 1
            ? 'bg-white dark:bg-[#141B2D] border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 border-l-4 border-l-amber-500/70 hover:shadow-xs'
            : 'bg-white dark:bg-[#141B2D] border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-xs'
        }`}
      >
        {/* Top Row: Type, ID, Priority Badge */}
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0 max-w-full">
            <span className="min-w-0 max-w-[11rem] overflow-hidden [&>span]:max-w-full [&>span>span:last-child]:truncate" title={item.type}>
              <TypeBadge type={item.type} size="sm" />
            </span>
            <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400 group-hover:text-brand-600 dark:group-hover:text-brand-400 shrink-0">
              #{item.id}
            </span>
          </div>
          <span className="shrink-0 ml-auto">
            <PriorityBadge priority={item.priority} />
          </span>
        </div>

        {/* Title */}
        <h4
          className="text-xs sm:text-[13px] font-semibold text-slate-900 dark:text-slate-100 line-clamp-2 leading-snug group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors"
          title={item.title}
        >
          {item.title}
        </h4>

        {/* Parent Story/PBI Breadcrumb */}
        {item.parentTitle && (
          <div
            onClick={e => {
              if (item.parentId) {
                e.stopPropagation();
                void openWorkItem(item.parentId);
              }
            }}
            className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1 truncate hover:text-brand-600 dark:hover:text-brand-400 transition-colors cursor-pointer"
            title={t('cards.parentTitle', { title: item.parentTitle })}
          >
            <span className="text-slate-400 shrink-0">↳</span>
            <span className="truncate">{item.parentTitle}</span>
          </div>
        )}

        {/* Dependency / Blocked Indicators */}
        {(item.isBlocked ||
          item.isBlocking ||
          item.relations?.predecessors?.length > 0 ||
          item.relations?.successors?.length > 0) && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center gap-1.5 flex-wrap text-[10px]">
            {item.isBlocked && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60">
                <AlertTriangle className="w-2.5 h-2.5" /> {t('chip.blocked', { ns: 'common' })}
              </span>
            )}
            {item.isBlocking && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-200 dark:border-amber-900/60">
                {t('cards.blocking')}
              </span>
            )}
            {item.relations?.predecessors?.length > 0 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-mono text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800">
                <ArrowDownLeft className="w-2.5 h-2.5" />
                {item.relations.predecessors.length} {t('chip.pred', { ns: 'common' })}
              </span>
            )}
            {item.relations?.successors?.length > 0 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-mono text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-950/40">
                <ArrowUpRight className="w-2.5 h-2.5" />
                {item.relations.successors.length} {t('chip.succ', { ns: 'common' })}
              </span>
            )}
          </div>
        )}

        {/* Card Footer: Project & Assignee */}
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] gap-2">
          <div className="flex items-center gap-1.5 min-w-0 truncate text-slate-400">
            <FolderGit2 className="w-3 h-3 shrink-0" />
            <span className="truncate">{item.project}</span>
          </div>

          <div className="shrink-0 flex items-center">
            {item.isUnassigned ? (
              <span className="text-amber-600 dark:text-amber-400 font-semibold inline-flex items-center gap-1 whitespace-nowrap">
                <Inbox className="w-3 h-3" /> {t('fields.unassigned', { ns: 'common' })}
              </span>
            ) : (
              <div className="flex items-center gap-1.5 whitespace-nowrap" title={item.assignedTo}>
                <UserAvatar name={item.assignedTo} avatarUrl={item.assignedAvatar} size="xs" showTooltip={false} />
                <span className="truncate text-slate-700 dark:text-slate-300 max-w-[110px] font-medium text-xs">
                  {item.assignedTo}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const spinner = (
    <div className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
  );

  const renderBody = () => {
    if (!board) {
      if (error) {
        return (
          <div
            data-testid="kanban-error"
            className="py-24 flex flex-col items-center justify-center text-center gap-3 text-slate-500 dark:text-slate-400"
          >
            <AlertTriangle className="w-6 h-6 text-rose-500" />
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{t('error.boardLoadFailed')}</span>
            <button
              type="button"
              data-testid="kanban-retry"
              onClick={retry}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950 rounded-md border border-brand-200 dark:border-brand-800 hover:bg-brand-100 dark:hover:bg-brand-900 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              {t('error.retry')}
            </button>
          </div>
        );
      }
      return (
        <div className="py-24 flex flex-col items-center justify-center text-slate-400 gap-3">
          <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-medium">{t('loading')}</span>
        </div>
      );
    }

    if (board.total === 0) {
      return (
        <div className="py-24 flex flex-col items-center justify-center text-center max-w-sm mx-auto px-4">
          <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
            <Search className="w-5 h-5" />
          </div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">{t('empty.noMatchTitle')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">{t('empty.noMatchDesc')}</p>
          <button
            onClick={() => {
              resetFilters();
              setHideCompleted(false);
            }}
            className="px-3.5 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950 rounded-md border border-brand-200 dark:border-brand-800 hover:bg-brand-100 dark:hover:bg-brand-900 transition-colors"
          >
            {t('empty.resetFilters')}
          </button>
        </div>
      );
    }

    return (
      <>
        {error && (
          <div
            data-testid="kanban-error"
            className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
          >
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('error.boardLoadFailed')}
            </span>
            <button
              type="button"
              data-testid="kanban-retry"
              onClick={retry}
              className="font-semibold hover:underline"
            >
              {t('error.retry')}
            </button>
          </div>
        )}

        <div data-testid="kanban-board" className="min-w-full w-max lg:w-full flex flex-col gap-4 flex-1">
          {board.lanes.map(lane => {
            const isLaneCollapsed = collapsedSwimlanes.has(lane.id);
            const laneRendered = renderedCount(lane);
            const laneSubtitle = lane.project ? (lane.type ? `${lane.project} • ${lane.type}` : lane.project) : lane.type;

            return (
              <div
                key={lane.id}
                data-testid="kanban-lane"
                data-lane-key={lane.key}
                className={`flex flex-col ${
                  laneMode === 'none'
                    ? 'flex-1 h-full'
                    : 'rounded-xl border border-slate-200/90 dark:border-slate-800/90 bg-white/60 dark:bg-[#0E1422]/60 backdrop-blur-xs overflow-hidden shadow-2xs'
                }`}
              >
                {/* Swimlane Header (rendered if swimlaneMode is not 'none') */}
                {laneMode !== 'none' && (
                  <div
                    onClick={() => toggleSwimlaneCollapse(lane.id)}
                    className="px-4 py-2.5 bg-slate-100/80 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between cursor-pointer hover:bg-slate-200/60 dark:hover:bg-slate-800/80 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 truncate min-w-0">
                      {isLaneCollapsed ? (
                        <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                      )}
                      <span className="font-semibold text-xs text-slate-900 dark:text-slate-100 truncate">
                        {lane.title}
                      </span>
                      {laneSubtitle && (
                        <span className="text-[11px] text-slate-400 font-normal truncate hidden sm:inline">
                          • {laneSubtitle}
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-slate-200/80 dark:bg-slate-700/80 text-slate-700 dark:text-slate-300">
                        {t('swimlanes.visibleCards', { count: laneRendered })}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hidden md:inline">
                        {t('swimlanes.totalCards', { count: lane.total })}
                      </span>
                    </div>

                    {/* Canonical Progress in Swimlane Header */}
                    {lane.progress && (
                      <div className="flex items-center gap-3 shrink-0 text-xs">
                        <span className="text-[11px] text-slate-600 dark:text-slate-300 font-mono font-medium">
                          {t('swimlanes.completedOfUnits', {
                            completed: lane.progress.completedUnits,
                            total: lane.progress.totalUnits,
                            percent: lane.progress.percent
                          })}
                        </span>
                        <div className="w-20 sm:w-28 bg-slate-200 dark:bg-slate-700 rounded-full h-1.5 overflow-hidden hidden sm:block">
                          <div
                            className="bg-emerald-500 h-full rounded-full transition-all"
                            style={{ width: `${lane.progress.percent}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Swimlane Columns Content */}
                {!isLaneCollapsed && (
                  <div className={`flex gap-3 w-full min-w-0 ${laneMode === 'none' ? 'flex-1' : 'p-3'}`}>
                    {KANBAN_COLUMNS.map(col => {
                      const colItems = lane.columns[col.id] ?? [];
                      const isColCollapsed = collapsedColumns.has(col.id);
                      const total = columnTotal(board, lane, col.id);
                      const remaining = remainingCount(total, colItems.length);
                      const cell = cellStatus(lane.key, col.id);
                      const colTitle = getColTitle(col.id, col.title);

                      if (isColCollapsed) {
                        // Collapsed Column Strip (Space Saver)
                        return (
                          <div
                            key={col.id}
                            data-testid="kanban-column"
                            data-column={col.id}
                            onClick={() => toggleColumnCollapse(col.id)}
                            className="w-11 sm:w-12 rounded-xl bg-slate-100/90 dark:bg-[#111726] border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 flex flex-col items-center py-3.5 cursor-pointer select-none transition-all group shrink-0"
                            title={t('columns.expandTitle', { title: colTitle, count: total })}
                          >
                            <div className="flex flex-col items-center gap-2 mb-3">
                              <span className={`w-2.5 h-2.5 rounded-full ${col.dotColor}`} />
                              <span
                                className={`text-[11px] font-mono font-bold px-1.5 py-0.2 rounded-full ${col.badgeBg} ${col.badgeText}`}
                              >
                                {total}
                              </span>
                            </div>

                            <div className="flex-1 flex items-center justify-center py-4">
                              <span
                                className="text-[11px] font-bold text-slate-600 dark:text-slate-400 tracking-wider uppercase whitespace-nowrap transform -rotate-90 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors"
                                style={{ transformOrigin: 'center center' }}
                              >
                                {getColShortTitle(col.id, col.shortTitle)}
                              </span>
                            </div>

                            <button
                              aria-label={t('columns.expandNamed', { title: colTitle })}
                              className="mt-2 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200 transition-colors"
                            >
                              <ChevronsRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      }

                      // Expanded Full Column
                      return (
                        <div
                          key={col.id}
                          data-testid="kanban-column"
                          data-column={col.id}
                          className="flex-1 basis-0 min-w-[240px] max-w-[min(460px,100%)] flex flex-col rounded-xl bg-slate-100/80 dark:bg-[#111728] border border-slate-200/90 dark:border-slate-800/90 overflow-hidden shadow-2xs transition-all shrink h-full"
                        >
                          {/* Column Header */}
                          <div
                            className={`p-2.5 px-3 border-b border-slate-200 dark:border-slate-800/90 ${col.headerBg} border-t-2 ${col.accentBorder} flex items-center justify-between`}
                          >
                            <div className="flex items-center gap-2 truncate min-w-0">
                              <span className={`w-2.5 h-2.5 rounded-full ${col.dotColor} shrink-0`} />
                              <span className="font-bold text-xs text-slate-900 dark:text-slate-100 truncate">
                                {colTitle}
                              </span>
                              <span
                                data-testid="kanban-column-count"
                                title={col.id === 'done' ? t('filters.doneBadgeTitle') : undefined}
                                className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${col.badgeBg} ${col.badgeText}`}
                              >
                                {total}
                              </span>
                            </div>

                            {/* Collapse Column Button */}
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                toggleColumnCollapse(col.id);
                              }}
                              title={t('columns.collapse')}
                              aria-label={t('columns.collapseNamed', { title: colTitle })}
                              className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
                            >
                              <ChevronsLeft className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {/* Column Cards Container (Vertical Scroll) */}
                          <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5 max-h-[calc(100vh-230px)]">
                            {colItems.length === 0 ? (
                              <div className="py-12 flex flex-col items-center justify-center text-center px-4">
                                <span className="text-xs text-slate-400 dark:text-slate-500 italic">
                                  {t('emptyColumn')}
                                </span>
                              </div>
                            ) : (
                              colItems.map(renderCard)
                            )}
                          </div>

                          {/* Column Footer: continuation of this lane-column */}
                          {remaining > 0 && (
                            <div className="p-2 border-t border-slate-200 dark:border-slate-800/90 bg-white/50 dark:bg-[#0E1422]/60">
                              {cell.error ? (
                                <div className="flex items-center justify-between gap-2 text-[11px] text-rose-600 dark:text-rose-400">
                                  <span className="truncate">{t('error.loadMoreFailed')}</span>
                                  <button
                                    type="button"
                                    data-testid="kanban-retry"
                                    data-lane-key={lane.key}
                                    data-column={col.id}
                                    onClick={() => loadMoreCards(lane.key, col.id)}
                                    className="font-semibold hover:underline shrink-0"
                                  >
                                    {t('error.retry')}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  data-testid="kanban-load-more"
                                  data-lane-key={lane.key}
                                  data-column={col.id}
                                  disabled={cell.loading}
                                  aria-label={t('cards.loadMoreAria', { lane: lane.title, column: colTitle })}
                                  onClick={() => loadMoreCards(lane.key, col.id)}
                                  className="w-full py-1.5 rounded-md text-[11px] font-semibold text-brand-700 dark:text-brand-300 bg-white dark:bg-[#141B2D] border border-slate-200 dark:border-slate-700 hover:bg-brand-50 dark:hover:bg-brand-950 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
                                >
                                  {cell.loading && spinner}
                                  <span>{t('cards.loadMore', { remaining })}</span>
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Next lane window */}
          {canLoadMoreLanes && (
            <div className="flex flex-col items-center gap-2 pb-2">
              {lanesStatus.error && (
                <span data-testid="kanban-error" className="text-[11px] text-rose-600 dark:text-rose-400">
                  {t('error.loadMoreFailed')}
                </span>
              )}
              <button
                type="button"
                data-testid="kanban-lane-more"
                disabled={lanesStatus.loading}
                onClick={loadMoreLanes}
                aria-label={t('swimlanes.loadMoreLanes', { remaining: lanesRemaining })}
                className="px-3.5 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950 rounded-md border border-brand-200 dark:border-brand-800 hover:bg-brand-100 dark:hover:bg-brand-900 disabled:opacity-60 transition-colors flex items-center gap-2"
              >
                {lanesStatus.loading && spinner}
                <span>{t('swimlanes.loadMoreLanes', { remaining: lanesRemaining })}</span>
              </button>
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* 1. Header Toolbar with KPI Tabs & Controls */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* KPI Tabs: My Tasks (default), All, Blocked, Unassigned */}
          <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
            {/* My Tasks Tab */}
            <button
              onClick={() => setFilters(f => ({ ...f, quickFilter: 'my-tasks' }))}
              title={t('filters.tabCountTitle')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                filters.quickFilter === 'my-tasks'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <User className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{t('filters.myTasks')}</span>
              <span
                className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                  filters.quickFilter === 'my-tasks'
                    ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                    : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                }`}
              >
                {myTasksCount}
              </span>
            </button>

            {/* All Work Items Tab */}
            <button
              onClick={() => setFilters(f => ({ ...f, quickFilter: 'all' }))}
              title={t('filters.tabCountTitle')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                filters.quickFilter === 'all'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-slate-500" />
              <span>{t('filters.allWorkItems')}</span>
              <span
                className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                  filters.quickFilter === 'all'
                    ? 'bg-brand-100 dark:bg-brand-950 text-brand-800 dark:text-brand-300'
                    : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                }`}
              >
                {allCount}
              </span>
            </button>

            {/* Blocked Items Tab */}
            <button
              onClick={() => setFilters(f => ({ ...f, quickFilter: 'blocked' }))}
              title={t('filters.tabCountTitle')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                filters.quickFilter === 'blocked'
                  ? 'bg-white dark:bg-[#161F2E] text-rose-700 dark:text-rose-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
              <span>{t('filters.blocked')}</span>
              <span
                className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                  filters.quickFilter === 'blocked'
                    ? 'bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300'
                    : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                }`}
              >
                {blockedCount}
              </span>
            </button>

            {/* Unassigned Pool Tab */}
            <button
              onClick={() => setFilters(f => ({ ...f, quickFilter: 'unassigned' }))}
              title={t('filters.tabCountTitle')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                filters.quickFilter === 'unassigned'
                  ? 'bg-white dark:bg-[#161F2E] text-amber-700 dark:text-amber-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Inbox className="w-3.5 h-3.5 text-amber-500" />
              <span>{t('filters.unassigned')}</span>
              <span
                className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                  filters.quickFilter === 'unassigned'
                    ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                    : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                }`}
              >
                {unassignedCount}
              </span>
            </button>
          </div>

          {/* Right Toolbar Controls: Search, Filters, Swimlane, Sort, Density */}
          <div className="flex items-center flex-wrap gap-2">
            {/* Search Box */}
            <div className="relative w-40 sm:w-52 xl:w-64 min-w-0">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder={t('filters.searchPlaceholder')}
                value={filters.searchQuery}
                onChange={e => setFilters(f => ({ ...f, searchQuery: e.target.value }))}
                className="w-full pl-8 pr-7 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all"
              />
              {filters.searchQuery && (
                <button
                  onClick={() => setFilters(f => ({ ...f, searchQuery: '' }))}
                  aria-label={t('filters.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Swimlanes Selector */}
            <div className="flex items-center gap-1.5 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 text-xs font-medium min-w-0 max-w-full">
              <GitFork className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="text-slate-400 hidden xl:inline shrink-0">{t('swimlanes.mode')}:</span>
              <select
                value={swimlaneMode}
                onChange={e => setSwimlaneMode(e.target.value as KanbanSwimlaneMode)}
                aria-label={t('swimlanes.selectMode')}
                className="bg-transparent text-xs text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer font-semibold min-w-0 max-w-[160px] truncate"
              >
                <option value="none" className="bg-white dark:bg-slate-900">{t('swimlanes.none')}</option>
                <option value="parent" className="bg-white dark:bg-slate-900">{t('swimlanes.parent')}</option>
                <option value="assignee" className="bg-white dark:bg-slate-900">{t('swimlanes.assignee')}</option>
                <option value="priority" className="bg-white dark:bg-slate-900">{t('swimlanes.priority')}</option>
              </select>
            </div>

            {/* Advanced Filters Dropdown */}
            <div className="relative">
              <button
                onClick={() => setIsFilterDropdownOpen(!isFilterDropdownOpen)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                  activeAdvancedFilterCount > 0
                    ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-950/40 text-brand-700 dark:text-brand-300'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Filter className="w-3.5 h-3.5 text-slate-400" />
                <span>{t('actions.filters', { ns: 'common' })}</span>
                {activeAdvancedFilterCount > 0 && (
                  <span className="w-4 h-4 rounded-full bg-brand-600 text-white text-[10px] flex items-center justify-center font-bold">
                    {activeAdvancedFilterCount}
                  </span>
                )}
                <ChevronDown className="w-3 h-3 text-slate-400" />
              </button>

              {/* Facet Dropdown Popover */}
              {isFilterDropdownOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-72 rounded-xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-slate-800 shadow-xl p-3 z-30 space-y-3.5 animate-in fade-in-50 zoom-in-95">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                      {t('filters.title')}
                    </span>
                    {activeAdvancedFilterCount > 0 && (
                      <button
                        onClick={() => {
                          setFilters(prev => ({
                            ...prev,
                            selectedTypes: [],
                            selectedStates: [],
                            selectedPriorities: []
                          }));
                          setHideCompleted(false);
                        }}
                        className="text-[11px] text-brand-600 dark:text-brand-400 hover:underline font-semibold"
                      >
                        {t('filters.resetFacets')}
                      </button>
                    )}
                  </div>

                  {/* Hide Completed Toggle */}
                  <div className="flex items-center justify-between py-1 px-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                       onClick={() => setHideCompleted(!hideCompleted)}>
                    <span className="text-xs text-slate-700 dark:text-slate-300 font-medium">
                      {t('filters.hideDoneClosed')}
                    </span>
                    <button
                      type="button"
                      aria-label={t('filters.toggleHideCompletedAria')}
                      className={`w-4 h-4 rounded border flex items-center justify-center ${
                        hideCompleted
                          ? 'bg-brand-600 border-brand-600 text-white'
                          : 'border-slate-300 dark:border-slate-700'
                      }`}
                    >
                      {hideCompleted && <CheckCircle2 className="w-3 h-3" />}
                    </button>
                  </div>

                  {/* Types */}
                  <div>
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      {t('filters.workItemType')}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {availableTypes.map(typeName => {
                        const sel = filters.selectedTypes.includes(typeName);
                        return (
                          <button
                            key={typeName}
                            onClick={() => handleTypeToggle(typeName)}
                            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                              sel
                                ? 'bg-brand-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                            }`}
                          >
                            {typeName}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* States */}
                  <div>
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      {t('filters.state')}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {availableStates.map(s => {
                        const sel = filters.selectedStates.includes(s);
                        return (
                          <button
                            key={s}
                            onClick={() => handleStateToggle(s)}
                            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                              sel
                                ? 'bg-brand-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                            }`}
                          >
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Priorities */}
                  <div>
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      {t('filters.priority')}
                    </span>
                    <div className="flex gap-1.5">
                      {availablePriorities.map(p => {
                        const sel = filters.selectedPriorities.includes(p);
                        return (
                          <button
                            key={p}
                            onClick={() => handlePriorityToggle(p)}
                            className={`flex-1 py-1 rounded text-xs font-semibold transition-colors ${
                              sel
                                ? 'bg-brand-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
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
                value={sortBy}
                onChange={e => setSortBy(e.target.value as KanbanSortBy)}
                aria-label={t('sorting.label')}
                className="bg-transparent text-xs text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
              >
                <option value="priority" className="bg-white dark:bg-slate-900">{t('sorting.priority')}</option>
                <option value="changedDate" className="bg-white dark:bg-slate-900">{t('sorting.changedDate')}</option>
                <option value="id" className="bg-white dark:bg-slate-900">{t('sorting.id')}</option>
                <option value="title" className="bg-white dark:bg-slate-900">{t('sorting.title')}</option>
              </select>
              <button
                onClick={() => setSortOrder(o => (o === 'asc' ? 'desc' : 'asc'))}
                title={sortOrder === 'asc' ? t('sorting.ascending') : t('sorting.descending')}
                aria-label={t('sorting.toggleOrder')}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-[10px] font-mono px-1 font-bold"
              >
                {sortOrder.toUpperCase()}
              </button>
            </div>

            {/* Density Toggle */}
            <button
              onClick={toggleDensity}
              title={density === 'comfortable' ? t('density.switchToCompact') : t('density.switchToComfortable')}
              data-testid="kanban-density-toggle"
              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {density === 'comfortable' ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Active Filter Chips (if any active) */}
        {(filters.quickFilter !== 'all' ||
          filters.searchQuery ||
          filters.selectedProject !== 'all' ||
          activeAdvancedFilterCount > 0) && (
          <div className="flex items-center gap-2 pt-1 flex-wrap text-xs">
            <span className="text-slate-400 font-medium text-[11px]">{t('filters.activeLabel')}</span>

            {filters.selectedProject !== 'all' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-800 text-[11px]">
                {t('filters.project', { project: filters.selectedProject })}
              </span>
            )}

            {filters.quickFilter === 'my-tasks' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 text-[11px]">
                {t('filters.assignedTo', { name: currentUserName })}
              </span>
            )}

            {filters.quickFilter === 'blocked' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800 text-[11px]">
                {t('kanbanExtra.blockedOnly', { ns: 'common' })}
              </span>
            )}

            {filters.quickFilter === 'unassigned' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 text-[11px]">
                {t('filters.unassignedOnly')}
              </span>
            )}

            {filters.searchQuery && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px]">
                {t('filters.query', { query: filters.searchQuery })}
                <button
                  onClick={() => setFilters(f => ({ ...f, searchQuery: '' }))}
                  className="hover:text-slate-900 dark:hover:text-white"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            )}

            {hideCompleted && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px]">
                {t('filters.doneHidden')}
                <button
                  onClick={() => setHideCompleted(false)}
                  className="hover:text-slate-900 dark:hover:text-white"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            )}

            <button
              onClick={() => {
                resetFilters();
                setHideCompleted(false);
              }}
              className="text-[11px] text-brand-600 dark:text-brand-400 hover:underline font-semibold ml-1 flex items-center gap-1"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              {t('filters.clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* 2. Main Work Area: Master (Kanban Board) + Detail (WorkItemInspector) */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* Kanban Board Container: stays mounted across reloads so the scroll position is kept */}
        <div
          ref={scrollContainerRef}
          onScroll={checkScroll}
          className="flex-1 overflow-x-auto overflow-y-auto min-w-0 p-3 sm:p-4 flex flex-col"
        >
          {renderBody()}
        </div>

        {/* Horizontal scroll indicators when overflowed */}
        {canScrollRight && (
          <div
            onClick={() => scrollContainerRef.current?.scrollBy({ left: 320, behavior: 'smooth' })}
            className="absolute right-0 top-0 bottom-0 w-8 pointer-events-none z-10 flex items-center justify-end pr-1"
            title="Sağa kaydır"
          >
            <button
              type="button"
              className="w-6 h-10 rounded-l-md bg-white/95 dark:bg-slate-800/95 shadow-md border-y border-l border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-white pointer-events-auto transition-transform hover:scale-105"
              aria-label="Scroll board right"
              data-testid="kanban-scroll-right"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {canScrollLeft && (
          <div
            onClick={() => scrollContainerRef.current?.scrollBy({ left: -320, behavior: 'smooth' })}
            className="absolute left-0 top-0 bottom-0 w-8 pointer-events-none z-10 flex items-center justify-start pl-1"
            title="Sola kaydır"
          >
            <button
              type="button"
              className="w-6 h-10 rounded-r-md bg-white/95 dark:bg-slate-800/95 shadow-md border-y border-r border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-white pointer-events-auto transition-transform hover:scale-105"
              aria-label="Scroll board left"
              data-testid="kanban-scroll-left"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Right Side: Work Item Inspector */}
        {selectedWorkItem && (
          <WorkItemInspector
            item={selectedWorkItem}
            onClose={() => setSelectedWorkItem(null)}
            onNavigateToItem={item => setSelectedWorkItem(item)}
          />
        )}
      </div>

      {/* 3. Footer Status Bar */}
      <div className="h-9 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] px-5 flex items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400 select-none shrink-0 whitespace-nowrap overflow-hidden">
        <div className="flex items-center gap-3 min-w-0 overflow-hidden">
          {board && (
            <span
              data-testid="kanban-footer"
              className="shrink-0"
              title={t('footer.loadedOfTitle')}
            >
              {t('footer.loadedOf', { shown: shownCards, total: board.total })}
              {scopeSplit.done > 0 && (
                <span className="hidden lg:inline text-slate-400" data-testid="kanban-footer-scope">
                  {' · '}
                  {t('footer.scopeBreakdown', { active: scopeSplit.active, done: scopeSplit.done })}
                </span>
              )}
            </span>
          )}
          {updating && (
            <span className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400 shrink-0">
              <span className="w-2.5 h-2.5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              {t('status.updating')}
            </span>
          )}
          {filters.selectedProject !== 'all' && (
            <span className="truncate min-w-0 hidden md:inline">• {t('filters.project', { project: filters.selectedProject })}</span>
          )}
          <span className="truncate min-w-0">
            • {t('footer.mode', { mode: laneMode === 'none' ? t('footer.modeStandard') : laneMode === 'parent' ? t('footer.modeParent') : laneMode === 'assignee' ? t('footer.modeAssignee') : t('footer.modePriority') })}
          </span>
        </div>

        <div className="hidden lg:flex items-center gap-4 text-xs text-slate-400 min-w-0 overflow-hidden shrink-0">
          <span className="hidden xl:inline truncate">{t('status.readOnlyBadge', { ns: 'common' })}</span>
          <span className="truncate">{t('footer.clickCard')}</span>
          <span className="font-mono text-[11px] hidden xl:inline truncate">{t('footer.escDeselect')}</span>
        </div>
      </div>
    </div>
  );
};
