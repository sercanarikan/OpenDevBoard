import { describe, it, expect } from 'vitest';
import {
  evaluateItemBlockedStatus,
  detectDependencyCycles,
  buildFocusedDependencyGraph
} from './dependencyEngine';
import type { WorkItem } from '../types';

describe('Dependency Engine & Blocked Evaluation', () => {
  const taskA: WorkItem = {
    id: 101,
    title: 'Database Migration',
    type: 'Task',
    state: 'Active', // Not completed
    project: 'Core',
    assignedTo: 'Alice',
    isUnassigned: false,
    isBug: false,
    isTask: true,
    priority: 1,
    changedDate: '',
    url: '',
    relations: {
      predecessors: [],
      successors: [
        {
          id: 102,
          relType: 'successor',
          relName: 'Successor',
          url: '',
          title: 'API Endpoints',
          state: 'New'
        }
      ],
      related: [],
      total: 1
    },
    children: []
  };

  const taskB: WorkItem = {
    id: 102,
    title: 'API Endpoints',
    type: 'Task',
    state: 'New',
    project: 'Core',
    assignedTo: 'Bob',
    isUnassigned: false,
    isBug: false,
    isTask: true,
    priority: 2,
    changedDate: '',
    url: '',
    relations: {
      predecessors: [
        {
          id: 101,
          relType: 'predecessor',
          relName: 'Predecessor',
          url: '',
          title: 'Database Migration',
          state: 'Active'
        }
      ],
      successors: [],
      related: [],
      total: 1
    },
    children: []
  };

  const itemMap = new Map<number, WorkItem>([
    [101, taskA],
    [102, taskB]
  ]);

  it('accurately identifies taskB as blocked because taskA is Active (not completed)', () => {
    const result = evaluateItemBlockedStatus(taskB, itemMap);
    expect(result.isBlocked).toBe(true);
    expect(result.blockingPredecessors.length).toBe(1);
    expect(result.blockingPredecessors[0].id).toBe(101);
  });

  it('identifies taskA as blocking because it is not completed and has successor taskB', () => {
    const result = evaluateItemBlockedStatus(taskA, itemMap);
    expect(result.isBlocking).toBe(true);
    expect(result.blockedSuccessors.length).toBe(1);
    expect(result.blockedSuccessors[0].id).toBe(102);
  });

  it('unblocks taskB when predecessor taskA transitions to Done', () => {
    const completedTaskA: WorkItem = { ...taskA, state: 'Done' };
    const updatedMap = new Map<number, WorkItem>([
      [101, completedTaskA],
      [102, taskB]
    ]);

    const result = evaluateItemBlockedStatus(taskB, updatedMap);
    expect(result.isBlocked).toBe(false);
    expect(result.resolvedPredecessors.length).toBe(1);
    expect(result.resolvedPredecessors[0].id).toBe(101);
  });
});

describe('Cycle Detection Algorithm', () => {
  it('detects circular dependency loops (A -> B -> C -> A)', () => {
    const item1: WorkItem = {
      id: 1,
      title: 'Item 1',
      type: 'Task',
      state: 'New',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: { predecessors: [], successors: [{ id: 2, relType: 'successor', relName: 'Successor', url: '' }], related: [], total: 1 },
      children: []
    };
    const item2: WorkItem = {
      id: 2,
      title: 'Item 2',
      type: 'Task',
      state: 'New',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: { predecessors: [], successors: [{ id: 3, relType: 'successor', relName: 'Successor', url: '' }], related: [], total: 1 },
      children: []
    };
    const item3: WorkItem = {
      id: 3,
      title: 'Item 3',
      type: 'Task',
      state: 'New',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: { predecessors: [], successors: [{ id: 1, relType: 'successor', relName: 'Successor', url: '' }], related: [], total: 1 },
      children: []
    };

    const cycles = detectDependencyCycles([item1, item2, item3]);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain(1);
    expect(cycles[0]).toContain(2);
    expect(cycles[0]).toContain(3);
  });

  it('returns empty array when there are no cycles', () => {
    const item1: WorkItem = {
      id: 1,
      title: 'Item 1',
      type: 'Task',
      state: 'Done',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: { predecessors: [], successors: [{ id: 2, relType: 'successor', relName: 'Successor', url: '' }], related: [], total: 1 },
      children: []
    };
    const item2: WorkItem = {
      id: 2,
      title: 'Item 2',
      type: 'Task',
      state: 'New',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: { predecessors: [], successors: [], related: [], total: 0 },
      children: []
    };

    const cycles = detectDependencyCycles([item1, item2]);
    expect(cycles.length).toBe(0);
  });
});

describe('Focus Mode & Multi-Hop Graph Building', () => {
  // Chain: 201 -> 202 -> 203 -> 204
  const chainItems: WorkItem[] = [
    {
      id: 201,
      title: 'Chain 1 (Root Pred)',
      type: 'Task',
      state: 'Done',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: { predecessors: [], successors: [{ id: 202, relType: 'successor', relName: 'Successor', url: '' }], related: [], total: 1 },
      children: []
    },
    {
      id: 202,
      title: 'Chain 2 (Direct Pred)',
      type: 'Task',
      state: 'Active',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: {
        predecessors: [{ id: 201, relType: 'predecessor', relName: 'Predecessor', url: '' }],
        successors: [{ id: 203, relType: 'successor', relName: 'Successor', url: '' }],
        related: [],
        total: 2
      },
      children: []
    },
    {
      id: 203,
      title: 'Chain 3 (Center Focus)',
      type: 'Task',
      state: 'New',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: {
        predecessors: [{ id: 202, relType: 'predecessor', relName: 'Predecessor', url: '' }],
        successors: [{ id: 204, relType: 'successor', relName: 'Successor', url: '' }],
        related: [],
        total: 2
      },
      children: []
    },
    {
      id: 204,
      title: 'Chain 4 (Direct Succ)',
      type: 'Task',
      state: 'New',
      project: 'P',
      assignedTo: '',
      isUnassigned: true,
      isBug: false,
      isTask: true,
      priority: 1,
      changedDate: '',
      url: '',
      relations: {
        predecessors: [{ id: 203, relType: 'predecessor', relName: 'Predecessor', url: '' }],
        successors: [],
        related: [],
        total: 1
      },
      children: []
    }
  ];

  it('1-hop focus on item 203 includes only direct predecessor 202 and direct successor 204', () => {
    const graph = buildFocusedDependencyGraph(203, chainItems, { hops: 1 });
    const nodeIds = graph.nodes.map(n => n.id);

    expect(nodeIds).toContain('203'); // Focus
    expect(nodeIds).toContain('202'); // 1-hop Pred
    expect(nodeIds).toContain('204'); // 1-hop Succ
    expect(nodeIds).not.toContain('201'); // 2-hop should be excluded in 1-hop mode!

    // Verify directional edges: 202 -> 203 and 203 -> 204
    expect(graph.edges.some(e => e.source === '202' && e.target === '203')).toBe(true);
    expect(graph.edges.some(e => e.source === '203' && e.target === '204')).toBe(true);
  });

  it('2-hop focus on item 203 expands to include 201', () => {
    const graph = buildFocusedDependencyGraph(203, chainItems, { hops: 2 });
    const nodeIds = graph.nodes.map(n => n.id);

    expect(nodeIds).toContain('201');
    expect(nodeIds).toContain('202');
    expect(nodeIds).toContain('203');
    expect(nodeIds).toContain('204');
  });

  it('positions predecessors strictly to the left (X < centerX) and successors to the right (X > centerX)', () => {
    const graph = buildFocusedDependencyGraph(203, chainItems, { hops: 1 });
    const focusNode = graph.nodes.find(n => n.id === '203')!;
    const predNode = graph.nodes.find(n => n.id === '202')!;
    const succNode = graph.nodes.find(n => n.id === '204')!;

    expect(predNode.position.x).toBeLessThan(focusNode.position.x);
    expect(succNode.position.x).toBeGreaterThan(focusNode.position.x);
  });

  it('unbounded full chain handles chains longer than 10 hops without truncation', () => {
    // Build a 15-node linear chain: 1 -> 2 -> ... -> 15
    const longChain: WorkItem[] = [];
    for (let i = 1; i <= 15; i++) {
      longChain.push({
        id: i,
        title: `Item ${i}`,
        type: 'Task',
        state: 'Active',
        project: 'ChainProject',
        assignedTo: 'Dev',
        isUnassigned: false,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: i > 1 ? [{ id: i - 1, relType: 'predecessor', relName: 'Predecessor', url: '' }] : [],
          successors: i < 15 ? [{ id: i + 1, relType: 'successor', relName: 'Successor', url: '' }] : [],
          related: [],
          total: (i > 1 ? 1 : 0) + (i < 15 ? 1 : 0)
        },
        children: []
      });
    }

    // Focus on middle item 8 with hops: 'all'
    const graph = buildFocusedDependencyGraph(8, longChain, { hops: 'all' });
    expect(graph.nodes).toHaveLength(15);
    for (let i = 1; i <= 15; i++) {
      expect(graph.nodes.some(n => n.id === String(i))).toBe(true);
    }
    // Verify hop distances are correct
    const node1 = graph.nodes.find(n => n.id === '1')!;
    const node8 = graph.nodes.find(n => n.id === '8')!;
    const node15 = graph.nodes.find(n => n.id === '15')!;
    expect(node1.data.hopDistance).toBe(-7);
    expect(node8.data.hopDistance).toBe(0);
    expect(node15.data.hopDistance).toBe(7);
  });

  it('connected component includes sibling branches not reachable via direct upstream/downstream closure', () => {
    // Structure:
    //      P1
    //     /  \
    // Focus   Sibling
    //   |
    //  S1
    const items: WorkItem[] = [
      {
        id: 10,
        title: 'Parent P1',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [],
          successors: [
            { id: 20, relType: 'successor', relName: 'Successor', url: '' },
            { id: 30, relType: 'successor', relName: 'Successor', url: '' }
          ],
          related: [],
          total: 2
        },
        children: []
      },
      {
        id: 20,
        title: 'Focus Node',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [{ id: 10, relType: 'predecessor', relName: 'Predecessor', url: '' }],
          successors: [{ id: 40, relType: 'successor', relName: 'Successor', url: '' }],
          related: [],
          total: 2
        },
        children: []
      },
      {
        id: 30,
        title: 'Sibling Branch',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [{ id: 10, relType: 'predecessor', relName: 'Predecessor', url: '' }],
          successors: [],
          related: [],
          total: 1
        },
        children: []
      },
      {
        id: 40,
        title: 'Successor S1',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [{ id: 20, relType: 'predecessor', relName: 'Predecessor', url: '' }],
          successors: [],
          related: [],
          total: 1
        },
        children: []
      }
    ];

    // In 'all' mode (full chain), only upstream (P1: 10) and downstream (S1: 40) are included; sibling 30 is NOT:
    const fullChainGraph = buildFocusedDependencyGraph(20, items, { hops: 'all' });
    expect(fullChainGraph.nodes.map(n => n.id).sort()).toEqual(['10', '20', '40']);
    expect(fullChainGraph.nodes.some(n => n.id === '30')).toBe(false);

    // In 'connected' mode, the sibling branch 30 IS included:
    const connectedGraph = buildFocusedDependencyGraph(20, items, { hops: 'connected' });
    expect(connectedGraph.nodes.map(n => n.id).sort()).toEqual(['10', '20', '30', '40']);
    expect(connectedGraph.connectedComponentSize).toBe(4);
    expect(connectedGraph.edges.some(e => e.source === '10' && e.target === '30')).toBe(true);
  });

  it('synthesizes bidirectional edges and reports link asymmetries when only one side declares relation', () => {
    // Item 100 declares successor 200, but Item 200 has empty predecessors list
    const asymmetricItems: WorkItem[] = [
      {
        id: 100,
        title: 'Declared Source',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [],
          successors: [{ id: 200, relType: 'successor', relName: 'Successor', url: '' }],
          related: [],
          total: 1
        },
        children: []
      },
      {
        id: 200,
        title: 'Passive Target',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [], // Empty! Missing reverse reference
          successors: [],
          related: [],
          total: 0
        },
        children: []
      }
    ];

    // Focus on 200 with hops: 1 should still find predecessor 100 because of bidirectional indexing!
    const graphFromTarget = buildFocusedDependencyGraph(200, asymmetricItems, { hops: 1 });
    expect(graphFromTarget.nodes.map(n => n.id).sort()).toEqual(['100', '200']);
    expect(graphFromTarget.edges.some(e => e.source === '100' && e.target === '200')).toBe(true);

    // Asymmetry is detected and reported
    expect(graphFromTarget.asymmetries).toHaveLength(1);
    expect(graphFromTarget.asymmetries[0]).toEqual({
      fromId: 100,
      toId: 200,
      declaredBy: 'source'
    });
  });

  it('safely traverses graphs with dependency cycles without hanging or duplicating nodes', () => {
    // Cyclic triangle: 1 -> 2 -> 3 -> 1
    const cyclicItems: WorkItem[] = [
      {
        id: 1,
        title: 'C1',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [{ id: 3, relType: 'predecessor', relName: 'Predecessor', url: '' }],
          successors: [{ id: 2, relType: 'successor', relName: 'Successor', url: '' }],
          related: [],
          total: 2
        },
        children: []
      },
      {
        id: 2,
        title: 'C2',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [{ id: 1, relType: 'predecessor', relName: 'Predecessor', url: '' }],
          successors: [{ id: 3, relType: 'successor', relName: 'Successor', url: '' }],
          related: [],
          total: 2
        },
        children: []
      },
      {
        id: 3,
        title: 'C3',
        type: 'Task',
        state: 'Active',
        project: 'P',
        assignedTo: '',
        isUnassigned: true,
        isBug: false,
        isTask: true,
        priority: 2,
        changedDate: '',
        url: '',
        relations: {
          predecessors: [{ id: 2, relType: 'predecessor', relName: 'Predecessor', url: '' }],
          successors: [{ id: 1, relType: 'successor', relName: 'Successor', url: '' }],
          related: [],
          total: 2
        },
        children: []
      }
    ];

    const graph = buildFocusedDependencyGraph(2, cyclicItems, { hops: 'all' });
    expect(graph.hasCycles).toBe(true);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(3);

    const connectedGraph = buildFocusedDependencyGraph(2, cyclicItems, { hops: 'connected' });
    expect(connectedGraph.nodes).toHaveLength(3);
  });
});
