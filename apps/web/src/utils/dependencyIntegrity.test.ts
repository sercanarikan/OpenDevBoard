import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../types';
import { buildFocusedDependencyGraph, evaluateItemBlockedStatus } from './dependencyEngine';
import { buildGraphItems, type ContextItem } from './contextHierarchy';

const rel = (kind: 'predecessor' | 'successor', id: number, extra: Record<string, unknown> = {}) => ({
  id, relType: kind, relName: kind === 'predecessor' ? 'Predecessor' : 'Successor', url: '', ...extra
});

const item = (id: number, state: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id, title: `Item ${id}`, type: 'Task', state, project: 'P', assignedTo: 'Ada', isUnassigned: false, isBug: false, isTask: true,
  priority: 2, changedDate: '2026-11-05', url: '', relations: { predecessors: [], successors: [], related: [], total: 0 }, children: [], ...over
});

const withRels = (w: WorkItem, preds: ReturnType<typeof rel>[] = [], succs: ReturnType<typeof rel>[] = []): WorkItem => ({
  ...w, relations: { predecessors: preds, successors: succs, related: [], total: preds.length + succs.length }
});

describe('dependency relation integrity: unknown predecessors', () => {
  it('an unresolvable predecessor is UNKNOWN: not blocking, not resolved, never an invented state', () => {
    const dependent = withRels(item(10, 'In Progress'), [rel('predecessor', 999)]); // no title/state: could not be read
    const ev = evaluateItemBlockedStatus(dependent, new Map([[10, dependent]]));
    expect(ev.blockingPredecessors).toHaveLength(0);
    expect(ev.resolvedPredecessors).toHaveLength(0);
    expect(ev.unresolvedPredecessors.map(p => p.id)).toEqual([999]);
    expect(ev.isBlocked).toBe(false);
    expect(ev.hasUnresolvedPredecessors).toBe(true);
  });

  it('a known incomplete predecessor still blocks even when another one is unknown', () => {
    const dependent = withRels(item(10, 'New'), [rel('predecessor', 999), rel('predecessor', 20, { state: 'Active', title: 'A' })]);
    const ev = evaluateItemBlockedStatus(dependent, new Map([[10, dependent]]));
    expect(ev.isBlocked).toBe(true);
    expect(ev.blockingPredecessors.map(p => p.id)).toEqual([20]);
    expect(ev.unresolvedPredecessors.map(p => p.id)).toEqual([999]);
  });

  it('a completed predecessor clears the item and is not reported as unresolved', () => {
    const dependent = withRels(item(10, 'New'), [rel('predecessor', 20, { state: 'Done', title: 'Real title' })]);
    const ev = evaluateItemBlockedStatus(dependent);
    expect(ev.isBlocked).toBe(false);
    expect(ev.resolvedPredecessors[0].title).toBe('Real title');
    expect(ev.hasUnresolvedPredecessors).toBe(false);
  });

  it('does not trust a stale item.isBlocked flag when the evidence is only unknown', () => {
    const dependent = { ...withRels(item(10, 'New'), [rel('predecessor', 999)]), isBlocked: true };
    expect(evaluateItemBlockedStatus(dependent).isBlocked).toBe(false);
  });

  it('Resolved is still not completed (blocks), unknown states are never silently "done"', () => {
    const a = withRels(item(10, 'New'), [rel('predecessor', 20, { state: 'Resolved' })]);
    const b = withRels(item(11, 'New'), [rel('predecessor', 21, { state: 'Weird State' })]);
    expect(evaluateItemBlockedStatus(a).isBlocked).toBe(true);
    expect(evaluateItemBlockedStatus(b).isBlocked).toBe(true);
  });
});

describe('dependency graph: relation targets resolve to real data', () => {
  it('does not fabricate a Task/New/Unassigned node for an unreadable target', () => {
    const focus = withRels(item(10, 'Active'), [rel('predecessor', 999)]);
    const g = buildFocusedDependencyGraph(10, [focus], { hops: 2 });
    const node = g.nodes.find(n => n.id === '999')!;
    expect(node).toBeTruthy();
    expect(node.data.item.state).toBe('');          // not 'New'
    expect(node.data.item.title).toBe('');          // not a made-up title
    expect(node.data.item.isUnassigned).toBe(false); // not 'Unassigned'
    expect(node.data.item.assignedTo).toBe('');
    expect(node.data.isUnresolved).toBe(true);
    expect(g.nodes.find(n => n.id === '10')!.data.blockedEvaluation.isBlocked).toBe(false);
  });

  it('uses the relation snapshot for a target outside the item list (real title/state, not a placeholder)', () => {
    const focus = withRels(item(10, 'Active'), [rel('predecessor', 20, { title: 'Real predecessor', state: 'Done', type: 'Bug', assignedTo: 'Grace', project: 'Q' })]);
    const g = buildFocusedDependencyGraph(10, [focus], { hops: 2 });
    const node = g.nodes.find(n => n.id === '20')!;
    expect(node.data.item.title).toBe('Real predecessor');
    expect(node.data.item.state).toBe('Done');
    expect(node.data.item.type).toBe('Bug');
    expect(node.data.item.assignedTo).toBe('Grace');
    expect(node.data.isUnresolved).toBe(false);
  });

  it('resolves a completed predecessor from the graph items (active scope + completed/context rows)', () => {
    const active = withRels(item(10, 'In Progress'), [rel('predecessor', 20)]);
    const context: ContextItem[] = [{ id: 20, title: 'Done upstream', type: 'Task', state: 'Done', project: 'P', assignedTo: 'Grace', isUnassigned: false, priority: 1, predecessorIds: [], successorIds: [10] }];
    const graphItems = buildGraphItems([active], context);
    const g = buildFocusedDependencyGraph(10, graphItems, { hops: 2 });
    const node = g.nodes.find(n => n.id === '20')!;
    expect(node.data.item.title).toBe('Done upstream');
    expect(node.data.item.state).toBe('Done');
    expect(node.data.item.assignedTo).toBe('Grace');
    expect(node.data.isUnresolved).toBe(false);
    expect(g.nodes.find(n => n.id === '10')!.data.blockedEvaluation.isBlocked).toBe(false);
    expect(g.edges.some(e => e.source === '20' && e.target === '10')).toBe(true); // Predecessor -> Successor
  });

  it('the edge from an unknown predecessor is neutral: not a blocking (red, animated) edge and not a completed one', () => {
    const focus = withRels(item(10, 'Active'), [rel('predecessor', 999)]);
    const g = buildFocusedDependencyGraph(10, [focus], { hops: 2 });
    const edge = g.edges.find(e => e.source === '999' && e.target === '10')!;
    expect(edge).toBeTruthy();
    expect(edge.data.isBlocking).toBe(false);
    expect(edge.data.isCompleted).toBe(false);
    expect(edge.data.isUnresolved).toBe(true);
    expect(edge.animated).toBe(false);
  });

  it('edges from KNOWN predecessors keep their meaning (incomplete = blocking, Done = completed)', () => {
    const active = withRels(item(10, 'Active'), [rel('predecessor', 20, { state: 'Active' }), rel('predecessor', 30, { state: 'Done' })]);
    const g = buildFocusedDependencyGraph(10, [active], { hops: 2 });
    const blocking = g.edges.find(e => e.source === '20')!;
    const done = g.edges.find(e => e.source === '30')!;
    expect(blocking.data.isBlocking).toBe(true);
    expect(blocking.data.isUnresolved).toBe(false);
    expect(done.data.isCompleted).toBe(true);
    expect(done.data.isBlocking).toBe(false);
  });

  it('hideCompleted still treats an unknown target as visible (it is not known to be complete)', () => {
    const focus = withRels(item(10, 'Active'), [rel('predecessor', 999)]);
    const g = buildFocusedDependencyGraph(10, [focus], { hops: 2, hideCompleted: true });
    expect(g.nodes.some(n => n.id === '999')).toBe(true);
  });
});

describe('buildGraphItems', () => {
  it('never duplicates an id (active scope wins over context rows)', () => {
    const active = [item(10, 'Active')];
    const context: ContextItem[] = [
      { id: 10, title: 'ctx copy', type: 'Task', state: 'Done', project: 'P' },
      { id: 20, title: 'only ctx', type: 'Task', state: 'Closed', project: 'P' }
    ];
    const out = buildGraphItems(active, context);
    expect(out.map(i => i.id).sort()).toEqual([10, 20]);
    expect(out.find(i => i.id === 10)!.title).toBe('Item 10');
  });

  it('keeps real relations for context rows so the graph can walk through completed items', () => {
    const context: ContextItem[] = [
      { id: 20, title: 'mid', type: 'Task', state: 'Done', project: 'P', predecessorIds: [30], successorIds: [10] },
      { id: 30, title: 'root', type: 'Task', state: 'Done', project: 'P', predecessorIds: [], successorIds: [20] }
    ];
    const top = withRels(item(10, 'Active'), [rel('predecessor', 20)]);
    const g = buildFocusedDependencyGraph(10, buildGraphItems([top], context), { hops: 2 });
    expect(g.nodes.map(n => n.id).sort()).toEqual(['10', '20', '30']);
    expect(g.nodes.find(n => n.id === '30')!.data.item.title).toBe('root');
  });
});
