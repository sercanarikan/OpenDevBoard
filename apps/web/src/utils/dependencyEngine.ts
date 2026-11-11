import type { WorkItem } from '../types';
import { isWorkItemCompleted } from './workState';

export interface BlockedEvaluationResult {
  isBlocked: boolean;
  isBlocking: boolean;
  blockingPredecessors: { id: number; title: string; state: string; isCompleted: boolean }[];
  resolvedPredecessors: { id: number; title: string; state: string; isCompleted: boolean }[];
  /** Predecessors whose state could not be verified (target missing, deleted or inaccessible). */
  unresolvedPredecessors: { id: number; title: string }[];
  hasUnresolvedPredecessors: boolean;
  blockedSuccessors: { id: number; title: string; state: string }[];
}

/** A relation target counts as "known" only when a real state is available for it. Never invented. */
function knownState(...candidates: (string | undefined | null)[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  return null;
}

/**
 * Accurately determines if a work item is blocked by analyzing its predecessor relations
 * using the centralized Azure DevOps completion rules.
 *
 * A work item is blocked if it has at least one predecessor whose state is KNOWN and NOT completed
 * (e.g. Active, New, In Progress, Resolved, or any custom state).
 *
 * A predecessor whose state cannot be verified is UNKNOWN. It is neither a blocker nor a resolved predecessor:
 * inventing a state (the old behaviour defaulted to 'New') produced a confident "Blocked" verdict without any
 * evidence. Unknown predecessors are reported separately so the UI can say "unresolved" explicitly.
 */
export function evaluateItemBlockedStatus(
  item: WorkItem,
  allItemsMap?: Map<number, WorkItem>
): BlockedEvaluationResult {
  const blockingPredecessors: { id: number; title: string; state: string; isCompleted: boolean }[] = [];
  const resolvedPredecessors: { id: number; title: string; state: string; isCompleted: boolean }[] = [];
  const unresolvedPredecessors: { id: number; title: string }[] = [];
  const blockedSuccessors: { id: number; title: string; state: string }[] = [];

  const selfCompleted = isWorkItemCompleted(item.state, item.type);

  // Analyze predecessors (upstream)
  for (const pred of item.relations?.predecessors || []) {
    const fullTarget = allItemsMap?.get(pred.id);
    const targetState = knownState(fullTarget?.state, pred.state);
    const targetType = fullTarget?.type || pred.type || '';
    const targetTitle = fullTarget?.title || pred.title || '';

    if (targetState === null) {
      unresolvedPredecessors.push({ id: pred.id, title: targetTitle });
      continue;
    }

    const isCompleted = isWorkItemCompleted(targetState, targetType);

    if (isCompleted) {
      resolvedPredecessors.push({
        id: pred.id,
        title: targetTitle,
        state: targetState,
        isCompleted: true
      });
    } else {
      blockingPredecessors.push({
        id: pred.id,
        title: targetTitle,
        state: targetState,
        isCompleted: false
      });
    }
  }

  // Analyze successors (downstream)
  for (const succ of item.relations?.successors || []) {
    const fullTarget = allItemsMap?.get(succ.id);
    const targetState = knownState(fullTarget?.state, succ.state) ?? '';
    const targetTitle = fullTarget?.title || succ.title || '';

    if (!selfCompleted) {
      blockedSuccessors.push({
        id: succ.id,
        title: targetTitle,
        state: targetState
      });
    }
  }

  // Evidence only: a stale item.isBlocked flag never overrides what the (verified) predecessors say.
  const isBlocked = blockingPredecessors.length > 0;
  const isBlocking = blockedSuccessors.length > 0 || (item.relations?.successors?.length > 0 && !selfCompleted);

  return {
    isBlocked,
    isBlocking,
    blockingPredecessors,
    resolvedPredecessors,
    unresolvedPredecessors,
    hasUnresolvedPredecessors: unresolvedPredecessors.length > 0,
    blockedSuccessors
  };
}

/**
 * Detects circular dependency cycles in predecessor/successor graphs using DFS.
 * Returns arrays of work item IDs representing any cyclic path (e.g. [1, 2, 3, 1]).
 */
export function detectDependencyCycles(items: WorkItem[]): number[][] {
  const adj = new Map<number, Set<number>>();

  for (const item of items) {
    if (!adj.has(item.id)) adj.set(item.id, new Set());

    // Edge direction: Predecessor -> Successor
    for (const succ of item.relations?.successors || []) {
      adj.get(item.id)!.add(succ.id);
    }
    for (const pred of item.relations?.predecessors || []) {
      if (!adj.has(pred.id)) adj.set(pred.id, new Set());
      adj.get(pred.id)!.add(item.id);
    }
  }

  const visited = new Set<number>();
  const recStack = new Set<number>();
  const cycles: number[][] = [];
  const currentPath: number[] = [];

  function dfs(node: number) {
    visited.add(node);
    recStack.add(node);
    currentPath.push(node);

    const neighbors = adj.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recStack.has(neighbor)) {
        // Cycle detected
        const cycleStartIndex = currentPath.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          cycles.push([...currentPath.slice(cycleStartIndex), neighbor]);
        }
      }
    }

    recStack.delete(node);
    currentPath.pop();
  }

  for (const id of adj.keys()) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  return cycles;
}

export interface DependencyGraphNodeData {
  [key: string]: unknown;
  item: WorkItem;
  isFocused: boolean;
  isSelected?: boolean;
  hopDistance: number; // 0 = focus, -1 = pred, +1 = succ, etc.
  blockedEvaluation: BlockedEvaluationResult;
  /** True when this node's data could not be read (it is drawn as an explicit "unresolved" placeholder). */
  isUnresolved: boolean;
  onSetFocus?: (id: number) => void;
}

export interface DependencyGraphEdgeData {
  fromId: number;
  toId: number;
  isCompleted: boolean;
  isBlocking: boolean;
  /** The upstream item's state could not be verified: the edge is neutral (neither blocking nor completed). */
  isUnresolved: boolean;
}

export interface FocusedGraphResult {
  nodes: {
    id: string;
    position: { x: number; y: number };
    data: DependencyGraphNodeData;
    type: string;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    data: DependencyGraphEdgeData;
    animated?: boolean;
    style?: Record<string, any>;
  }[];
  focusedItem: WorkItem | null;
  hasCycles: boolean;
  cyclePaths: number[][];
  asymmetries: { fromId: number; toId: number; declaredBy: 'source' | 'target' }[];
  connectedComponentSize?: number;
}

/**
 * Builds a clean, focused, layered dependency graph centered around a focused Work Item.
 * Predecessors are positioned to the LEFT (Rank < 0).
 * Focused item is positioned in the CENTER (Rank = 0).
 * Successors are positioned to the RIGHT (Rank > 0).
 *
 * Edge direction: Predecessor (source) ➔ Successor (target).
 */
export function buildFocusedDependencyGraph(
  focusId: number,
  allItems: WorkItem[],
  options: {
    hops: 1 | 2 | 'all' | 'connected';
    hideCompleted?: boolean;
  }
): FocusedGraphResult {
  const itemMap = new Map<number, WorkItem>();
  for (const item of allItems) {
    itemMap.set(item.id, item);
  }

  const focusedItem = itemMap.get(focusId) || null;
  if (!focusedItem) {
    return {
      nodes: [],
      edges: [],
      focusedItem: null,
      hasCycles: false,
      cyclePaths: [],
      asymmetries: []
    };
  }

  // Detect any global cycles
  const cycles = detectDependencyCycles(allItems);

  // Index directed relations bidirectionally to guard against asymmetric/incomplete link snapshots:
  // If A declares predecessor B, B is also a predecessor of A in directPreds, and A is in directSuccs of B.
  // If B declares successor A, A is in directSuccs of B, and B is in directPreds of A.
  const directPreds = new Map<number, Set<number>>();
  const directSuccs = new Map<number, Set<number>>();
  const asymmetries: { fromId: number; toId: number; declaredBy: 'source' | 'target' }[] = [];

  for (const item of allItems) {
    if (!directPreds.has(item.id)) directPreds.set(item.id, new Set());
    if (!directSuccs.has(item.id)) directSuccs.set(item.id, new Set());
  }

  for (const item of allItems) {
    for (const pred of item.relations?.predecessors || []) {
      directPreds.get(item.id)!.add(pred.id);
      if (!directSuccs.has(pred.id)) directSuccs.set(pred.id, new Set());
      directSuccs.get(pred.id)!.add(item.id);
    }
    for (const succ of item.relations?.successors || []) {
      directSuccs.get(item.id)!.add(succ.id);
      if (!directPreds.has(succ.id)) directPreds.set(succ.id, new Set());
      directPreds.get(succ.id)!.add(item.id);
    }
  }

  // Detect and track asymmetries (declared by one side only)
  for (const item of allItems) {
    const declaredPreds = new Set((item.relations?.predecessors || []).map(p => p.id));
    const declaredSuccs = new Set((item.relations?.successors || []).map(s => s.id));

    for (const predId of declaredPreds) {
      const predItem = itemMap.get(predId);
      if (predItem && !(predItem.relations?.successors || []).some(s => s.id === item.id)) {
        asymmetries.push({ fromId: predId, toId: item.id, declaredBy: 'target' });
      }
    }
    for (const succId of declaredSuccs) {
      const succItem = itemMap.get(succId);
      if (succItem && !(succItem.relations?.predecessors || []).some(p => p.id === item.id)) {
        asymmetries.push({ fromId: item.id, toId: succId, declaredBy: 'source' });
      }
    }
  }

  // Track node hop distance from focus node: -2, -1, 0, +1, +2...
  const nodeHopMap = new Map<number, number>();
  nodeHopMap.set(focusId, 0);

  if (options.hops === 'connected') {
    // Weakly Connected Component traversal:
    // Traverses both upstream and downstream from any reached node until the entire component is explored.
    const queue: { id: number; hop: number }[] = [{ id: focusId, hop: 0 }];

    while (queue.length > 0) {
      const { id: currId, hop: currHop } = queue.shift()!;
      const currItem = itemMap.get(currId);
      const currState = knownState(currItem?.state);
      const isCurrCompleted = currState !== null && isWorkItemCompleted(currState, currItem?.type);

      // Explore Predecessors (Upstream, rank becomes hop - 1)
      for (const predId of directPreds.get(currId) || []) {
        const fullPred = itemMap.get(predId);
        const predState = knownState(fullPred?.state);
        const isPredCompleted = predState !== null && isWorkItemCompleted(predState, fullPred?.type);

        if (options.hideCompleted && isPredCompleted) {
          continue;
        }

        if (!nodeHopMap.has(predId)) {
          const nextHop = currHop - 1;
          nodeHopMap.set(predId, nextHop);
          queue.push({ id: predId, hop: nextHop });
        }
      }

      // Explore Successors (Downstream, rank becomes hop + 1)
      for (const succId of directSuccs.get(currId) || []) {
        if (options.hideCompleted && isCurrCompleted) {
          continue; // Skip outgoing links from completed items
        }

        if (!nodeHopMap.has(succId)) {
          const nextHop = currHop + 1;
          nodeHopMap.set(succId, nextHop);
          queue.push({ id: succId, hop: nextHop });
        }
      }
    }
  } else {
    // Directed Chain traversal: Upstream predecessors + Downstream successors
    // options.hops === 'all' is UNBOUNDED (full chain to roots and leaves)
    const maxHops = options.hops === 'all' ? Infinity : options.hops;

    // 1. Traverse Predecessors (Upstream, rank < 0)
    let currentPredQueue = [focusId];
    let currentHop = 1;
    while (currentPredQueue.length > 0 && currentHop <= maxHops) {
      const nextQueue: number[] = [];
      for (const currId of currentPredQueue) {
        for (const predId of directPreds.get(currId) || []) {
          const fullPred = itemMap.get(predId);
          const predState = knownState(fullPred?.state);
          // Unknown state: not known to be complete, so hide-completed must keep it visible.
          const isCompleted = predState !== null && isWorkItemCompleted(predState, fullPred?.type);

          if (options.hideCompleted && isCompleted) {
            continue; // Skip completed dependency
          }

          if (!nodeHopMap.has(predId)) {
            nodeHopMap.set(predId, -currentHop);
            nextQueue.push(predId);
          }
        }
      }
      currentPredQueue = nextQueue;
      currentHop++;
    }

    // 2. Traverse Successors (Downstream, rank > 0)
    let currentSuccQueue = [focusId];
    currentHop = 1;
    while (currentSuccQueue.length > 0 && currentHop <= maxHops) {
      const nextQueue: number[] = [];
      for (const currId of currentSuccQueue) {
        const currItem = itemMap.get(currId);
        const currState = knownState(currItem?.state);
        const isCurrCompleted = currState !== null && isWorkItemCompleted(currState, currItem?.type);

        if (options.hideCompleted && isCurrCompleted) {
          continue; // Skip if source is completed
        }

        for (const succId of directSuccs.get(currId) || []) {
          if (!nodeHopMap.has(succId)) {
            nodeHopMap.set(succId, currentHop);
            nextQueue.push(succId);
          }
        }
      }
      currentSuccQueue = nextQueue;
      currentHop++;
    }
  }

  // Group nodes by hop column for layout calculation
  const columns = new Map<number, number[]>();
  for (const [id, hop] of nodeHopMap.entries()) {
    if (!columns.has(hop)) columns.set(hop, []);
    columns.get(hop)!.push(id);
  }

  // Calculate layout coordinates
  // Horizontal spacing: 310px per column
  // Center (hop 0) is at X = 620
  const COLUMN_WIDTH = 310;
  const ROW_HEIGHT = 130;
  const CENTER_X = 620;

  const nodes: FocusedGraphResult['nodes'] = [];
  const validNodeIds = new Set(nodeHopMap.keys());

  for (const [hop, ids] of columns.entries()) {
    const x = CENTER_X + hop * COLUMN_WIDTH;
    const totalColHeight = ids.length * ROW_HEIGHT;
    const startY = Math.max(80, 400 - totalColHeight / 2);

    ids.forEach((id, index) => {
      const y = startY + index * ROW_HEIGHT;
      let item = itemMap.get(id);
      let isUnresolved = false;

      // A relation target that is not in the item list: use the relation snapshot stored with the referencing item
      // (real title/state/type/assignee). If even that is missing the node is an explicit "unresolved" placeholder:
      // no invented type, state, assignee or title.
      if (!item) {
        const snap = findRelationSnapshot(id, allItems);
        const hasSnapshot = !!snap && knownState(snap.state) !== null;
        isUnresolved = !hasSnapshot;
        item = {
          id,
          title: snap?.title || '',
          type: snap?.type || '',
          state: snap?.state || '',
          project: snap?.project || '',
          assignedTo: snap?.assignedTo || '',
          isUnassigned: false,
          isBug: (snap?.type || '').toLowerCase().includes('bug'),
          isTask: (snap?.type || '').toLowerCase().includes('task'),
          priority: 3,
          changedDate: '',
          url: '',
          relations: { predecessors: [], successors: [], related: [], total: 0 },
          children: []
        };
      }

      const blockedEval = evaluateItemBlockedStatus(item, itemMap);

      nodes.push({
        id: id.toString(),
        type: 'workItemNode',
        position: { x, y },
        data: {
          item,
          isFocused: id === focusId,
          hopDistance: hop,
          blockedEvaluation: blockedEval,
          isUnresolved
        }
      });
    });
  }

  // Build directed edges: Predecessor ➔ Successor
  const edges: FocusedGraphResult['edges'] = [];
  const processedEdges = new Set<string>();
  const nodeItemMap = new Map<number, WorkItem>(nodes.map(n => [Number(n.id), n.data.item]));

  for (const id of validNodeIds) {
    const item = nodeItemMap.get(id) || itemMap.get(id);

    for (const succId of directSuccs.get(id) || []) {
      if (!validNodeIds.has(succId)) continue;

      const edgeKey = `${id}->${succId}`;
      if (processedEdges.has(edgeKey)) continue;
      processedEdges.add(edgeKey);

      const srcKnown = knownState(item?.state);
      const isUnresolved = srcKnown === null;
      const isCompleted = !isUnresolved && isWorkItemCompleted(srcKnown, item?.type);
      if (options.hideCompleted && isCompleted) continue;

      const isBlocking = !isUnresolved && !isCompleted;

      edges.push({
        id: edgeKey,
        source: id.toString(),
        target: succId.toString(),
        animated: isBlocking,
        data: {
          fromId: id,
          toId: succId,
          isCompleted,
          isBlocking,
          isUnresolved
        }
      });
    }
  }

  return {
    nodes,
    edges,
    focusedItem,
    hasCycles: cycles.length > 0,
    cyclePaths: cycles,
    asymmetries,
    connectedComponentSize: validNodeIds.size
  };
}

/** Real data about a relation target, taken from any referencing item's relation entries (stored by the sync). */
function findRelationSnapshot(id: number, items: WorkItem[]) {
  for (const it of items) {
    for (const list of [it.relations?.predecessors, it.relations?.successors, it.relations?.related]) {
      const hit = list?.find(r => r.id === id && (r.title || r.state));
      if (hit) return hit;
    }
  }
  return null;
}
