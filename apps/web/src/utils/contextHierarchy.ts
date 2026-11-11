import type { WorkItem } from '../types';
import { buildHierarchyTree } from './hierarchy';

/** Context rows from /api/work-items-pool: just enough to place an item in the hierarchy and score it. */
export interface ContextItem {
  id: number;
  title: string;
  type: string;
  state: string;
  project: string;
  assignedTo?: string;
  priority?: number;
  changedDate?: string;
  parentId?: number | null;
  isBlocked?: boolean;
  isUnassigned?: boolean;
  /** Own relation ids, so the dependency graph can keep walking through completed items. */
  predecessorIds?: number[];
  successorIds?: number[];
}

function toWorkItem(c: ContextItem): WorkItem {
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    state: c.state,
    project: c.project,
    assignedTo: c.assignedTo ?? (c.isUnassigned ? 'Unassigned' : ''),
    isUnassigned: !!c.isUnassigned,
    isBug: c.type.toLowerCase().includes('bug'),
    isTask: c.type.toLowerCase().includes('task'),
    parentId: c.parentId ?? null,
    changedDate: c.changedDate ?? '',
    priority: c.priority ?? 3,
    url: '',
    relations: {
      predecessors: (c.predecessorIds ?? []).map(id => ({ id, relType: 'predecessor' as const, relName: 'Predecessor', url: '' })),
      successors: (c.successorIds ?? []).map(id => ({ id, relType: 'successor' as const, relName: 'Successor', url: '' })),
      related: [],
      total: (c.predecessorIds?.length ?? 0) + (c.successorIds?.length ?? 0)
    },
    children: [],
    isBlocked: !!c.isBlocked
  };
}

/**
 * Complete hierarchy for canonical progress: the active scope plus completed descendants, ancestors and other
 * context rows. Items are de-duplicated by id (active scope wins), so no leaf is counted twice.
 *
 * Canonical progress must never depend on what a page happens to show: completed children live only in the context
 * rows, and without them every story would read 0 %.
 */
export function buildProgressHierarchy(active: WorkItem[], context: ContextItem[]): WorkItem[] {
  const byId = new Map<number, WorkItem>();
  for (const item of active) byId.set(item.id, item);
  for (const c of context) {
    if (!byId.has(c.id)) byId.set(c.id, toWorkItem(c));
  }
  return buildHierarchyTree(Array.from(byId.values()));
}

/**
 * Flat items for the dependency graph: the active scope plus completed items and context rows, de-duplicated by id
 * (the active item wins). The graph needs them so a Done predecessor is drawn with its real title and state.
 */
export function buildGraphItems(active: WorkItem[], context: ContextItem[]): WorkItem[] {
  const byId = new Map<number, WorkItem>();
  for (const item of active) byId.set(item.id, item);
  for (const c of context) {
    if (!byId.has(c.id)) byId.set(c.id, toWorkItem(c));
  }
  return Array.from(byId.values());
}
