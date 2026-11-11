import type { WorkItem } from '../types';
import { getWorkItemStateCategory, isWorkItemCompleted, type WorkItemStateCategory } from './workState';
import { type RollupProgress } from './progress';

export type KanbanColumnId = 'todo' | 'in-progress' | 'resolved' | 'done';

export type KanbanSwimlaneMode = 'none' | 'parent' | 'assignee' | 'priority';

export type KanbanCardDensity = 'comfortable' | 'compact';

export type KanbanSortBy = 'priority' | 'changedDate' | 'id' | 'title';

export interface KanbanColumnDef {
  id: KanbanColumnId;
  title: string;
  shortTitle: string;
  category: WorkItemStateCategory;
  states: string[];
  color: string;
  dotColor: string;
  accentBorder: string;
  headerBg: string;
  badgeBg: string;
  badgeText: string;
}

export const KANBAN_COLUMNS: KanbanColumnDef[] = [
  {
    id: 'todo',
    title: 'To Do & New',
    shortTitle: 'To Do',
    category: 'Proposed',
    states: ['New', 'To Do', 'Proposed'],
    color: 'border-blue-200 dark:border-blue-900/60',
    dotColor: 'bg-blue-500',
    accentBorder: 'border-t-blue-500',
    headerBg: 'bg-blue-50/50 dark:bg-blue-950/20',
    badgeBg: 'bg-blue-100 dark:bg-blue-900/50',
    badgeText: 'text-blue-700 dark:text-blue-300'
  },
  {
    id: 'in-progress',
    title: 'Active & In Progress',
    shortTitle: 'In Progress',
    category: 'InProgress',
    states: ['Active', 'In Progress', 'Committed'],
    color: 'border-amber-200 dark:border-amber-900/60',
    dotColor: 'bg-amber-500',
    accentBorder: 'border-t-amber-500',
    headerBg: 'bg-amber-50/50 dark:bg-amber-950/20',
    badgeBg: 'bg-amber-100 dark:bg-amber-900/50',
    badgeText: 'text-amber-700 dark:text-amber-300'
  },
  {
    id: 'resolved',
    title: 'Resolved & In Review',
    shortTitle: 'In Review',
    category: 'Resolved',
    states: ['Resolved', 'In Review', 'Testing'],
    color: 'border-violet-200 dark:border-violet-900/60',
    dotColor: 'bg-violet-500',
    accentBorder: 'border-t-violet-500',
    headerBg: 'bg-violet-50/50 dark:bg-violet-950/20',
    badgeBg: 'bg-violet-100 dark:bg-violet-900/50',
    badgeText: 'text-violet-700 dark:text-violet-300'
  },
  {
    id: 'done',
    title: 'Done & Closed',
    shortTitle: 'Done',
    category: 'Completed',
    states: ['Done', 'Closed', 'Completed'],
    color: 'border-emerald-200 dark:border-emerald-900/60',
    dotColor: 'bg-emerald-500',
    accentBorder: 'border-t-emerald-500',
    headerBg: 'bg-emerald-50/50 dark:bg-emerald-950/20',
    badgeBg: 'bg-emerald-100 dark:bg-emerald-900/50',
    badgeText: 'text-emerald-700 dark:text-emerald-300'
  }
];

export interface KanbanFilterOptions {
  selectedProject: string;
  quickFilter: 'all' | 'my-tasks' | 'unassigned' | 'blocked' | 'bugs';
  searchQuery: string;
  selectedTypes: string[];
  selectedStates: string[];
  selectedPriorities: number[];
  hideCompleted?: boolean;
}

/**
 * Maps a Work Item to its canonical Kanban column ID based on state category.
 */
export function getKanbanColumnForState(state: string): KanbanColumnId {
  const category = getWorkItemStateCategory(state);
  switch (category) {
    case 'Proposed':
      return 'todo';
    case 'InProgress':
      return 'in-progress';
    case 'Resolved':
      return 'resolved';
    case 'Completed':
      return 'done';
    case 'Removed':
    default:
      // Unknown or active states map to in-progress safely
      return 'in-progress';
  }
}

/**
 * Filter items for Kanban board according to active project, quick filters,
 * advanced facets, and search query.
 */
export function filterKanbanItems(
  items: WorkItem[],
  options: KanbanFilterOptions,
  currentUserName: string
): WorkItem[] {
  return items.filter(item => {
    // 1. Project filter
    if (options.selectedProject !== 'all' && item.project !== options.selectedProject) {
      return false;
    }

    // 2. Hide completed filter
    if (options.hideCompleted && isWorkItemCompleted(item.state, item.type)) {
      return false;
    }

    // 3. Quick filters
    if (options.quickFilter === 'my-tasks' && item.assignedTo !== currentUserName) {
      return false;
    }
    if (options.quickFilter === 'unassigned' && !item.isUnassigned) {
      return false;
    }
    if (options.quickFilter === 'blocked' && !item.isBlocked) {
      return false;
    }
    if (options.quickFilter === 'bugs' && !item.isBug) {
      return false;
    }

    // 4. Search query
    if (options.searchQuery.trim() !== '') {
      const q = options.searchQuery.toLowerCase();
      const matchTitle = item.title.toLowerCase().includes(q);
      const matchId = item.id.toString().includes(q);
      const matchAssignee = item.assignedTo.toLowerCase().includes(q);
      const matchProject = item.project.toLowerCase().includes(q);
      const matchParent = item.parentTitle?.toLowerCase().includes(q) ?? false;
      if (!matchTitle && !matchId && !matchAssignee && !matchProject && !matchParent) {
        return false;
      }
    }

    // 5. Types
    if (options.selectedTypes.length > 0 && !options.selectedTypes.includes(item.type)) {
      return false;
    }

    // 6. States
    if (options.selectedStates.length > 0 && !options.selectedStates.includes(item.state)) {
      return false;
    }

    // 7. Priorities
    if (options.selectedPriorities.length > 0 && !options.selectedPriorities.includes(item.priority)) {
      return false;
    }

    return true;
  });
}

/**
 * Sorts items inside columns or swimlanes.
 * When sorted by 'priority', P1 Critical items come first, and within same priority
 * blocked items are highlighted at the top.
 */
export function sortKanbanItems(
  items: WorkItem[],
  sortBy: KanbanSortBy = 'priority',
  sortOrder: 'asc' | 'desc' = 'asc'
): WorkItem[] {
  return [...items].sort((a, b) => {
    let diff = 0;
    if (sortBy === 'priority') {
      diff = a.priority - b.priority;
      if (diff === 0) {
        if (a.isBlocked && !b.isBlocked) return -1;
        if (!a.isBlocked && b.isBlocked) return 1;
        diff = new Date(b.changedDate).getTime() - new Date(a.changedDate).getTime();
      }
    } else if (sortBy === 'changedDate') {
      diff = new Date(b.changedDate).getTime() - new Date(a.changedDate).getTime();
    } else if (sortBy === 'id') {
      diff = b.id - a.id;
    } else if (sortBy === 'title') {
      diff = a.title.localeCompare(b.title);
    }
    return sortOrder === 'desc' ? -diff : diff;
  });
}

export interface KanbanSwimlane {
  id: string;
  title: string;
  subtitle?: string;
  type?: string;
  visibleCardsCount: number;
  totalCount: number; // backward-compatible alias
  canonicalProgress?: {
    totalUnits: number;
    completedUnits: number;
    percent: number;
  };
  columns: Record<KanbanColumnId, WorkItem[]>;
}

/**
 * Groups filtered items into swimlanes (None, Parent Story, Assignee, Priority)
 * and partitions each swimlane's items into the 4 canonical Kanban columns.
 *
 * Uses the canonical progress map from `computeCanonicalProgressMap` to ensure
 * progress values are 100% consistent with Story & Tasks hierarchy view,
 * regardless of UI filters.
 */
export function buildKanbanSwimlanes(
  filteredItems: WorkItem[],
  mode: KanbanSwimlaneMode,
  allItems: WorkItem[],
  canonicalProgressMap?: Map<number, RollupProgress>,
  sortBy: KanbanSortBy = 'priority',
  sortOrder: 'asc' | 'desc' = 'asc'
): KanbanSwimlane[] {
  const sorted = sortKanbanItems(filteredItems, sortBy, sortOrder);

  // Helper to split a list of items into the 4 columns
  const splitIntoColumns = (itemsList: WorkItem[]): Record<KanbanColumnId, WorkItem[]> => {
    const cols: Record<KanbanColumnId, WorkItem[]> = {
      todo: [],
      'in-progress': [],
      resolved: [],
      done: []
    };
    for (const item of itemsList) {
      const colId = getKanbanColumnForState(item.state);
      cols[colId].push(item);
    }
    return cols;
  };

  // Helper to compute progress for a set of items
  const computeProgress = (itemsList: WorkItem[]) => {
    const total = itemsList.length;
    const completed = itemsList.filter(i => isWorkItemCompleted(i.state, i.type)).length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, progress };
  };

  if (mode === 'none') {
    const { total, completed, progress } = computeProgress(sorted);
    return [
      {
        id: 'all',
        title: 'All Active Work',
        visibleCardsCount: sorted.length,
        totalCount: sorted.length,
        canonicalProgress: {
          totalUnits: total,
          completedUnits: completed,
          percent: progress
        },
        columns: splitIntoColumns(sorted)
      }
    ];
  }

  if (mode === 'parent') {
    // Group items by parent
    const parentMap = new Map<number | 'none', WorkItem[]>();

    for (const item of sorted) {
      const pKey = item.parentId || 'none';
      if (!parentMap.has(pKey)) {
        parentMap.set(pKey, []);
      }
      parentMap.get(pKey)!.push(item);
    }

    const swimlanes: KanbanSwimlane[] = [];
    const allItemsMap = new Map(allItems.map(i => [i.id, i]));

    for (const [pKey, pItems] of parentMap.entries()) {
      if (pKey === 'none') {
        const { total, completed, progress } = computeProgress(pItems);
        swimlanes.push({
          id: 'independent',
          title: 'Independent / Top-Level Tasks',
          subtitle: 'Items without a direct parent user story',
          visibleCardsCount: pItems.length,
          totalCount: pItems.length,
          canonicalProgress: {
            totalUnits: total,
            completedUnits: completed,
            percent: progress
          },
          columns: splitIntoColumns(pItems)
        });
      } else {
        const parentObj = allItemsMap.get(pKey);
        const title = parentObj?.title || pItems[0]?.parentTitle || `Parent #${pKey}`;
        const type = parentObj?.type || pItems[0]?.parentType || 'Story';
        const project = parentObj?.project || pItems[0]?.project;

        // Centralized Canonical Progress lookup
        const canonical = canonicalProgressMap?.get(Number(pKey));
        let canonicalProgressObj: { totalUnits: number; completedUnits: number; percent: number } | undefined;

        if (canonical) {
          canonicalProgressObj = {
            totalUnits: canonical.totalUnits,
            completedUnits: canonical.completedUnits,
            percent: canonical.percent
          };
        } else if (parentObj) {
          const isDone = isWorkItemCompleted(parentObj.state, parentObj.type);
          canonicalProgressObj = {
            totalUnits: 1,
            completedUnits: isDone ? 1 : 0,
            percent: isDone ? 100 : 0
          };
        }

        swimlanes.push({
          id: `parent-${pKey}`,
          title: `#${pKey} ${title}`,
          subtitle: project ? `${project} • ${type}` : type,
          type,
          visibleCardsCount: pItems.length,
          totalCount: pItems.length,
          canonicalProgress: canonicalProgressObj,
          columns: splitIntoColumns(pItems)
        });
      }
    }

    // Sort swimlanes: parent stories with active items first, independent tasks last
    return swimlanes.sort((a, b) => {
      if (a.id === 'independent') return 1;
      if (b.id === 'independent') return -1;
      return b.visibleCardsCount - a.visibleCardsCount;
    });
  }

  if (mode === 'assignee') {
    const assigneeMap = new Map<string, WorkItem[]>();
    for (const item of sorted) {
      const key = item.isUnassigned ? 'Unassigned Pool' : item.assignedTo;
      if (!assigneeMap.has(key)) {
        assigneeMap.set(key, []);
      }
      assigneeMap.get(key)!.push(item);
    }

    const swimlanes: KanbanSwimlane[] = [];
    for (const [assignee, aItems] of assigneeMap.entries()) {
      const { total, completed, progress } = computeProgress(aItems);
      swimlanes.push({
        id: `assignee-${assignee.replace(/\s+/g, '-').toLowerCase()}`,
        title: assignee,
        subtitle: assignee === 'Unassigned Pool' ? 'Available to be claimed' : 'Team Member',
        visibleCardsCount: aItems.length,
        totalCount: aItems.length,
        canonicalProgress: {
          totalUnits: total,
          completedUnits: completed,
          percent: progress
        },
        columns: splitIntoColumns(aItems)
      });
    }

    return swimlanes.sort((a, b) => {
      if (a.title === 'Unassigned Pool') return 1;
      if (b.title === 'Unassigned Pool') return -1;
      return b.visibleCardsCount - a.visibleCardsCount;
    });
  }

  if (mode === 'priority') {
    const priorityLabels: Record<number, string> = {
      1: 'P1 — Critical Priority',
      2: 'P2 — High Priority',
      3: 'P3 — Medium Priority',
      4: 'P4 — Low Priority'
    };

    const priorityMap = new Map<number, WorkItem[]>();
    for (const item of sorted) {
      const p = item.priority || 3;
      if (!priorityMap.has(p)) {
        priorityMap.set(p, []);
      }
      priorityMap.get(p)!.push(item);
    }

    const swimlanes: KanbanSwimlane[] = [];
    const orderedPriorities = [1, 2, 3, 4];
    for (const p of orderedPriorities) {
      const pItems = priorityMap.get(p) || [];
      if (pItems.length === 0) continue;
      const { total, completed, progress } = computeProgress(pItems);
      swimlanes.push({
        id: `priority-${p}`,
        title: priorityLabels[p] || `P${p} Priority`,
        subtitle: p === 1 ? 'Immediate attention needed' : undefined,
        visibleCardsCount: pItems.length,
        totalCount: pItems.length,
        canonicalProgress: {
          totalUnits: total,
          completedUnits: completed,
          percent: progress
        },
        columns: splitIntoColumns(pItems)
      });
    }

    return swimlanes;
  }

  return [];
}
