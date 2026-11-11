import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../types';
import { buildProgressHierarchy, type ContextItem } from './contextHierarchy';
import { computeCanonicalProgressMap } from './progress';

const item = (id: number, state: string, parentId: number | null = null, type = 'Task'): WorkItem => ({
  id, title: `T${id}`, type, state, project: 'P', assignedTo: 'Ada', isUnassigned: false, isBug: false, isTask: type === 'Task',
  parentId, changedDate: '2026-11-05', priority: 2, url: '', relations: { predecessors: [], successors: [], related: [], total: 0 }, children: []
});

const ctx = (id: number, state: string, parentId: number | null, type = 'Task'): ContextItem => ({
  id, title: `C${id}`, type, state, project: 'P', parentId
});

describe('buildProgressHierarchy', () => {
  it('counts completed children that only exist as context rows (progress must not read 0%)', () => {
    const active = [item(10, 'Active', null, 'User Story'), item(11, 'New', 10), item(12, 'In Progress', 10)];
    const context = [ctx(13, 'Done', 10), ctx(14, 'Closed', 10)];
    const roots = buildProgressHierarchy(active, context);
    const p = computeCanonicalProgressMap(roots).get(10)!;
    expect(p.totalUnits).toBe(4);
    expect(p.completedUnits).toBe(2);
    expect(p.percent).toBe(50);
  });

  it('without the context rows the same story reads 0% (the bug this guards against)', () => {
    const active = [item(10, 'Active', null, 'User Story'), item(11, 'New', 10), item(12, 'In Progress', 10)];
    const p = computeCanonicalProgressMap(buildProgressHierarchy(active, [])).get(10)!;
    expect(p.completedUnits).toBe(0);
    expect(p.percent).toBe(0);
  });

  it('never duplicates an item that is present in both lists (active scope wins)', () => {
    const active = [item(10, 'Active', null, 'User Story'), item(11, 'New', 10)];
    const context = [ctx(11, 'Done', 10), ctx(12, 'Done', 10)];
    const p = computeCanonicalProgressMap(buildProgressHierarchy(active, context)).get(10)!;
    expect(p.totalUnits).toBe(2);
    expect(p.completedUnits).toBe(1);
  });

  it('keeps Resolved out of the completed count and Removed out of scope', () => {
    const active = [item(10, 'Active', null, 'User Story'), item(11, 'Resolved', 10)];
    const context = [ctx(12, 'Removed', 10), ctx(13, 'Done', 10)];
    const p = computeCanonicalProgressMap(buildProgressHierarchy(active, context)).get(10)!;
    expect(p.totalUnits).toBe(2); // Resolved + Done; Removed excluded
    expect(p.completedUnits).toBe(1);
  });

  it('places context ancestors above active items so Epic/Feature progress is complete', () => {
    const active = [item(30, 'Active', 20, 'User Story'), item(31, 'Active', 30)];
    const context = [ctx(20, 'Active', 10, 'Feature'), ctx(10, 'Active', null, 'Epic'), ctx(32, 'Done', 30)];
    const map = computeCanonicalProgressMap(buildProgressHierarchy(active, context));
    expect(map.get(10)!.totalUnits).toBe(2);
    expect(map.get(10)!.completedUnits).toBe(1);
    expect(map.get(20)!.percent).toBe(50);
  });
});
