import { describe, it, expect } from 'vitest';
import {
  getKanbanColumnForState,
  filterKanbanItems,
  sortKanbanItems,
  buildKanbanSwimlanes,
  type KanbanFilterOptions
} from './kanbanEngine';
import type { WorkItem } from '../types';

const mockItems: WorkItem[] = [
  {
    id: 101,
    title: 'Authentication token storage fix',
    type: 'Task',
    state: 'Active',
    project: 'CoreBanking',
    assignedTo: 'Fixture Person K',
    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 100,
    parentTitle: 'OAuth Security Enhancements',
    changedDate: '2026-11-04T10:00:00Z',
    priority: 1,
    url: 'https://dev.azure.com/101',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: [],
    isBlocked: true
  },
  {
    id: 102,
    title: 'Update OAuth documentation',
    type: 'Task',
    state: 'New',
    project: 'CoreBanking',
    assignedTo: 'Fixture Person K',
    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 100,
    parentTitle: 'OAuth Security Enhancements',
    changedDate: '2026-11-04T09:00:00Z',
    priority: 3,
    url: 'https://dev.azure.com/102',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 103,
    title: 'Memory leak in session worker',
    type: 'Bug',
    state: 'In Review',
    project: 'CoreBanking',
    assignedTo: 'Örnek Kişi Ç',
    isUnassigned: false,
    isBug: true,
    isTask: false,
    parentId: 100,
    parentTitle: 'OAuth Security Enhancements',
    changedDate: '2026-11-03T14:00:00Z',
    priority: 2,
    url: 'https://dev.azure.com/103',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 104,
    title: 'Migrate database schema for tokens',
    type: 'Task',
    state: 'Closed',
    project: 'CoreBanking',
    assignedTo: 'Örnek Kişi Ç',
    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 100,
    parentTitle: 'OAuth Security Enhancements',
    changedDate: '2026-11-02T12:00:00Z',
    priority: 2,
    url: 'https://dev.azure.com/104',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 201,
    title: 'Kubernetes ingress controller configuration',
    type: 'Task',
    state: 'In Progress',
    project: 'CloudOps',
    assignedTo: '',
    isUnassigned: true,
    isBug: false,
    isTask: true,
    parentId: null,
    changedDate: '2026-11-04T11:00:00Z',
    priority: 1,
    url: 'https://dev.azure.com/201',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  }
];

describe('Kanban Engine - State to Column Mapping', () => {
  it('maps Proposed states to todo column', () => {
    expect(getKanbanColumnForState('New')).toBe('todo');
    expect(getKanbanColumnForState('To Do')).toBe('todo');
    expect(getKanbanColumnForState('Proposed')).toBe('todo');
  });

  it('maps InProgress states to in-progress column', () => {
    expect(getKanbanColumnForState('Active')).toBe('in-progress');
    expect(getKanbanColumnForState('In Progress')).toBe('in-progress');
    expect(getKanbanColumnForState('Committed')).toBe('in-progress');
  });

  it('maps Resolved/Testing states to resolved column', () => {
    expect(getKanbanColumnForState('Resolved')).toBe('resolved');
    expect(getKanbanColumnForState('Testing')).toBe('resolved');
    expect(getKanbanColumnForState('In Review')).toBe('resolved');
  });

  it('maps Completed states to done column', () => {
    expect(getKanbanColumnForState('Done')).toBe('done');
    expect(getKanbanColumnForState('Closed')).toBe('done');
    expect(getKanbanColumnForState('Completed')).toBe('done');
  });
});

describe('Kanban Engine - Item Filtering', () => {
  const baseFilter: KanbanFilterOptions = {
    selectedProject: 'all',
    quickFilter: 'all',
    searchQuery: '',
    selectedTypes: [],
    selectedStates: [],
    selectedPriorities: []
  };

  it('filters by project correctly', () => {
    const res = filterKanbanItems(mockItems, { ...baseFilter, selectedProject: 'CloudOps' }, 'Fixture Person K');
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(201);
  });

  it('filters by My Tasks correctly', () => {
    const res = filterKanbanItems(mockItems, { ...baseFilter, quickFilter: 'my-tasks' }, 'Fixture Person K');
    expect(res).toHaveLength(2);
    expect(res.map(i => i.id)).toEqual([101, 102]);
  });

  it('filters by Blocked items correctly', () => {
    const res = filterKanbanItems(mockItems, { ...baseFilter, quickFilter: 'blocked' }, 'Fixture Person K');
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(101);
  });

  it('filters by Unassigned items correctly', () => {
    const res = filterKanbanItems(mockItems, { ...baseFilter, quickFilter: 'unassigned' }, 'Fixture Person K');
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(201);
  });

  it('filters by search query matching ID or title', () => {
    const res = filterKanbanItems(mockItems, { ...baseFilter, searchQuery: '103' }, 'Fixture Person K');
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(103);

    const res2 = filterKanbanItems(mockItems, { ...baseFilter, searchQuery: 'Kubernetes' }, 'Fixture Person K');
    expect(res2).toHaveLength(1);
    expect(res2[0].id).toBe(201);
  });

  it('filters out completed items when hideCompleted is true', () => {
    const res = filterKanbanItems(mockItems, { ...baseFilter, hideCompleted: true }, 'Fixture Person K');
    expect(res.some(i => i.id === 104)).toBe(false);
    expect(res).toHaveLength(4);
  });
});

describe('Kanban Engine - Item Sorting', () => {
  it('sorts by priority with P1 Critical and blocked items first', () => {
    const sorted = sortKanbanItems(mockItems, 'priority', 'asc');
    expect(sorted[0].id).toBe(101); // P1 + blocked
    expect(sorted[1].id).toBe(201); // P1
  });

  it('sorts by title alphabetically', () => {
    const sorted = sortKanbanItems(mockItems, 'title', 'asc');
    expect(sorted[0].title).toBe('Authentication token storage fix');
  });
});

describe('Kanban Engine - Swimlane Grouping', () => {
  it('groups items into standard columns when mode is none', () => {
    const lanes = buildKanbanSwimlanes(mockItems, 'none', mockItems);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].columns.todo).toHaveLength(1); // #102
    expect(lanes[0].columns['in-progress']).toHaveLength(2); // #101, #201
    expect(lanes[0].columns.resolved).toHaveLength(1); // #103
    expect(lanes[0].columns.done).toHaveLength(1); // #104
  });

  it('groups items by parent story swimlanes', () => {
    const lanes = buildKanbanSwimlanes(mockItems, 'parent', mockItems);
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    const parentLane = lanes.find(l => l.id.includes('100'));
    expect(parentLane).toBeDefined();
    expect(parentLane?.columns['in-progress']).toHaveLength(1);

    const independentLane = lanes.find(l => l.id === 'independent');
    expect(independentLane).toBeDefined();
    expect(independentLane?.columns['in-progress']).toHaveLength(1); // #201
  });

  it('groups items by assignee swimlanes', () => {
    const lanes = buildKanbanSwimlanes(mockItems, 'assignee', mockItems);
    const fixturePersonKLane = lanes.find(l => l.title === 'Fixture Person K');
    expect(fixturePersonKLane).toBeDefined();
    expect(fixturePersonKLane?.totalCount).toBe(2);

    const unassignedLane = lanes.find(l => l.title === 'Unassigned Pool');
    expect(unassignedLane).toBeDefined();
    expect(unassignedLane?.totalCount).toBe(1);
  });

  it('groups items by priority swimlanes', () => {
    const lanes = buildKanbanSwimlanes(mockItems, 'priority', mockItems);
    const p1Lane = lanes.find(l => l.id === 'priority-1');
    expect(p1Lane).toBeDefined();
    expect(p1Lane?.totalCount).toBe(2);
  });
});
