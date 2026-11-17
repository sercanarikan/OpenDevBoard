import { describe, expect, it } from 'vitest';
import type { PullRequest } from '../types/paging';
import { seedFor, taskFeedScope, type DashboardFeedCache } from './dashboardFeedCache';

describe('dashboard feed cache', () => {
  const prs = [{ id: 1 }] as PullRequest[];

  it('reuses an entry only for the scope it was loaded for', () => {
    const cache: DashboardFeedCache = { prs: { scope: 'Alpha', items: prs } };
    expect(seedFor(cache, 'prs', 'Alpha')?.items).toBe(prs);
    expect(seedFor(cache, 'prs', 'all')).toBeUndefined();
    expect(seedFor(cache, 'team', 'Alpha')).toBeUndefined();
  });

  it('scopes task cards by project and user', () => {
    const cache: DashboardFeedCache = { tasks: { scope: taskFeedScope('all', 'Ada'), priority: [], recent: [] } };
    expect(seedFor(cache, 'tasks', taskFeedScope('all', 'Ada'))).toBeDefined();
    expect(seedFor(cache, 'tasks', taskFeedScope('all', 'Bob'))).toBeUndefined();
    expect(seedFor(cache, 'tasks', taskFeedScope('Alpha', 'Ada'))).toBeUndefined();
  });
});
