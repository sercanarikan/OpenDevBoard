import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../types';
import { computeWorkCounts, computeProjectTotals, scopeItems, isAssignedTo } from './counts';

function make(partial: Partial<WorkItem> & { id: number }): WorkItem {
  return {
    title: `Item ${partial.id}`,
    type: 'Task',
    state: 'New',
    project: 'P1',
    assignedTo: '',
    isUnassigned: true,
    isBlocked: false,
    isBlocking: false,
    isBug: false,
    isTask: true,
    priority: 2,
    relations: { predecessors: [], successors: [], related: [] },
    ...partial
  } as unknown as WorkItem;
}

const ME = 'Fixture Person A';

const items: WorkItem[] = [
  make({ id: 1, assignedTo: ME, isUnassigned: false, state: 'In Progress' }),
  make({ id: 2, assignedTo: ME, isUnassigned: false, state: 'Done' }),
  make({ id: 3, assignedTo: ME, isUnassigned: false, state: 'Resolved' }),
  make({ id: 4, assignedTo: 'Someone Else', isUnassigned: false, isBlocked: true, project: 'P2' }),
  make({ id: 5, isBug: true, type: 'Bug', project: 'P2' }),
  make({ id: 6, state: 'Closed', project: 'P2' })
];

describe('computeWorkCounts', () => {
  it('keeps total, active and completed as separate scopes that add up', () => {
    const c = computeWorkCounts(items, { currentUser: ME });
    expect(c.total).toBe(6);
    expect(c.completed).toBe(2);
    expect(c.active).toBe(4);
    expect(c.active + c.completed).toBe(c.total);
  });

  it('My Tasks equals the rows the My Tasks list filter returns', () => {
    const c = computeWorkCounts(items, { currentUser: ME });
    const listRows = items.filter(i => isAssignedTo(i, ME));
    expect(c.myTasks).toBe(listRows.length);
    expect(c.myActive + c.myCompleted).toBe(c.myTasks);
    expect(c.myCompleted).toBe(1);
    expect(c.myActive).toBe(2);
  });

  it('does not treat Resolved as completed', () => {
    const c = computeWorkCounts([make({ id: 9, state: 'Resolved' })]);
    expect(c.completed).toBe(0);
    expect(c.active).toBe(1);
  });

  it('applies the project scope to every counter', () => {
    const c = computeWorkCounts(items, { project: 'P2', currentUser: ME });
    expect(c.total).toBe(3);
    expect(c.completed).toBe(1);
    expect(c.blocked).toBe(1);
    expect(c.bugs).toBe(1);
    expect(c.myTasks).toBe(0);
  });

  it('treats project "all" as no scope', () => {
    expect(computeWorkCounts(items, { project: 'all' }).total).toBe(items.length);
    expect(scopeItems(items, 'all')).toBe(items);
  });

  it('never matches an empty assignee when the current user is unknown', () => {
    expect(computeWorkCounts(items, { currentUser: '' }).myTasks).toBe(0);
    expect(isAssignedTo(make({ id: 1 }), '')).toBe(false);
  });

  it('is independent of any hard-coded record count', () => {
    const many = Array.from({ length: 3217 }, (_, i) => make({ id: i + 1 }));
    const c = computeWorkCounts(many);
    expect(c.total).toBe(3217);
    expect(c.active).toBe(3217);
    expect(c.unassigned).toBe(3217);
  });

  it('project totals sum to the overall total and match scoped totals', () => {
    const totals = computeProjectTotals(items);
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(computeWorkCounts(items).total);
    expect(totals.P2).toBe(computeWorkCounts(items, { project: 'P2' }).total);
  });
});
