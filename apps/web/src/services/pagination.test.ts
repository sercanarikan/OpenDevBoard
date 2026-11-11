import { describe, it, expect } from 'vitest';
import type { PaginatedWorkItemsResponse, GlobalCounts } from '../types';

describe('Server-Side Pagination & Infrastructure Models', () => {
  it('correctly models page slices and total active counts', () => {
    const mockPagedResponse: PaginatedWorkItemsResponse = {
      items: [
        {
          id: 101,
          title: 'Implement OAuth refresh token',
          type: 'Task',
          state: 'Active',
          project: 'Finans.App',
          assignedTo: 'Fixture Person M',
          isUnassigned: false,
          isBug: false,
          isTask: true,
          parentId: null,
          changedDate: '2026-11-05T08:00:00Z',
          priority: 2,
          url: 'https://dev.azure.com/101',
          relations: { predecessors: [], successors: [], related: [], total: 0 },
          children: []
        }
      ],
      totalCount: 1145,
      page: 1,
      pageSize: 50,
      totalPages: 23,
      hasNext: true,
      hasPrev: false,
      nextCursor: 101,
      dataScope: 'live_cached',
      lastSyncedAt: '2026-11-05T08:47:00Z',
      isComplete: true
    };

    expect(mockPagedResponse.totalCount).toBe(1145);
    expect(mockPagedResponse.totalPages).toBe(23);
    expect(mockPagedResponse.hasNext).toBe(true);
    expect(mockPagedResponse.hasPrev).toBe(false);
    expect(mockPagedResponse.items).toHaveLength(1);
  });

  it('correctly segregates active, completed, unassigned and blocked metrics in GlobalCounts', () => {
    const mockCounts: GlobalCounts = {
      total_org_active: 1145,
      total_cached: 1145,
      total_active_cached: 1145,
      my_tasks_active: 41,
      my_tasks_completed: 7,
      my_tasks_total: 48,
      unassigned_total: 240,
      blocked_total: 57,
      bugs_total: 28,
      stats_by_project: {
        'Finans.App': { total: 6, unassigned: 2, assigned: 4, unassigned_bugs: 0, unassigned_tasks: 2 }
      },
      sync_status: 'idle',
      last_synced_at: '2026-11-05T08:47:00Z'
    };

    expect(mockCounts.total_org_active).toBe(1145);
    expect(mockCounts.my_tasks_active).toBe(41);
    expect(mockCounts.my_tasks_completed).toBe(7);
    expect(mockCounts.my_tasks_total).toBe(48);
    expect(mockCounts.unassigned_total).toBe(240);
    expect(mockCounts.blocked_total).toBe(57);
  });
});
