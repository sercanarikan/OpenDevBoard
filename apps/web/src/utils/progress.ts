import type { WorkItem } from '../types';
import { isWorkItemCompleted, isWorkItemInScope } from './workState';

export interface RollupProgress {
  totalUnits: number;
  completedUnits: number;
  percent: number;
  blockedCount: number;
  unassignedCount: number;
  hasChildren: boolean;
}

/**
 * Computes canonical progress metrics for all Work Items in a hierarchy.
 *
 * Rules:
 * 1. Scope Definition:
 *    - User Story / PBI:
 *      - If it has child Tasks/Bugs: progress is computed from unique in-scope child Tasks/Bugs.
 *      - If it has NO child tasks: it is evaluated as an atomic unit (1 unit; completed if story itself is completed).
 *    - Feature:
 *      - Evaluates all unique leaf deliverables under all its User Stories, plus any direct tasks.
 *      - Each unique leaf work item is counted exactly once (deduplicated by item.id).
 *    - Epic:
 *      - Evaluates all unique leaf deliverables under all its Features and User Stories.
 *      - Each unique leaf work item is counted exactly once.
 * 2. Filter Independence:
 *    - Progress is pre-computed from the FULL unfiltered hierarchy.
 *    - Applying UI filters (Blocked, Unassigned, Search) NEVER alters the canonical progress of a parent item.
 * 3. Cycle & Orphan Protection:
 *    - A visited Set prevents infinite loops on circular parent references.
 */
export function computeCanonicalProgressMap(
  hierarchyRoots: WorkItem[]
): Map<number, RollupProgress> {
  const progressMap = new Map<number, RollupProgress>();
  const visited = new Set<number>();

  /**
   * Returns a map of all unique leaf Work Items under `node`.
   * Key: item.id, Value: WorkItem
   */
  function collectLeafWorkUnits(node: WorkItem, path = new Set<number>()): Map<number, WorkItem> {
    const leafMap = new Map<number, WorkItem>();

    if (path.has(node.id)) {
      // Circular reference detected; abort cycle
      return leafMap;
    }
    path.add(node.id);

    if (!node.children || node.children.length === 0) {
      // Leaf node: in-scope tasks/bugs or standalone stories
      if (isWorkItemInScope(node.state)) {
        leafMap.set(node.id, node);
      }
      path.delete(node.id);
      return leafMap;
    }

    // Node has children: collect all descendants
    for (const child of node.children) {
      const childLeaves = collectLeafWorkUnits(child, path);
      for (const [id, item] of childLeaves.entries()) {
        leafMap.set(id, item);
      }
    }

    path.delete(node.id);
    return leafMap;
  }

  function evaluateNode(node: WorkItem) {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    const hasChildren = !!(node.children && node.children.length > 0);
    const leafMap = collectLeafWorkUnits(node);

    let totalUnits = 0;
    let completedUnits = 0;
    let blockedCount = 0;
    let unassignedCount = 0;

    for (const leaf of leafMap.values()) {
      totalUnits++;
      if (isWorkItemCompleted(leaf.state, leaf.type)) {
        completedUnits++;
      }
      if (leaf.isBlocked) {
        blockedCount++;
      }
      if (leaf.isUnassigned) {
        unassignedCount++;
      }
    }

    const percent = totalUnits > 0 ? Math.round((completedUnits / totalUnits) * 100) : 0;

    progressMap.set(node.id, {
      totalUnits,
      completedUnits,
      percent,
      blockedCount,
      unassignedCount,
      hasChildren
    });

    // Recursively evaluate children
    if (hasChildren) {
      for (const child of node.children) {
        evaluateNode(child);
      }
    }
  }

  for (const root of hierarchyRoots) {
    evaluateNode(root);
  }

  return progressMap;
}
