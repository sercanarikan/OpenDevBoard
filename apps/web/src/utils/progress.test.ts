import { describe, it, expect } from 'vitest';
import {
  isWorkItemCompleted,
  isWorkItemInScope,
  getWorkItemStateCategory,
  type WorkflowMetadata
} from './workState';
import { computeCanonicalProgressMap } from './progress';
import type { WorkItem } from '../types';

describe('Completion State & Workflow Rules', () => {
  // Scenario 1: Resolved is considered NOT completed by default
  it('treats Resolved as NOT completed by default (remains in denominator, not in numerator)', () => {
    expect(isWorkItemCompleted('Resolved', 'Task')).toBe(false);
    expect(isWorkItemCompleted('Resolved', 'Bug')).toBe(false);
    expect(isWorkItemCompleted('Resolved', 'User Story')).toBe(false);
    expect(isWorkItemCompleted('Testing', 'Task')).toBe(false);
    expect(isWorkItemCompleted('In Review', 'Task')).toBe(false);

    // It is in scope (denominator)
    expect(isWorkItemInScope('Resolved')).toBe(true);
  });

  // Scenario 2: Completed category is completed
  it('treats Completed category states (Closed, Done, Completed) as completed', () => {
    expect(isWorkItemCompleted('Done', 'Task')).toBe(true);
    expect(isWorkItemCompleted('Closed', 'User Story')).toBe(true);
    expect(isWorkItemCompleted('Completed', 'Feature')).toBe(true);
    expect(getWorkItemStateCategory('Done')).toBe('Completed');
    expect(getWorkItemStateCategory('Closed')).toBe('Completed');
    expect(getWorkItemStateCategory('Completed')).toBe('Completed');
  });

  // Scenario 3: Removed category is excluded from scope
  it('excludes Removed category from scope (not in numerator, not in denominator)', () => {
    expect(isWorkItemInScope('Removed')).toBe(false);
    expect(isWorkItemCompleted('Removed', 'Task')).toBe(false);
    expect(getWorkItemStateCategory('Removed')).toBe('Removed');
  });

  // Scenario 4: Custom workflow metadata mapping support
  it('supports custom project workflow metadata mappings', () => {
    const customMetadata: WorkflowMetadata = {
      project: 'CustomAgileProject',
      customStateMap: {
        'qa-verified': 'Completed',
        'ready-for-prod': 'Completed',
        'wont-fix': 'Removed'
      }
    };

    expect(isWorkItemCompleted('qa-verified', 'Task', { workflowMetadata: customMetadata })).toBe(true);
    expect(isWorkItemCompleted('ready-for-prod', 'Story', { workflowMetadata: customMetadata })).toBe(true);
    expect(isWorkItemInScope('wont-fix', customMetadata)).toBe(false);
    // Unmapped state falls back safely to default map
    expect(isWorkItemCompleted('active', 'Task', { workflowMetadata: customMetadata })).toBe(false);
  });

  // Scenario 5: Unknown states are safely managed
  it('safely handles unknown states without silently assuming completion', () => {
    expect(isWorkItemCompleted('ArbitraryCustomState', 'Task')).toBe(false);
    expect(getWorkItemStateCategory('ArbitraryCustomState')).toBe('InProgress');
    expect(isWorkItemCompleted('', 'Task')).toBe(false);
  });
});

describe('Hierarchy Progress Rollup & Scope Rules', () => {
  // Scenario: Story with 3 tasks:
  // Task A: Done
  // Task B: Resolved
  // Task C: Active
  // Expected Progress: 1/3 (33%), NOT 2/3 (67%)
  const mockStoryWithThreeTasks: WorkItem = {
    id: 1020,
    title: 'OAuth PKCE Story',
    type: 'User Story',
    state: 'Active',
    project: 'CoreBanking',
    assignedTo: 'Fixture Person K',
    isUnassigned: false,
    isBug: false,
    isTask: false,
    priority: 1,
    changedDate: '',
    url: '',
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: [
      {
        id: 1030,
        title: 'Task A (Done)',
        type: 'Task',
        state: 'Done', // Completed
        project: 'CoreBanking',
        assignedTo: 'Fixture Person K',
        isUnassigned: false,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: { predecessors: [], successors: [], related: [], total: 0 },
        children: []
      },
      {
        id: 1031,
        title: 'Task B (Resolved)',
        type: 'Task',
        state: 'Resolved', // In denominator, NOT in numerator!
        project: 'CoreBanking',
        assignedTo: 'Fixture Person L',
        isUnassigned: false,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: { predecessors: [], successors: [], related: [], total: 0 },
        children: []
      },
      {
        id: 1032,
        title: 'Task C (Active)',
        type: 'Task',
        state: 'Active', // Not completed
        project: 'CoreBanking',
        assignedTo: 'Fixture Person K',
        isUnassigned: false,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: { predecessors: [], successors: [], related: [], total: 0 },
        children: []
      }
    ]
  };

  const mockEpicHierarchy: WorkItem[] = [
    {
      id: 1000,
      title: 'Banking Epic',
      type: 'Epic',
      state: 'Active',
      project: 'CoreBanking',
      assignedTo: 'Örnek Kişi Ç',
      isUnassigned: false,
      isBug: false,
      isTask: false,
      priority: 1,
      changedDate: '',
      url: '',
      relations: { predecessors: [], successors: [], related: [], total: 0 },
      children: [
        {
          id: 1010,
          title: 'Security Feature',
          type: 'Feature',
          state: 'Active',
          project: 'CoreBanking',
          assignedTo: 'Örnek Kişi Ç',
          isUnassigned: false,
          isBug: false,
          isTask: false,
          parentId: 1000,
          priority: 1,
          changedDate: '',
          url: '',
          relations: { predecessors: [], successors: [], related: [], total: 0 },
          children: [
            mockStoryWithThreeTasks,
            {
              id: 1040,
              title: 'Direct Task under Feature (New)',
              type: 'Task',
              state: 'New',
              project: 'CoreBanking',
              assignedTo: '',
              isUnassigned: true,
              isBug: false,
              isTask: true,
              parentId: 1010,
              priority: 3,
              changedDate: '',
              url: '',
              relations: { predecessors: [], successors: [], related: [], total: 0 },
              children: []
            },
            {
              id: 1045,
              title: 'Removed Task (Cancelled)',
              type: 'Task',
              state: 'Removed', // MUST be excluded from scope!
              project: 'CoreBanking',
              assignedTo: '',
              isUnassigned: true,
              isBug: false,
              isTask: true,
              parentId: 1010,
              priority: 3,
              changedDate: '',
              url: '',
              relations: { predecessors: [], successors: [], related: [], total: 0 },
              children: []
            }
          ]
        }
      ]
    }
  ];

  // Scenario 6: Epic, Feature, and Story progress values correctly calculated
  it('calculates User Story progress strictly as 1/3 (33%) when only Done is completed and Resolved is in denominator', () => {
    const progressMap = computeCanonicalProgressMap([mockStoryWithThreeTasks]);
    const storyMetrics = progressMap.get(1020);

    expect(storyMetrics).toBeDefined();
    expect(storyMetrics?.totalUnits).toBe(3); // 3 in-scope tasks
    expect(storyMetrics?.completedUnits).toBe(1); // Only Task A (Done) is completed
    expect(storyMetrics?.percent).toBe(33); // 1 / 3 = 33%, NOT 2/3 (67%)!
  });

  it('calculates Feature and Epic progress excluding Removed items', () => {
    const progressMap = computeCanonicalProgressMap(mockEpicHierarchy);
    const featureMetrics = progressMap.get(1010);
    const epicMetrics = progressMap.get(1000);

    // Feature has 3 tasks under Story + 1 direct task = 4 in-scope leaf tasks (Removed task is excluded!)
    expect(featureMetrics?.totalUnits).toBe(4);
    expect(featureMetrics?.completedUnits).toBe(1); // Task A is Done
    expect(featureMetrics?.percent).toBe(25); // 1 / 4 = 25%

    // Epic has the exact same 4 leaf units
    expect(epicMetrics?.totalUnits).toBe(4);
    expect(epicMetrics?.completedUnits).toBe(1);
    expect(epicMetrics?.percent).toBe(25);
  });

  // Scenario 7: Filtering does not change progress values
  it('preserves canonical progress values regardless of UI filtering', () => {
    const progressMap = computeCanonicalProgressMap(mockEpicHierarchy);

    // Filter down to only blocked items or single task in UI
    const filteredUIList = [mockStoryWithThreeTasks.children[0]]; // Only Task A
    expect(filteredUIList.length).toBe(1);

    // The parent's canonical progress remains identical (1/4 = 25% for Epic and 1/3 = 33% for Story)
    expect(progressMap.get(1000)?.completedUnits).toBe(1);
    expect(progressMap.get(1000)?.totalUnits).toBe(4);
    expect(progressMap.get(1000)?.percent).toBe(25);
    expect(progressMap.get(1020)?.percent).toBe(33);
  });

  // Scenario 8: No duplicate counting of work items
  it('does not count the same work item multiple times in rollup', () => {
    // If a node was referenced twice (e.g. multi-parent or flattened duplicate)
    const duplicateHierarchy: WorkItem[] = [
      {
        id: 5000,
        title: 'Epic with duplicate children',
        type: 'Epic',
        state: 'Active',
        project: 'Bank',
        assignedTo: '',
        isUnassigned: false,
        isBug: false,
        isTask: false,
        priority: 1,
        changedDate: '',
        url: '',
        relations: { predecessors: [], successors: [], related: [], total: 0 },
        children: [
          {
            id: 5010,
            title: 'Task Unique 1',
            type: 'Task',
            state: 'Done',
            project: 'Bank',
            assignedTo: '',
            isUnassigned: false,
            isBug: false,
            isTask: true,
            priority: 1,
            changedDate: '',
            url: '',
            relations: { predecessors: [], successors: [], related: [], total: 0 },
            children: []
          },
          {
            id: 5010, // Same ID duplicate
            title: 'Task Unique 1 Duplicate',
            type: 'Task',
            state: 'Done',
            project: 'Bank',
            assignedTo: '',
            isUnassigned: false,
            isBug: false,
            isTask: true,
            priority: 1,
            changedDate: '',
            url: '',
            relations: { predecessors: [], successors: [], related: [], total: 0 },
            children: []
          }
        ]
      }
    ];

    const progressMap = computeCanonicalProgressMap(duplicateHierarchy);
    const epicMetrics = progressMap.get(5000);

    // Deduplicated by ID: exactly 1 unit, not 2
    expect(epicMetrics?.totalUnits).toBe(1);
    expect(epicMetrics?.completedUnits).toBe(1);
    expect(epicMetrics?.percent).toBe(100);
  });
});
