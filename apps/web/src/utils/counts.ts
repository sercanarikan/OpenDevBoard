import type { WorkItem } from '../types';
import { isWorkItemCompleted } from './workState';

/**
 * Single source of truth for every counter shown in the UI.
 *
 * Scope definitions (never mix them):
 *  - loaded scope : the work items the UI holds (poolData.flat_items), optionally narrowed to one project.
 *                   Every tab/sidebar/header counter is computed from this scope, with the SAME predicate the
 *                   corresponding list filter uses, so "tab count === rows shown" always holds.
 *  - completed    : loaded-scope items in a terminal state (Done / Closed / Completed). Resolved is NOT completed.
 *  - active       : loaded-scope items that are not completed.
 *  - org snapshot : the WIQL count captured at the last sync (summary.total_active_in_org / counts.total_org_active).
 *                   Informational only. It may legitimately differ from the loaded scope (items changed after the
 *                   snapshot, parents / dependency targets pulled in for hierarchy context), so it is never used
 *                   as a screen counter.
 */
export interface WorkCountScope {
  project?: string;
  currentUser?: string;
}

export interface WorkCounts {
  total: number;
  active: number;
  completed: number;
  /** Items assigned to the current user (matches the My Tasks list filter). */
  myTasks: number;
  myActive: number;
  myCompleted: number;
  unassigned: number;
  blocked: number;
  bugs: number;
}

export function scopeItems(items: WorkItem[], project?: string): WorkItem[] {
  if (!project || project === 'all') return items;
  return items.filter(i => i.project === project);
}

/** Predicate shared by the My Tasks counter and the My Tasks list filter. */
export function isAssignedTo(item: WorkItem, user?: string): boolean {
  const u = (user || '').trim();
  return u !== '' && (item.assignedTo || '').trim() === u;
}

export function computeWorkCounts(items: WorkItem[], scope: WorkCountScope = {}): WorkCounts {
  const scoped = scopeItems(items, scope.project);

  const counts: WorkCounts = {
    total: scoped.length,
    active: 0,
    completed: 0,
    myTasks: 0,
    myActive: 0,
    myCompleted: 0,
    unassigned: 0,
    blocked: 0,
    bugs: 0
  };

  for (const item of scoped) {
    const done = isWorkItemCompleted(item.state, item.type);
    const mine = isAssignedTo(item, scope.currentUser);

    if (done) counts.completed++;
    else counts.active++;

    if (mine) {
      counts.myTasks++;
      if (done) counts.myCompleted++;
      else counts.myActive++;
    }
    if (item.isUnassigned) counts.unassigned++;
    if (item.isBlocked) counts.blocked++;
    if (item.isBug) counts.bugs++;
  }

  return counts;
}

/** Per-project totals from the same items, so the project selector agrees with the tabs. */
export function computeProjectTotals(items: WorkItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.project] = (out[item.project] || 0) + 1;
  return out;
}
