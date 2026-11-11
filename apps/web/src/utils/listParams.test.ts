import { describe, it, expect } from 'vitest';
import type { FilterOptions } from '../types';
import { explorerListParams, kanbanParams, queryKey, sortParams } from './listParams';
import { listQuery, kanbanQuery } from '../services/liveApi';

const base: FilterOptions = {
  searchQuery: '',
  selectedProject: 'all',
  quickFilter: 'my-tasks',
  selectedTypes: [],
  selectedStates: [],
  selectedPriorities: [],
  sortBy: 'changedDate',
  sortOrder: 'desc',
  density: 'compact'
};

describe('sort semantics per screen', () => {
  it('Task Explorer: desc is natural, asc inverts', () => {
    expect(sortParams({ ...base, sortBy: 'priority', sortOrder: 'desc' }, 'explorer')).toEqual({ sortBy: 'priority', sortOrder: 'asc' });
    expect(sortParams({ ...base, sortBy: 'priority', sortOrder: 'asc' }, 'explorer')).toEqual({ sortBy: 'priority', sortOrder: 'desc' });
    expect(sortParams({ ...base, sortBy: 'changedDate', sortOrder: 'desc' }, 'explorer')).toEqual({ sortBy: 'changedDate', sortOrder: 'desc' });
  });

  it('Kanban: asc is natural, desc inverts', () => {
    expect(sortParams({ ...base, sortBy: 'priority', sortOrder: 'asc' }, 'kanban')).toEqual({ sortBy: 'priority', sortOrder: 'asc' });
    expect(sortParams({ ...base, sortBy: 'changedDate', sortOrder: 'asc' }, 'kanban')).toEqual({ sortBy: 'changedDate', sortOrder: 'desc' });
    expect(sortParams({ ...base, sortBy: 'title', sortOrder: 'desc' }, 'kanban')).toEqual({ sortBy: 'title', sortOrder: 'desc' });
  });
});

describe('request building', () => {
  it('maps filters to the list contract', () => {
    const p = explorerListParams({
      filters: { ...base, selectedProject: 'Alpha', searchQuery: ' needle ', selectedTypes: ['Task'], selectedStates: ['New', 'Active'], selectedPriorities: [1, 2] },
      currentUser: 'Ada'
    });
    const q = listQuery({ ...p, limit: 50, offset: 100 });
    expect(q.get('project')).toBe('Alpha');
    expect(q.get('search')).toBe('needle');
    expect(q.get('quickFilter')).toBe('my-tasks');
    expect(q.get('currentUser')).toBe('Ada');
    expect(q.get('type')).toBe('Task');
    expect(q.get('state')).toBe('New,Active');
    expect(q.get('priority')).toBe('1,2');
    expect(q.get('limit')).toBe('50');
    expect(q.get('offset')).toBe('100');
  });

  it('omits neutral filters instead of sending them', () => {
    const q = listQuery(explorerListParams({ filters: { ...base, quickFilter: 'all' }, currentUser: '' }));
    expect(q.has('project')).toBe(false);
    expect(q.has('quickFilter')).toBe(false);
    expect(q.has('search')).toBe(false);
    expect(q.has('type')).toBe(false);
  });

  it('builds kanban requests with lane windows', () => {
    const k = kanbanParams({ filters: { ...base, sortOrder: 'asc', sortBy: 'priority' }, currentUser: 'Ada' },
      { swimlane: 'parent', hideCompleted: true, cardLimit: 15, laneLimit: 25, laneOffset: 25 });
    const q = kanbanQuery(k);
    expect(q.get('swimlane')).toBe('parent');
    expect(q.get('hideCompleted')).toBe('true');
    expect(q.get('cardLimit')).toBe('15');
    expect(q.get('laneOffset')).toBe('25');
    expect(q.get('sortBy')).toBe('priority');
    expect(q.get('sortOrder')).toBe('asc');
    expect(q.has('limit')).toBe(false);
  });

  it('query key changes with any filter, ignores paging', () => {
    const a = explorerListParams({ filters: base, currentUser: 'Ada' });
    const b = explorerListParams({ filters: { ...base, searchQuery: 'x' }, currentUser: 'Ada' });
    expect(queryKey(a)).not.toBe(queryKey(b));
    expect(queryKey(a)).toBe(queryKey({ ...a }));
  });
});
