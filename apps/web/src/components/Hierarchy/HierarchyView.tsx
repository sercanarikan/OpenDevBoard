import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  ChevronDown,
  GitFork,
  Maximize2,
  Minimize2,
  User,
  Inbox,
  AlertTriangle,
  Search,
  X,
  RotateCcw,
  ArrowDownLeft
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { WorkItem } from '../../types';
import { WorkItemInspector } from '../Explorer/WorkItemInspector';
import { computeCanonicalProgressMap, type RollupProgress } from '../../utils/progress';
import { UserAvatar } from '../Common/UserAvatar';
import { stateLabel, priorityLabel } from '../../i18n/labels';
import { hasMoreToRight } from '../../utils/layout';

// Title column keeps a readable width; the table scrolls horizontally rather than squeezing the right-hand columns.
// `contain: inline-size` stops a long title from inflating the row to its full text width: without it the sticky cell
// became wider than the viewport (1386 px in a 960 px box), so `sticky left-0` could not hold it and the right-hand
// columns scrolled away empty.
const HIER_TITLE_MIN = 'min-w-[340px] [contain:inline-size]';

// Tree Node Component
interface HierarchyNodeProps {
  item: WorkItem;
  level: number;
  expandedMap: Record<number, boolean>;
  progressMap: Map<number, RollupProgress>;
  toggleExpand: (id: number) => void;
  onSelect: (item: WorkItem) => void;
  selectedId?: number;
  isInspectorOpen: boolean;
}

const HierarchyNode: React.FC<HierarchyNodeProps> = ({
  item,
  level,
  expandedMap,
  progressMap,
  toggleExpand,
  onSelect,
  selectedId,
  isInspectorOpen
}) => {
  const { t } = useTranslation();
  const hasChildren = item.children && item.children.length > 0;
  const isExpanded = !!expandedMap[item.id];
  const isSelected = selectedId === item.id;

  // Retrieve canonical, filter-independent progress metrics
  const metrics = progressMap.get(item.id) || {
    totalUnits: 0,
    completedUnits: 0,
    percent: 0,
    blockedCount: 0,
    unassignedCount: 0,
    hasChildren: false
  };

  // Dot color by type
  const getTypeDotColor = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes('bug')) return 'bg-rose-500';
    if (t.includes('epic')) return 'bg-purple-500';
    if (t.includes('feature')) return 'bg-indigo-500';
    if (t.includes('story') || t.includes('pbi')) return 'bg-sky-500';
    return 'bg-emerald-500';
  };

  const isEpic = item.type.toLowerCase().includes('epic');
  const isFeature = item.type.toLowerCase().includes('feature');
  const isStory = item.type.toLowerCase().includes('story') || item.type.toLowerCase().includes('pbi');

  return (
    <div className="flex flex-col">
      {/* Node Row */}
      <div
        onClick={() => onSelect(item)}
        data-testid="hierarchy-row"
        data-id={item.id}
        className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-all border-b border-slate-100 dark:border-slate-800/60 select-none min-w-max ${
          isSelected
            ? 'bg-brand-50/70 dark:bg-brand-950/40 border-l-4 border-l-brand-600'
            : 'hover:bg-slate-50/90 dark:hover:bg-slate-800/40 border-l-4 border-l-transparent'
        } ${isEpic ? 'bg-slate-50/50 dark:bg-slate-900/40' : ''}`}
        style={{ paddingLeft: `${level * 22 + 14}px` }}
      >
        {/* Expand / Collapse Button */}
        <div
          onClick={e => {
            e.stopPropagation();
            if (hasChildren) toggleExpand(item.id);
          }}
          className={`w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200/70 dark:hover:bg-slate-700/70 text-slate-400 shrink-0 ${
            hasChildren ? 'cursor-pointer' : 'opacity-0 cursor-default'
          }`}
          title={hasChildren ? (isExpanded ? t('hierarchy.collapseNode') : t('hierarchy.expandNode')) : undefined}
        >
          {hasChildren && (
            isExpanded ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />
          )}
        </div>

        {/* Type Dot & ID */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`w-2 h-2 rounded-full ${getTypeDotColor(item.type)}`} />
          <span className="font-mono text-xs font-bold text-slate-400">
            #{item.id}
          </span>
        </div>

        {/* Title & Hierarchy Details */}
        <div className={`sticky left-0 z-[1] flex-1 ${HIER_TITLE_MIN} flex items-center gap-2 min-w-0 ${isSelected ? 'bg-brand-50 dark:bg-[#15202f]' : 'bg-white dark:bg-[#0E131F]'}`}>
          <span
            title={item.title}
            className={`truncate min-w-0 ${
              isEpic
                ? 'text-[15px] font-bold text-slate-900 dark:text-slate-100'
                : isFeature
                ? 'text-[14.5px] font-semibold text-slate-900 dark:text-slate-100'
                : isStory
                ? 'text-sm font-semibold text-slate-800 dark:text-slate-200'
                : 'text-sm font-medium text-slate-700 dark:text-slate-300'
            }`}
          >
            {item.title}
          </span>

          {/* Level Type Badge (subtle) */}
          <span className="text-[11px] text-slate-400 font-medium shrink-0 hidden sm:inline">
            ({item.type})
          </span>

          {/* Story points */}
          {item.storyPoints && (
            <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 shrink-0">
              {t('fields.storyPointsValue', { ns: 'common', value: item.storyPoints })}
            </span>
          )}

          {/* Blocked alert badge on the item itself */}
          {item.isBlocked && (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/60 px-1.5 py-0.2 rounded shrink-0">
              <AlertTriangle className="w-3 h-3" />
              {t('chip.blocked')}
            </span>
          )}

          {/* Rollup warnings for Parent items (from canonical progress) */}
          {metrics.hasChildren && metrics.blockedCount > 0 && !item.isBlocked && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-600 dark:text-rose-400 shrink-0">
              <AlertTriangle className="w-3 h-3" />
              {t('hierarchy.blockedCount', { count: metrics.blockedCount })}
            </span>
          )}

          {metrics.hasChildren && metrics.unassignedCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400 shrink-0">
              <Inbox className="w-3 h-3" />
              {t('hierarchy.unassignedCount', { count: metrics.unassignedCount })}
            </span>
          )}

          {/* Predecessors / Successors tags for leaf items */}
          {!hasChildren && item.relations?.predecessors?.length > 0 && (
            <span className="font-mono text-[11px] text-indigo-600 dark:text-indigo-400 flex items-center gap-0.5 shrink-0">
              <ArrowDownLeft className="w-3 h-3" />
              {item.relations.predecessors.length} {t('chip.pred')}
            </span>
          )}
        </div>

        {/* Progress Bar (Computed from canonical progress map, completely filter-independent!) */}
        {metrics.hasChildren ? (
          <div className="w-36 flex items-center gap-2 shrink-0">
            <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all"
                style={{ width: `${metrics.percent}%` }}
              />
            </div>
            <span className="font-mono text-[11px] font-semibold text-slate-500 w-12 text-right">
              {metrics.completedUnits}/{metrics.totalUnits} ({metrics.percent}%)
            </span>
          </div>
        ) : (
          <div className="w-36 shrink-0" />
        )}

        {/* Priority Badge */}
        <div className="w-20 text-center shrink-0">
          <span className={`text-xs font-semibold ${
            item.priority === 1
              ? 'text-rose-600 dark:text-rose-400'
              : item.priority === 2
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-slate-500'
          }`}>
            {priorityLabel(t, item.priority)}
          </span>
        </div>

        {/* State Pill */}
        <div className="w-24 text-center shrink-0">
          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
            {stateLabel(t, item.state)}
          </span>
        </div>

        {/* Assignee: the table scrolls horizontally instead of dropping this column */}
        <div className="w-32 text-right shrink-0 flex items-center justify-end gap-1.5 text-xs">
          {item.isUnassigned ? (
            <span className="text-amber-600 dark:text-amber-400 font-medium">{t('hierarchy.unassigned')}</span>
          ) : (
            <div className="flex items-center gap-1.5 truncate">
              <UserAvatar name={item.assignedTo} avatarUrl={item.assignedAvatar} size="xs" />
              <span className="truncate text-slate-700 dark:text-slate-300">{item.assignedTo}</span>
            </div>
          )}
        </div>
      </div>

      {/* Children list with connector guide line */}
      {hasChildren && isExpanded && (
        <div className="relative border-l border-slate-200 dark:border-slate-800 ml-4 sm:ml-5">
          {item.children.map(child => (
            <HierarchyNode
              key={child.id}
              item={child}
              level={level + 1}
              expandedMap={expandedMap}
              progressMap={progressMap}
              toggleExpand={toggleExpand}
              onSelect={onSelect}
              selectedId={selectedId}
              isInspectorOpen={isInspectorOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const HierarchyView: React.FC = () => {
  const { t } = useTranslation();
  const {
    poolData,
    poolLoading,
    poolError,
    ensurePool,
    retryPool,
    filters,
    selectedWorkItem,
    setSelectedWorkItem,
    openWorkItem,
    currentUserName,
    summary,
    booting
  } = useApp();

  // This screen needs the complete hierarchy (parents, children, completed work): load it lazily, only here.
  useEffect(() => {
    ensurePool();
  }, [ensurePool]);
  const loading = booting || (poolLoading && !poolData);

  const [searchQuery, setSearchQuery] = useState('');
  const [quickTab, setQuickTab] = useState<'all' | 'my-tasks' | 'blocked' | 'unassigned'>('all');

  const allItems: WorkItem[] = poolData?.flat_items || [];
  const fullHierarchy: WorkItem[] = poolData?.hierarchy || [];

  // Scoped hierarchy roots by selected project
  const projectHierarchy = useMemo(() => {
    if (filters.selectedProject === 'all') return fullHierarchy;
    return fullHierarchy.filter(item => item.project === filters.selectedProject);
  }, [fullHierarchy, filters.selectedProject]);

  // PRE-COMPUTE CANONICAL PROGRESS MAP FROM FULL UNFILTERED HIERARCHY
  // This guarantees that progress calculations are 100% immune to momentary UI filters!
  const canonicalProgressMap = useMemo(() => {
    return computeCanonicalProgressMap(poolData?.progressHierarchy || fullHierarchy);
  }, [poolData?.progressHierarchy, fullHierarchy]);

  // Expanded nodes map state
  const [expandedMap, setExpandedMap] = useState<Record<number, boolean>>({});
  const [moreRight, setMoreRight] = useState(false);
  const treeScrollRef = React.useRef<HTMLDivElement>(null);

  const updateMoreRight = useCallback(() => {
    const el = treeScrollRef.current;
    setMoreRight(el ? hasMoreToRight(el.scrollLeft, el.clientWidth, el.scrollWidth) : false);
  }, []);

  useEffect(() => {
    window.addEventListener('resize', updateMoreRight);
    return () => window.removeEventListener('resize', updateMoreRight);
  }, [updateMoreRight]);

  // Filter hierarchy while PRESERVING ancestor paths and auto-expanding them
  const { filteredHierarchy, autoExpandMap } = useMemo(() => {
    const autoExpand: Record<number, boolean> = {};

    const predicate = (node: WorkItem): boolean => {
      // 1. Quick Tab filtering
      if (quickTab === 'my-tasks' && node.assignedTo !== currentUserName) {
        return false;
      }
      if (quickTab === 'blocked' && !node.isBlocked) {
        return false;
      }
      if (quickTab === 'unassigned' && !node.isUnassigned) {
        return false;
      }

      // 2. Search query filtering
      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        const matchTitle = node.title.toLowerCase().includes(q);
        const matchId = node.id.toString().includes(q);
        const matchAssignee = node.assignedTo.toLowerCase().includes(q);
        const matchProject = node.project.toLowerCase().includes(q);
        if (!matchTitle && !matchId && !matchAssignee && !matchProject) {
          return false;
        }
      }

      return true;
    };

    // If no filter is applied, return projectHierarchy as is
    if (quickTab === 'all' && searchQuery.trim() === '') {
      return { filteredHierarchy: projectHierarchy, autoExpandMap: {} };
    }

    function processNode(node: WorkItem): WorkItem | null {
      const isSelfMatch = predicate(node);

      const matchedChildren: WorkItem[] = [];
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          const matchedChild = processNode(child);
          if (matchedChild) {
            matchedChildren.push(matchedChild);
          }
        }
      }

      // A node is kept if either it matches or any child matches
      if (isSelfMatch || matchedChildren.length > 0) {
        if (matchedChildren.length > 0) {
          autoExpand[node.id] = true;
        }
        return {
          ...node,
          children: matchedChildren
        };
      }

      return null;
    }

    const filtered: WorkItem[] = [];
    for (const root of projectHierarchy) {
      const p = processNode(root);
      if (p) filtered.push(p);
    }

    return { filteredHierarchy: filtered, autoExpandMap: autoExpand };
  }, [projectHierarchy, quickTab, searchQuery, currentUserName]);

  // Sync expandedMap with initial defaults or autoExpandMap
  useEffect(() => {
    if (Object.keys(autoExpandMap).length > 0) {
      setExpandedMap(prev => ({ ...prev, ...autoExpandMap }));
    } else {
      // Default: expand Epics, Features, and Stories so tasks are immediately visible
      const initial: Record<number, boolean> = {};
      allItems.forEach(i => {
        if (i.type === 'Epic' || i.type === 'Feature' || i.type === 'User Story' || i.type === 'Product Backlog Item') {
          initial[i.id] = true;
        }
      });
      setExpandedMap(initial);
    }
  }, [allItems, autoExpandMap]);

  // Sync selected item: if selectedWorkItem is no longer present in filtered hierarchy, close inspector
  useEffect(() => {
    if (selectedWorkItem) {
      let isPresent = false;
      function check(nodes: WorkItem[]) {
        for (const n of nodes) {
          if (n.id === selectedWorkItem?.id) {
            isPresent = true;
            return;
          }
          if (n.children && n.children.length > 0) {
            check(n.children);
          }
        }
      }
      check(filteredHierarchy);
      if (!isPresent) {
        setSelectedWorkItem(null);
      }
    }
  }, [filteredHierarchy, selectedWorkItem, setSelectedWorkItem]);

  useEffect(() => {
    updateMoreRight();
  }, [updateMoreRight, filteredHierarchy, loading]);

  const toggleExpand = useCallback((id: number) => {
    setExpandedMap(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const expandAll = () => {
    const full: Record<number, boolean> = {};
    allItems.forEach(i => {
      if (i.children && i.children.length > 0) full[i.id] = true;
    });
    setExpandedMap(full);
  };

  const collapseAll = () => {
    setExpandedMap({});
  };

  // Navigate to another work item from Inspector
  const handleInspectorNavigate = (targetItem: WorkItem) => {
    if (!allItems.some(i => i.id === targetItem.id)) {
      setSelectedWorkItem(targetItem);
      void openWorkItem(targetItem.id);
      return;
    }
    // Expand ancestor chain for targetItem so it is visible in the tree
    const newExpands: Record<number, boolean> = {};
    let currParentId = targetItem.parentId;
    while (currParentId) {
      newExpands[currParentId] = true;
      const p = allItems.find(i => i.id === currParentId);
      currParentId = p?.parentId || null;
    }
    setExpandedMap(prev => ({ ...prev, ...newExpands }));

    // Reset filters if targetItem is not in current view
    if (quickTab !== 'all' || searchQuery.trim() !== '') {
      setQuickTab('all');
      setSearchQuery('');
    }
    setSelectedWorkItem(targetItem);
  };

  // My Tasks and other counts computed consistently with Task Explorer:
  // Both screens now use scopedItems (all matching assigned items in current project scope)
  // Same server-side definitions as the sidebar, Task Explorer and Kanban tabs.
  const myTasksCount = summary?.scope.myTasks ?? 0;
  const blockedCount = summary?.scope.blocked ?? 0;
  const unassignedCount = summary?.scope.unassigned ?? 0;

  const isInspectorOpen = !!selectedWorkItem;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* 1. Header Toolbar: Tabs, Search & Tree Controls */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Quick Filter Tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
            <button
              onClick={() => setQuickTab('all')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                quickTab === 'all'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <GitFork className="w-3.5 h-3.5 text-slate-500" />
              <span>{t('hierarchy.allHierarchies')}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                quickTab === 'all'
                  ? 'bg-brand-100 dark:bg-brand-950 text-brand-800 dark:text-brand-300'
                  : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}>
                {projectHierarchy.length}
              </span>
            </button>

            <button
              onClick={() => setQuickTab('my-tasks')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                quickTab === 'my-tasks'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <User className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{t('hierarchy.myTasks')}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                quickTab === 'my-tasks'
                  ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                  : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}>
                {myTasksCount}
              </span>
            </button>

            <button
              onClick={() => setQuickTab('blocked')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                quickTab === 'blocked'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
              <span>{t('hierarchy.blocked')}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                quickTab === 'blocked'
                  ? 'bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300'
                  : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}>
                {blockedCount}
              </span>
            </button>

            <button
              onClick={() => setQuickTab('unassigned')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                quickTab === 'unassigned'
                  ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Inbox className="w-3.5 h-3.5 text-amber-500" />
              <span>{t('hierarchy.unassigned')}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-mono font-bold ${
                quickTab === 'unassigned'
                  ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                  : 'bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}>
                {unassignedCount}
              </span>
            </button>
          </div>

          {/* Right Action: Expand/Collapse Tree */}
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={expandAll}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white rounded-md border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t('hierarchy.expandTitle')}
            >
              <Maximize2 className="w-3.5 h-3.5 text-slate-400" />
              <span>{t('hierarchy.expandAll')}</span>
            </button>

            <button
              onClick={collapseAll}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white rounded-md border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t('hierarchy.collapseTitle')}
            >
              <Minimize2 className="w-3.5 h-3.5 text-slate-400" />
              <span>{t('hierarchy.collapseAll')}</span>
            </button>
          </div>
        </div>

        {/* 2. Hierarchy Search Input */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('hierarchy.searchPlaceholder')}
              className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg pl-9 pr-8 py-1.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 rounded"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {(searchQuery || quickTab !== 'all') && (
            <button
              onClick={() => {
                setSearchQuery('');
                setQuickTab('all');
              }}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950/60 hover:bg-brand-100 rounded-md border border-brand-200 dark:border-brand-800 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('hierarchy.reset')}</span>
            </button>
          )}
        </div>
      </div>

      {/* 2. Tree Content Area (Master-Detail Split Pane) */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Tree Content: Independently scrollable, with min-width protection */}
        <div className="relative flex-1 flex min-w-0 overflow-hidden">
        <div
          ref={treeScrollRef}
          onScroll={updateMoreRight}
          className="flex-1 overflow-x-auto overflow-y-auto min-w-0"
          data-testid="hierarchy-scroll"
        >
          {loading ? (
            <div className="py-24 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="hierarchy-loading">
              <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{t('hierarchy.loading')}</span>
            </div>
          ) : poolError && !poolData ? (
            <div className="py-24 flex flex-col items-center justify-center text-center max-w-sm mx-auto px-4" role="alert" data-testid="hierarchy-error">
              <div className="w-12 h-12 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center text-rose-500 mb-3">
                <GitFork className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                {t('hierarchy.poolFailed')}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">{poolError}</p>
              <button
                onClick={retryPool}
                data-testid="hierarchy-retry"
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-md transition-colors"
              >
                {t('hierarchy.poolRetry')}
              </button>
            </div>
          ) : filteredHierarchy.length === 0 ? (
            <div className="py-24 flex flex-col items-center justify-center text-center max-w-sm mx-auto px-4">
              <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
                <GitFork className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                {t('hierarchy.noMatchTitle')}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                {t('hierarchy.noMatchDesc')}
              </p>
              <button
                onClick={() => {
                  setSearchQuery('');
                  setQuickTab('all');
                }}
                className="px-3.5 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950 rounded-md border border-brand-200 dark:border-brand-800"
              >
                {t('hierarchy.reset')}
              </button>
            </div>
          ) : (
            <div className="min-w-max w-full">
              {/* Sticky Tree Column Header */}
              <div className="sticky top-0 z-10 flex items-center px-4 py-2.5 bg-slate-100/90 dark:bg-[#0B0F17]/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none gap-3 min-w-max">
                <div className={`sticky left-0 z-10 bg-slate-100 dark:bg-[#0B0F17] flex-1 ${HIER_TITLE_MIN} pl-7`}>
                  {t('hierarchy.colStructure')}
                </div>
                <div className="w-36 text-right shrink-0">
                  {t('hierarchy.colProgress')}
                </div>
                <div className="w-20 text-center shrink-0">
                  {t('hierarchy.colPriority')}
                </div>
                <div className="w-24 text-center shrink-0">
                  {t('hierarchy.colState')}
                </div>
                <div className="w-32 text-right shrink-0">
                  {t('hierarchy.colAssignee')}
                </div>
              </div>

              {/* Hierarchy Nodes */}
              <div className="bg-white dark:bg-[#0E131F]">
                {filteredHierarchy.map(rootNode => (
                  <HierarchyNode
                    key={rootNode.id}
                    item={rootNode}
                    level={0}
                    expandedMap={expandedMap}
                    progressMap={canonicalProgressMap}
                    toggleExpand={toggleExpand}
                    onSelect={setSelectedWorkItem}
                    selectedId={selectedWorkItem?.id}
                    isInspectorOpen={isInspectorOpen}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        {moreRight && (
          <div
            aria-hidden="true"
            data-testid="hierarchy-scroll-cue"
            className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-white dark:from-[#0E131F] to-transparent"
          />
        )}
        </div>

        {/* Right Side: Work Item Inspector (Master-Detail Pane, independently scrollable) */}
        {selectedWorkItem && (
          <WorkItemInspector
            item={selectedWorkItem}
            onClose={() => setSelectedWorkItem(null)}
            onNavigateToItem={handleInspectorNavigate}
          />
        )}
      </div>

      {/* 3. Footer Bar */}
      <div className="h-9 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] px-5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 select-none shrink-0">
        <div className="flex items-center gap-3">
          <span>
            {t('hierarchy.footerTrees', { count: filteredHierarchy.length })}
          </span>
          {filters.selectedProject !== 'all' && (
            <span>• {t('hierarchy.footerProject')}: <strong>{filters.selectedProject}</strong></span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span>{t('hierarchy.footerHint')}</span>
        </div>
      </div>
    </div>
  );
};
