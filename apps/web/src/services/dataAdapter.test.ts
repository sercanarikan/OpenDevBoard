import { describe, it, expect } from 'vitest';
import { adaptLiveWorkItemsPool, adaptLiveMyWorkItems } from './dataAdapter';
import { computeCanonicalProgressMap } from '../utils/progress';
import { buildKanbanSwimlanes, filterKanbanItems } from '../utils/kanbanEngine';
import type { WorkItem } from '../types';

describe('Data Adapter - API Response to Work Item Mapping', () => {
  const rawAzureDevOpsPayload = {
    flat_items: [
      {
        id: 5001,
        title: 'Implement OAuth Token Refresh API',
        type: 'Task',
        state: 'Active',
        project: 'CoreBanking',
        assignedTo: { displayName: 'Fixture Person K' },
        parentId: 5000,
        changedDate: '2026-11-04T12:00:00Z',
        createdDate: '2026-11-01T08:00:00Z',
        priority: 1,
        iteration: 'Sprint 43',
        areaPath: 'Security\\Auth',
        relations: {
          predecessors: [
            {
              id: 5002,
              relType: 'predecessor',
              relName: 'Predecessor',
              title: 'Database migration for refresh tokens',
              state: 'Active'
            }
          ],
          successors: [],
          related: []
        }
      },
      {
        id: 5000,
        title: 'Authentication & Session Hardening',
        type: 'User Story',
        state: 'Active',
        project: 'CoreBanking',
        assignedTo: 'Örnek Kişi Ç',
        parentId: null,
        priority: 2,
        relations: { predecessors: [], successors: [], related: [] }
      },
      {
        id: 5002,
        title: 'Database migration for refresh tokens',
        type: 'Task',
        state: 'Active',
        project: 'CoreBanking',
        assignedTo: '',
        parentId: 5000,
        priority: 2,
        relations: { predecessors: [], successors: [], related: [] }
      }
    ]
  };

  it('correctly maps raw backend response to WorkItem model with all fields', () => {
    const adapted = adaptLiveWorkItemsPool(rawAzureDevOpsPayload);
    expect(adapted.flat_items).toHaveLength(3);

    const task = adapted.flat_items.find(i => i.id === 5001);
    expect(task).toBeDefined();
    expect(task?.title).toBe('Implement OAuth Token Refresh API');
    expect(task?.type).toBe('Task');
    expect(task?.state).toBe('Active');
    expect(task?.project).toBe('CoreBanking');
    expect(task?.assignedTo).toBe('Fixture Person K');
    expect(task?.isUnassigned).toBe(false);
    expect(task?.priority).toBe(1);
    expect(task?.iteration).toBe('Sprint 43');
    expect(task?.areaPath).toBe('Security\\Auth');
  });

  it('correctly enriches parent title and type on child items', () => {
    const adapted = adaptLiveWorkItemsPool(rawAzureDevOpsPayload);
    const child = adapted.flat_items.find(i => i.id === 5001);
    expect(child?.parentTitle).toBe('Authentication & Session Hardening');
    expect(child?.parentType).toBe('User Story');
  });

  it('correctly evaluates isBlocked status based on active predecessor', () => {
    const adapted = adaptLiveWorkItemsPool(rawAzureDevOpsPayload);
    const task = adapted.flat_items.find(i => i.id === 5001);
    // Predecessor #5002 is Active (not completed), so task #5001 is Blocked!
    expect(task?.isBlocked).toBe(true);

    const pred = adapted.flat_items.find(i => i.id === 5002);
    expect(pred?.isBlocked).toBe(false);
  });

  it('deduplicates duplicate Work Item records from backend', () => {
    const payloadWithDuplicates = {
      flat_items: [
        { id: 999, title: 'Item 999 First', state: 'Active' },
        { id: 999, title: 'Item 999 Duplicate', state: 'Active' },
        { id: 888, title: 'Item 888 Unique', state: 'New' }
      ]
    };
    const adapted = adaptLiveWorkItemsPool(payloadWithDuplicates);
    expect(adapted.flat_items).toHaveLength(2);
    expect(adapted.summary.total_items).toBe(2);
  });

  it('handles missing/orphan parent gracefully without crashing', () => {
    const payloadWithOrphan = {
      flat_items: [
        { id: 101, title: 'Orphan Task', state: 'Active', parentId: 999999 }
      ]
    };
    const adapted = adaptLiveWorkItemsPool(payloadWithOrphan);
    expect(adapted.flat_items).toHaveLength(1);
    expect(adapted.hierarchy).toHaveLength(1); // Orphan is placed as root hierarchy element
    expect(adapted.flat_items[0].parentTitle).toBeUndefined();
  });

  it('rejects malformed or null API payloads safely', () => {
    expect(() => adaptLiveWorkItemsPool(null)).toThrow();
    expect(() => adaptLiveWorkItemsPool('not-an-object')).toThrow();
  });

  it('adapts /api/my-work-items response safely', () => {
    const rawMyItems = {
      work_items: [
        { id: 123, title: 'My Direct Bug', type: 'Bug', state: 'Active', project: 'Mobile' }
      ]
    };
    const adapted = adaptLiveMyWorkItems(rawMyItems);
    expect(adapted.work_items).toHaveLength(1);
    expect(adapted.count).toBe(1);
    expect(adapted.work_items[0].title).toBe('My Direct Bug');
  });
});

describe('Progress Consistency - Story & Tasks vs Kanban Swimlanes', () => {
  // Model Feature #1010 with Story #1020 (3 tasks) and 2 direct tasks = 5 leaf deliverables
  const feature1010: WorkItem = {
    id: 1010,
    title: 'Consent & Token Authorization Flow (SCA v3)',
    type: 'Feature',
    state: 'Active',
    project: 'CoreBanking',
    assignedTo: 'Örnek Kişi Ç',
    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: null,
    changedDate: '2026-11-04T10:00:00Z',
    priority: 1,
    url: 'https://dev.azure.com/1010',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  };

  const story1020: WorkItem = {
    id: 1020,
    title: 'OAuth2 PKCE Mobile Redirect Handler',
    type: 'User Story',
    state: 'Active',
    project: 'CoreBanking',
    assignedTo: 'Fixture Person K',
    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 1010,
    parentTitle: 'Consent & Token Authorization Flow (SCA v3)',
    parentType: 'Feature',
    changedDate: '2026-11-04T10:00:00Z',
    priority: 1,
    url: 'https://dev.azure.com/1020',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  };

  const task1030: WorkItem = {
    id: 1030,
    title: 'Cryptographic Nonce Validation',
    type: 'Task',
    state: 'Active',
    project: 'CoreBanking',
    assignedTo: 'Fixture Person K',
    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 1020,
    parentTitle: 'OAuth2 PKCE Mobile Redirect Handler',
    parentType: 'User Story',
    changedDate: '2026-11-04T10:00:00Z',
    priority: 2,
    url: 'https://dev.azure.com/1030',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  };

  const task1031: WorkItem = {
    id: 1031,
    title: 'Redis Token Store TTL',
    type: 'Task',
    state: 'Resolved', // Resolved is NOT completed by default
    project: 'CoreBanking',
    assignedTo: 'Fixture Person L',
    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 1020,
    parentTitle: 'OAuth2 PKCE Mobile Redirect Handler',
    parentType: 'User Story',
    changedDate: '2026-11-04T10:00:00Z',
    priority: 2,
    url: 'https://dev.azure.com/1031',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  };

  const bug1032: WorkItem = {
    id: 1032,
    title: 'Token Expiry check clock skew bug',
    type: 'Bug',
    state: 'Active',
    project: 'CoreBanking',
    assignedTo: 'Fixture Person K',
    isUnassigned: false,
    isBug: true,
    isTask: false,
    parentId: 1020,
    parentTitle: 'OAuth2 PKCE Mobile Redirect Handler',
    parentType: 'User Story',
    changedDate: '2026-11-04T10:00:00Z',
    priority: 1,
    url: 'https://dev.azure.com/1032',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  };

  const task1040: WorkItem = {
    id: 1040,
    title: 'Token bucket rate-limiter',
    type: 'Task',
    state: 'New',
    project: 'CoreBanking',
    assignedTo: '',
    isUnassigned: true,
    isBug: false,
    isTask: true,
    parentId: 1010,
    parentTitle: 'Consent & Token Authorization Flow (SCA v3)',
    parentType: 'Feature',
    changedDate: '2026-11-04T10:00:00Z',
    priority: 3,
    url: 'https://dev.azure.com/1040',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  };

  const task1041: WorkItem = {
    id: 1041,
    title: 'Distributed audit logging',
    type: 'Task',
    state: 'New',
    project: 'CoreBanking',
    assignedTo: '',
    isUnassigned: true,
    isBug: false,
    isTask: true,
    parentId: 1010,
    parentTitle: 'Consent & Token Authorization Flow (SCA v3)',
    parentType: 'Feature',
    changedDate: '2026-11-04T10:00:00Z',
    priority: 3,
    url: 'https://dev.azure.com/1041',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  };

  // Wire hierarchy
  story1020.children = [task1030, task1031, bug1032];
  feature1010.children = [story1020, task1040, task1041];

  const fullFlatList = [feature1010, story1020, task1030, task1031, bug1032, task1040, task1041];
  const hierarchyTree = [feature1010];

  it('guarantees identical progress between Story & Tasks and Kanban Swimlane for Feature #1010', () => {
    // 1. Compute canonical progress map (as used in Story & Tasks)
    const canonicalMap = computeCanonicalProgressMap(hierarchyTree);
    const storyTasksProgress = canonicalMap.get(1010);

    expect(storyTasksProgress).toBeDefined();
    // 5 unique leaf deliverables: 1030, 1031, 1032, 1040, 1041
    expect(storyTasksProgress?.totalUnits).toBe(5);
    expect(storyTasksProgress?.completedUnits).toBe(0); // 1031 is Resolved, NOT completed!
    expect(storyTasksProgress?.percent).toBe(0);

    // 2. Build Kanban swimlanes (as used in Kanban Board)
    const kanbanLanes = buildKanbanSwimlanes(
      fullFlatList,
      'parent',
      fullFlatList,
      canonicalMap
    );

    const featureLane = kanbanLanes.find(l => l.id === 'parent-1010');
    expect(featureLane).toBeDefined();

    // Canonical progress in Kanban must match Story & Tasks EXACTLY
    expect(featureLane?.canonicalProgress?.totalUnits).toBe(storyTasksProgress?.totalUnits);
    expect(featureLane?.canonicalProgress?.completedUnits).toBe(storyTasksProgress?.completedUnits);
    expect(featureLane?.canonicalProgress?.percent).toBe(storyTasksProgress?.percent);

    // Visible cards in this swimlane are the 3 direct cards (Story #1020, Task #1040, Task #1041)
    expect(featureLane?.visibleCardsCount).toBe(3);
  });

  it('keeps canonical progress invariant when filters are applied (e.g. My Tasks)', () => {
    const canonicalMap = computeCanonicalProgressMap(hierarchyTree);

    // Filter down to only Fixture Person K's tasks
    const fixturePersonKFiltered = filterKanbanItems(
      fullFlatList,
      {
        selectedProject: 'all',
        quickFilter: 'my-tasks',
        searchQuery: '',
        selectedTypes: [],
        selectedStates: [],
        selectedPriorities: []
      },
      'Fixture Person K'
    );

    const kanbanLanes = buildKanbanSwimlanes(
      fixturePersonKFiltered,
      'parent',
      fullFlatList,
      canonicalMap
    );

    const featureLane = kanbanLanes.find(l => l.id === 'parent-1010');
    expect(featureLane).toBeDefined();

    // Canonical progress remains constant 0/5 (0%) even when filtered!
    expect(featureLane?.canonicalProgress?.totalUnits).toBe(5);
    expect(featureLane?.canonicalProgress?.completedUnits).toBe(0);
    expect(featureLane?.canonicalProgress?.percent).toBe(0);

    // Only Story #1020 is assigned to Fixture Person K under #1010, so visible cards count is 1!
    expect(featureLane?.visibleCardsCount).toBe(1);
  });
});

describe('Live Azure DevOps Integration & Isolation Tests', () => {
  it('correctly adapts live Azure DevOps data with GraphProfile avatars, comments, and Turkish characters', () => {
    const liveSamplePayload = {
      flat_items: [
        {
          id: 91005,
          title: 'Örnek koleksiyon için sıralama kuralı ekle',
          type: 'Task',
          state: 'In Progress',
          project: 'sample-catalog',
          assignedTo: 'Fixture Person P',
          assignedAvatar: 'https://dev.azure.com/fixture-org/_apis/GraphProfile/MemberAvatars/sample.png',
          createdDate: '2024-01-02T10:00:00Z',
          changedDate: '2024-01-03T10:00:00Z',
          iteration: 'sample-catalog\\Sprint 12',
          areaPath: 'sample-catalog',
          priority: 2,
          parentId: 91008,
          url: 'https://dev.azure.com/fixture-org/sample-catalog/_workitems/edit/91005',
          relations: {
            predecessors: [
              {
                id: 91006,
                relType: 'predecessor',
                relName: 'Predecessor',
                comment: 'Örnek kural koleksiyon üzerinde çalışır.',
                url: 'https://dev.azure.com/fixture-org/_workitems/edit/91006'
              }
            ],
            successors: [
              {
                id: 91007,
                relType: 'successor',
                relName: 'Successor',
                title: 'Örnek öğeyi koleksiyona bağla',
                state: 'To Do',
                url: 'https://dev.azure.com/fixture-org/_workitems/edit/91007'
              }
            ],
            related: [],
            total: 2
          }
        },
        {
          id: 91008,
          title: 'Örnek Koleksiyon Yönetimi',
          type: 'User Story',
          state: 'Active',
          project: 'sample-catalog',
          assignedTo: 'Fixture Person M',
          parentId: null,
          priority: 1,
          relations: { predecessors: [], successors: [], related: [], total: 0 }
        }
      ]
    };

    const adapted = adaptLiveWorkItemsPool(liveSamplePayload);
    expect(adapted.flat_items).toHaveLength(2);

    const task = adapted.flat_items.find(i => i.id === 91005);
    expect(task).toBeDefined();
    expect(task?.assignedTo).toBe('Fixture Person P');
    expect(task?.assignedAvatar).toBe('https://dev.azure.com/fixture-org/_apis/GraphProfile/MemberAvatars/sample.png');
    expect(task?.parentTitle).toBe('Örnek Koleksiyon Yönetimi');
    expect(task?.parentType).toBe('User Story');
    expect(task?.relations.predecessors[0].comment).toBe('Örnek kural koleksiyon üzerinde çalışır.');
    expect(task?.relations.successors[0].title).toBe('Örnek öğeyi koleksiyona bağla');

    // Hierarchy tree should have parent as root and task as child
    expect(adapted.hierarchy).toHaveLength(1);
    expect(adapted.hierarchy[0].id).toBe(91008);
    expect(adapted.hierarchy[0].children).toHaveLength(1);
    expect(adapted.hierarchy[0].children[0].id).toBe(91005);
  });

  it('maintains strict isolation between Demo Mode sample data and Live API responses', () => {
    const liveItem: WorkItem = {
      id: 99901,
      title: 'Live Task from ADO',
      type: 'Task',
      state: 'Active',
      project: 'sample-catalog',
      assignedTo: 'Fixture Person M',
      isUnassigned: false,
      isBug: false,
      isTask: true,
      parentId: null,
      changedDate: '2026-11-05T08:00:00Z',
      priority: 1,
      url: 'https://dev.azure.com/99901',
      relations: { predecessors: [], successors: [], related: [], total: 0 },
      children: []
    };

    const demoPayload = adaptLiveWorkItemsPool({
      flat_items: [
        {
          id: 1001,
          title: 'Mock CoreBanking Task',
          type: 'Task',
          state: 'Active',
          project: 'CoreBanking',
          assignedTo: 'Fixture Person K'
        }
      ]
    });

    // Check that projects and IDs never collide or bleed
    expect(demoPayload.flat_items.some(i => i.project === 'sample-catalog')).toBe(false);
    expect(demoPayload.flat_items.some(i => i.id === liveItem.id)).toBe(false);
  });

  it('merges distinct my-work-items into the pool without duplicating existing items', () => {
    const rawPool = {
      flat_items: [
        { id: 101, title: 'Pool Item 1', state: 'Active', assignedTo: 'Other User' },
        { id: 102, title: 'Pool Item 2', state: 'Active', assignedTo: 'Fixture Person M' }
      ],
      projects: ['Finans.App', 'career']
    };

    const myItems = [
      { id: 102, title: 'Pool Item 2 (Duplicate ID)', state: 'Active', assignedTo: 'Fixture Person M' },
      { id: 103, title: 'My Distant Item 3', state: 'Active', assignedTo: 'Fixture Person M' }
    ];

    const adapted = adaptLiveWorkItemsPool(rawPool, 'https://dev.azure.com', myItems);
    expect(adapted.flat_items).toHaveLength(3);
    expect(adapted.flat_items.map(i => i.id).sort()).toEqual([101, 102, 103]);

    // All my items are present and assigned
    const mine = adapted.flat_items.filter(i => i.assignedTo === 'Fixture Person M');
    expect(mine).toHaveLength(2);
  });

  it('correctly ingests organization projects and reports total_active_in_org', () => {
    const rawPool = {
      flat_items: [{ id: 1, title: 'Test', state: 'Active', project: 'ProjA' }],
      projects: ['ProjA', 'ProjB', 'ProjC'],
      summary: { total_active_in_org: 1143 }
    };

    const adapted = adaptLiveWorkItemsPool(rawPool);
    expect(adapted.projects).toEqual(['ProjA', 'ProjB', 'ProjC']);
    expect(adapted.summary.total_active_in_org).toBe(1143);
    expect(adapted.summary.loaded_items).toBe(1);
  });
});
