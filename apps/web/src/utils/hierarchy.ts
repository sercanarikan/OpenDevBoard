import type { WorkItem } from '../types';
import { isWorkItemCompleted } from './workState';

/**
 * Builds a clean nested hierarchy tree from flat items.
 * Correctly connects parentId to parent.children and identifies top-level root items (Epics/orphans).
 * Evaluates isBlocked and isBlocking flags based on centralized workState completion rules.
 */
export function buildHierarchyTree(items: WorkItem[]): WorkItem[] {
  const itemMap = new Map<number, WorkItem>();

  // Clone items to avoid mutating originals
  items.forEach(item => {
    itemMap.set(item.id, { ...item, children: [] });
  });

  const rootItems: WorkItem[] = [];

  itemMap.forEach(item => {
    const hasUnresolvedPredecessor = item.relations?.predecessors?.some(
      p => !isWorkItemCompleted(p.state || '', p.type || '')
    ) || false;
    item.isBlocked = hasUnresolvedPredecessor;
    item.isBlocking = (item.relations?.successors?.length || 0) > 0;

    if (item.parentId && itemMap.has(item.parentId)) {
      const parent = itemMap.get(item.parentId)!;
      parent.children.push(item);
    } else {
      rootItems.push(item);
    }
  });

  return rootItems;
}
