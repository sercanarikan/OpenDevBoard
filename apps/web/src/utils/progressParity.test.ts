import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../types';
import { computeCanonicalProgressMap } from './progress';
import { buildProgressHierarchy, type ContextItem } from './contextHierarchy';
import { demoApi, demoPool } from '../services/demoApi';
import { computeWorkCounts } from './counts';
import { isWorkItemCompleted } from './workState';

/**
 * Story & Tasks (client engine over the full hierarchy) and the Kanban swimlane progress (server canonical progress)
 * must agree. The Kanban and Story & Tasks screens read the same definitions through `demoApi` here; the Python side
 * of the same rules is covered by services/api/test_query_service.py (ProgressRuleTests).
 */
describe('canonical progress parity (client engine vs API contract)', () => {
  it('the API-contract progress equals the client engine for every item of the sample hierarchy', async () => {
    const all = demoPool();
    const clientMap = computeCanonicalProgressMap(buildProgressHierarchy(all, []));
    const ids = all.map(i => i.id);
    const api = await demoApi.progress(ids);
    for (const id of ids) {
      const c = clientMap.get(id);
      if (!c) continue;
      expect(api[id]?.percent, `percent #${id}`).toBe(c.percent);
      expect(api[id]?.totalUnits, `total #${id}`).toBe(c.totalUnits);
      expect(api[id]?.completedUnits, `completed #${id}`).toBe(c.completedUnits);
    }
  });

  it('Kanban parent-lane progress equals the canonical progress of that parent', async () => {
    const board = await demoApi.kanban({ swimlane: 'parent', quickFilter: 'all', includeCompleted: true, laneLimit: 100 });
    const lanes = board.lanes.filter(l => l.key !== 'none');
    expect(lanes.length).toBeGreaterThan(0);
    const api = await demoApi.progress(lanes.map(l => Number(l.key)));
    for (const lane of lanes) {
      const p = api[Number(lane.key)];
      if (!p || !lane.progress) continue;
      expect(lane.progress.percent, `lane ${lane.key}`).toBe(p.percent);
      expect(lane.progress.totalUnits).toBe(p.totalUnits);
    }
  });

  it('completed children that exist only as context rows are counted (progress is never page-bound)', () => {
    const story: WorkItem = { ...demoPool()[0], id: 900001, type: 'User Story', state: 'Active', parentId: null, children: [] };
    const openTask: WorkItem = { ...demoPool()[0], id: 900002, type: 'Task', state: 'New', parentId: 900001, children: [] };
    const context: ContextItem[] = [
      { id: 900003, title: 'done', type: 'Task', state: 'Done', project: story.project, parentId: 900001 },
      { id: 900004, title: 'closed', type: 'Task', state: 'Closed', project: story.project, parentId: 900001 },
      { id: 900005, title: 'removed', type: 'Task', state: 'Removed', project: story.project, parentId: 900001 }
    ];
    const withContext = computeCanonicalProgressMap(buildProgressHierarchy([story, openTask], context)).get(900001)!;
    const pageOnly = computeCanonicalProgressMap(buildProgressHierarchy([story, openTask], [])).get(900001)!;
    expect(withContext.totalUnits).toBe(3);      // open + done + closed; Removed is out of scope
    expect(withContext.completedUnits).toBe(2);
    expect(withContext.percent).toBe(67);
    expect(pageOnly.percent).toBe(0);            // what a page-bound calculation would have wrongly shown
  });

  it('Resolved is not completed, Done/Closed/Completed are, unknown states never are', () => {
    expect(isWorkItemCompleted('Resolved')).toBe(false);
    expect(isWorkItemCompleted('Weird State')).toBe(false);
    for (const s of ['Done', 'Closed', 'Completed']) expect(isWorkItemCompleted(s)).toBe(true);
  });
});

describe('counters are independent of paging', () => {
  it('summary == list total for every quick filter, whatever the page size', async () => {
    const user = demoPool().find(i => !i.isUnassigned)!.assignedTo;
    const summary = await demoApi.summary('all', user);
    const pairs: [string, number][] = [
      ['all', summary.scope.total],
      ['my-tasks', summary.scope.myTasks],
      ['unassigned', summary.scope.unassigned],
      ['blocked', summary.scope.blocked],
      ['blocking', summary.scope.blocking],
      ['bugs', summary.scope.bugs]
    ];
    for (const [quickFilter, expected] of pairs) {
      for (const limit of [1, 7, 50, 200]) {
        const res = await demoApi.list({ quickFilter: quickFilter as never, currentUser: user, limit, offset: 0 });
        expect(res.total, `${quickFilter} @limit ${limit}`).toBe(expected);
        expect(res.items.length).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('client definition (counts.ts) matches the API contract on the same items', async () => {
    const all = demoPool();
    const user = all.find(i => !i.isUnassigned)!.assignedTo;
    const c = computeWorkCounts(all.filter(i => !isWorkItemCompleted(i.state, i.type)), { currentUser: user });
    const s = (await demoApi.summary('all', user)).scope;
    expect(s.total).toBe(c.total);
    expect(s.myTasks).toBe(c.myTasks);
    expect(s.blocked).toBe(c.blocked);
    expect(s.unassigned).toBe(c.unassigned);
  });

  it('walking every page returns each item exactly once and is deterministic', async () => {
    for (const sortBy of ['changedDate', 'priority', 'id', 'title', 'state'] as const) {
      const seen: number[] = [];
      let offset = 0;
      let total = 0;
      do {
        const page = await demoApi.list({ sortBy, sortOrder: 'asc', limit: 11, offset, includeCompleted: true });
        total = page.total;
        seen.push(...page.items.map(i => i.id));
        offset += page.items.length;
        if (page.items.length === 0) break;
      } while (offset < total);
      expect(seen.length, sortBy).toBe(total);
      expect(new Set(seen).size, sortBy).toBe(total);
    }
  });

  it('search filters the whole data set, not just a page', async () => {
    const needle = demoPool()[3].title.split(' ')[0].toLowerCase();
    const small = await demoApi.list({ search: needle, limit: 1 });
    const big = await demoApi.list({ search: needle, limit: 200 });
    expect(small.total).toBe(big.total);
    expect(big.items.every(i => [i.title, String(i.id), i.assignedTo, i.project, i.parentTitle || ''].join(' ').toLowerCase().includes(needle))).toBe(true);
  });
});
