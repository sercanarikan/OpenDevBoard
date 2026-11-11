import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type ReactFlowInstance
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import {
  Network,
  Table,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Search,
  EyeOff,
  Crosshair,
  User,
  CheckCircle2,
  Compass,
  Info,
  Target,
  Share2
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { WorkItem } from '../../types';
import { WorkItemNode } from './WorkItemNode';
import { stateLabel } from '../../i18n/labels';
import { WorkItemInspector } from '../Explorer/WorkItemInspector';
import {
  buildFocusedDependencyGraph,
  evaluateItemBlockedStatus
} from '../../utils/dependencyEngine';

const nodeTypes = {
  workItemNode: WorkItemNode as any
};

export const DependencyExplorer: React.FC = () => {
  const {
    poolData,
    poolLoading,
    poolError,
    ensurePool,
    retryPool,
    filters,
    selectedWorkItem,
    setSelectedWorkItem,
    openWorkItem,
    currentUserName,
    summary,
    booting,
    theme
  } = useApp();
  const { t } = useTranslation(['dependencies', 'common']);

  // Relationship data (predecessors / successors across the whole org) is loaded lazily, only for this screen.
  useEffect(() => {
    ensurePool();
  }, [ensurePool]);

  const allItems: WorkItem[] = poolData?.flat_items || [];
  // Graph lookups also need completed items and context rows (relation targets), never only the active scope.
  const graphItems: WorkItem[] = poolData?.graphItems || allItems;

  // Active view: Graph or Matrix
  const [activeTab, setActiveTab] = useState<'graph' | 'matrix'>('graph');

  // Quick Filter Mode
  const [filterMode, setFilterMode] = useState<'all' | 'my-tasks' | 'blocked' | 'blocking'>('all');

  // Graph options
  const [hopDistance, setHopDistanceState] = useState<1 | 2 | 'all' | 'connected'>(() => {
    const saved = localStorage.getItem('devopsflow_dep_hops');
    if (saved === '1' || saved === '2' || saved === 'all' || saved === 'connected') {
      return (saved === '1' ? 1 : saved === '2' ? 2 : saved) as 1 | 2 | 'all' | 'connected';
    }
    return 2;
  });

  const [isGraphUpdating, setIsGraphUpdating] = useState<boolean>(false);

  const setHopDistance = useCallback((val: 1 | 2 | 'all' | 'connected') => {
    setHopDistanceState(val);
    localStorage.setItem('devopsflow_dep_hops', String(val));
    setIsGraphUpdating(true);
  }, []);

  const [hideCompleted, setHideCompleted] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Focused node ID (the anchor around which Predecessors and Successors are drawn)
  const [focusId, setFocusId] = useState<number | null>(null);

  // ReactFlow instance
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

  // Filter items in scope based on current project
  const scopedItems = useMemo(() => {
    if (filters.selectedProject === 'all') return allItems;
    return allItems.filter(i => i.project === filters.selectedProject);
  }, [allItems, filters.selectedProject]);

  // Find all items with dependencies in current scope
  const dependentItems = useMemo(() => {
    return scopedItems.filter(item => {
      const hasPreds = (item.relations?.predecessors?.length || 0) > 0;
      const hasSuccs = (item.relations?.successors?.length || 0) > 0;
      return hasPreds || hasSuccs || item.isBlocked || item.isBlocking;
    });
  }, [scopedItems]);

  // Set initial focusId if none is set
  useEffect(() => {
    if (!focusId && dependentItems.length > 0) {
      if (selectedWorkItem && dependentItems.some(i => i.id === selectedWorkItem.id)) {
        setFocusId(selectedWorkItem.id);
      } else {
        const firstBlocked = dependentItems.find(i => i.isBlocked);
        setFocusId(firstBlocked ? firstBlocked.id : dependentItems[0].id);
      }
    }
  }, [focusId, dependentItems, selectedWorkItem]);

  // True only when pool data is actually loaded and ready (never show 0 during loading)
  const hasLoadedPool = poolData !== null && !booting && !poolLoading;
  const renderCount = (count: number): number | string => (hasLoadedPool ? count : '—');

  // Dynamic scope tip based on active traversal depth
  const scopeTip = useMemo(() => {
    if (hopDistance === 'connected') return t('focus.scopeTipConnected');
    if (hopDistance === 'all') return t('focus.scopeTipFullChain');
    return t('focus.scopeTipHops');
  }, [hopDistance, t]);

  // Calculate quick metrics consistently across all screens
  const myTasksCount = summary?.scope.myTasks ?? 0;
  const blockedCount = summary?.scope.blocked ?? 0;
  const blockingCount = dependentItems.filter(i => {
    const evalResult = evaluateItemBlockedStatus(i);
    return evalResult.isBlocking;
  }).length;

  // Filter items for Matrix view
  const matrixItems = useMemo(() => {
    return dependentItems.filter(item => {
      const evalResult = evaluateItemBlockedStatus(item);

      if (filterMode === 'my-tasks' && item.assignedTo !== currentUserName) {
        return false;
      }
      if (filterMode === 'blocked' && !evalResult.isBlocked) {
        return false;
      }
      if (filterMode === 'blocking' && !evalResult.isBlocking) {
        return false;
      }

      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        const matchTitle = item.title.toLowerCase().includes(q);
        const matchId = item.id.toString().includes(q);
        const matchAssignee = item.assignedTo.toLowerCase().includes(q);
        if (!matchTitle && !matchId && !matchAssignee) return false;
      }

      return true;
    });
  }, [dependentItems, filterMode, searchQuery, currentUserName]);

  // Build graph data using dependency engine
  const graphData = useMemo(() => {
    if (!focusId) {
      return { nodes: [], edges: [], focusedItem: null, hasCycles: false, cyclePaths: [] };
    }

    return buildFocusedDependencyGraph(focusId, graphItems, {
      hops: hopDistance,
      hideCompleted
    });
  }, [focusId, graphItems, hopDistance, hideCompleted]);

  // Set Focus handler
  const handleSetFocus = useCallback((targetId: number) => {
    setIsGraphUpdating(true);
    setFocusId(targetId);
    const targetItem = graphItems.find(i => i.id === targetId);
    if (targetItem) {
      setSelectedWorkItem(targetItem);
    }
  }, [graphItems, setSelectedWorkItem]);

  // Convert graphData to ReactFlow Nodes & Edges
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Turn off updating indicator once graphData has rendered
  useEffect(() => {
    if (isGraphUpdating) {
      const timer = setTimeout(() => setIsGraphUpdating(false), 180);
      return () => clearTimeout(timer);
    }
  }, [nodes, isGraphUpdating]);

  useEffect(() => {
    const flowNodes: Node[] = graphData.nodes.map(n => ({
      id: n.id,
      type: 'workItemNode',
      position: n.position,
      data: {
        ...n.data,
        onSetFocus: handleSetFocus
      },
      selected: selectedWorkItem?.id.toString() === n.id
    }));

    const flowEdges: Edge[] = graphData.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      animated: e.data.isBlocking,
      style: {
        stroke: e.data.isUnresolved
          ? '#64748b' // slate: unknown, neither blocking nor done
          : e.data.isBlocking
          ? '#ef4444' // red/rose for active blocker
          : e.data.isCompleted
          ? '#10b981' // emerald for resolved/done
          : '#94a3b8',
        strokeWidth: e.data.isBlocking ? 2.5 : 1.5,
        strokeDasharray: e.data.isCompleted || e.data.isUnresolved ? '4 4' : undefined
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: e.data.isUnresolved
          ? '#64748b'
          : e.data.isBlocking
          ? '#ef4444'
          : e.data.isCompleted
          ? '#10b981'
          : '#94a3b8',
        width: 16,
        height: 16
      }
    }));

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [graphData, selectedWorkItem, handleSetFocus, setNodes, setEdges]);

  // Node Click: Selection only (opens Inspector without altering focus)
  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const id = parseInt(node.id, 10);
    const item = graphItems.find(i => i.id === id);
    if (item) {
      setSelectedWorkItem(item);
    } else {
      void openWorkItem(id);
    }
  }, [graphItems, setSelectedWorkItem, openWorkItem]);

  /**
   * Centers and scales the graph view balanced in the upper-middle area
   * above the bottom-dock controls.
   */
  const centerGraphView = useCallback((duration = 250) => {
    if (!reactFlowInstance) return;
    // Fit the focus and its neighbours inside the canvas, keeping room for the bottom legend and minimap docks.
    reactFlowInstance.fitView({
      padding: { top: '48px', bottom: '140px', left: '56px', right: '56px' },
      minZoom: 0.35,
      maxZoom: 1.1,
      duration
    });
  }, [reactFlowInstance]);

  /**
   * Centers the viewport directly on the focused node at readable zoom.
   */
  const centerOnFocus = useCallback((duration = 250) => {
    if (!reactFlowInstance || !focusId) return;
    const focusNode = nodes.find(n => n.id === focusId.toString());
    if (focusNode) {
      reactFlowInstance.setCenter(focusNode.position.x + 144, focusNode.position.y + 60, {
        zoom: 1.0,
        duration
      });
    } else {
      centerGraphView(duration);
    }
  }, [reactFlowInstance, focusId, nodes, centerGraphView]);

  // Center graph ONLY when graph structure changes (focusId, hopDistance, hideCompleted or instance ready)
  // Does NOT reset when user simply selects a node or pans/zooms manually!
  useEffect(() => {
    if (reactFlowInstance) {
      const timer = setTimeout(() => {
        centerGraphView(250);
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [focusId, hopDistance, hideCompleted, reactFlowInstance, centerGraphView]);

  // Handle smooth re-centering when Inspector opens or closes (container width change)
  const isInspectorOpen = !!selectedWorkItem;
  const prevInspectorOpen = useRef(isInspectorOpen);

  useEffect(() => {
    if (prevInspectorOpen.current !== isInspectorOpen) {
      prevInspectorOpen.current = isInspectorOpen;
      if (reactFlowInstance) {
        const timer = setTimeout(() => {
          centerGraphView(200);
        }, 160);
        return () => clearTimeout(timer);
      }
    }
  }, [isInspectorOpen, centerGraphView, reactFlowInstance]);

  // Consistent MiniMap node color logic matching the exact legend order and priorities
  const getMiniMapNodeColor = (n: any) => {
    const data = n.data;
    // Rule 1: Center Focus is always bright Blue (#0284c7)
    if (data?.isFocused) return '#0284c7';
    // Rule 2: Blocked is always Red (#ef4444)
    const item = data?.item;
    const isBlocked = data?.blockedEvaluation?.isBlocked ?? item?.isBlocked;
    if (isBlocked) return '#ef4444';
    // Rule 3: Blocking is always Amber (#f59e0b)
    const isBlocking = data?.blockedEvaluation?.isBlocking ?? item?.isBlocking;
    if (isBlocking) return '#f59e0b';
    // Rule 4: Normal / Done is neutral Slate (#94a3b8)
    return '#94a3b8';
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* 1. Header Toolbar */}
      <div className="p-3 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Mode Tabs & Quick Filters */}
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            {/* Graph vs Matrix Switcher */}
            <div className="flex items-center p-0.5 rounded-lg bg-slate-100/90 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <button
                onClick={() => setActiveTab('graph')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  activeTab === 'graph'
                    ? 'bg-white dark:bg-[#161F2E] text-brand-600 dark:text-brand-400 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Network className="w-3.5 h-3.5" />
                <span>{t('tabs.graph')}</span>
              </button>
              <button
                onClick={() => setActiveTab('matrix')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  activeTab === 'matrix'
                    ? 'bg-white dark:bg-[#161F2E] text-brand-600 dark:text-brand-400 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Table className="w-3.5 h-3.5" />
                <span>{t('tabs.matrix')}</span>
              </button>
            </div>

            <div className="h-4 w-px bg-slate-200 dark:bg-slate-800 hidden sm:block" />

            {/* Quick Filter Tabs */}
            <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
              <button
                onClick={() => setFilterMode('all')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                  filterMode === 'all'
                    ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                <span>{t('filters.all')} ({renderCount(dependentItems.length)})</span>
              </button>

              <button
                onClick={() => setFilterMode('blocked')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                  filterMode === 'blocked'
                    ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                <AlertTriangle className="w-3 h-3 text-rose-500" />
                <span>{t('overview.blocked')} ({renderCount(blockedCount)})</span>
              </button>

              <button
                onClick={() => setFilterMode('blocking')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                  filterMode === 'blocking'
                    ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                <ArrowRight className="w-3 h-3 text-amber-500" />
                <span>{t('overview.blocking')} ({renderCount(blockingCount)})</span>
              </button>

              <button
                onClick={() => setFilterMode('my-tasks')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                  filterMode === 'my-tasks'
                    ? 'bg-white dark:bg-[#161F2E] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                <User className="w-3 h-3 text-emerald-500" />
                <span>{t('workFocus.myTasks', { ns: 'common' })} ({renderCount(myTasksCount)})</span>
              </button>
            </div>
          </div>

          {/* Right: Graph Focus Depth & Controls */}
          {activeTab === 'graph' ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {/* Hop Depth Selector */}
              <div className="flex items-center gap-1 border border-slate-200 dark:border-slate-800 rounded-lg p-0.5 bg-slate-50 dark:bg-slate-900">
                <span className="text-[11px] text-slate-400 font-bold px-2">{t('hops.label')}</span>
                <button
                  onClick={() => setHopDistance(1)}
                  className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors ${
                    hopDistance === 1
                      ? 'bg-brand-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
                  }`}
                  title={t('hops.oneHopTitle')}
                >
                  {t('hops.oneHop')}
                </button>
                <button
                  onClick={() => setHopDistance(2)}
                  className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors ${
                    hopDistance === 2
                      ? 'bg-brand-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
                  }`}
                  title={t('hops.twoHopsTitle')}
                >
                  {t('hops.twoHops')}
                </button>
                <button
                  onClick={() => setHopDistance('all')}
                  className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors ${
                    hopDistance === 'all'
                      ? 'bg-brand-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
                  }`}
                  title={t('hops.fullChainTitle')}
                >
                  {t('hops.fullChain')}
                </button>
                <button
                  onClick={() => setHopDistance('connected')}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold transition-colors ${
                    hopDistance === 'connected'
                      ? 'bg-brand-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
                  }`}
                  title={t('hops.connectedTitle')}
                  data-testid="hops-connected"
                >
                  <Share2 className="w-3 h-3" />
                  <span>{t('hops.connected')}</span>
                </button>
              </div>

              {/* Hide Completed Toggle */}
              <button
                onClick={() => setHideCompleted(h => !h)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                  hideCompleted
                    ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
                    : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
                title={t('hops.hideCompletedTitle')}
              >
                <EyeOff className="w-3.5 h-3.5" />
                <span>{t('hops.hideCompleted')}</span>
              </button>

              {/* Center on Focus Button */}
              <button
                onClick={() => centerOnFocus(250)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title={t('hops.centerOnFocusTitle')}
                data-testid="graph-center"
              >
                <Target className="w-3.5 h-3.5" />
                <span>{t('hops.centerOnFocus')}</span>
              </button>

              {/* Fit to View Button */}
              <button
                onClick={() => centerGraphView(250)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title={t('hops.fitTitle')}
                data-testid="graph-fit"
              >
                <Crosshair className="w-3.5 h-3.5" />
                <span>{t('hops.fit')}</span>
              </button>
            </div>
          ) : (
            /* Search input for Matrix view */
            <div className="relative min-w-[220px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t('focus.searchMatrix')}
                className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          )}
        </div>

        {/* Clear Focus vs Selection Header Bar */}
        {activeTab === 'graph' && graphData.focusedItem && (
          <div className="flex flex-col gap-2 pt-1 text-xs min-w-0">
            <div className="flex items-center justify-between gap-3 min-w-0">
              <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden text-slate-600 dark:text-slate-300">
                {/* Focus Anchor */}
                <span className="flex items-center gap-1.5 text-xs min-w-0">
                  <span className="font-bold text-slate-500 uppercase tracking-wider text-[11px] shrink-0">
                    {t('focus.centerLabel')}
                  </span>
                  <span className="font-mono font-bold text-brand-600 dark:text-brand-400 shrink-0">
                    #{graphData.focusedItem.id}
                  </span>
                  <span
                    className="font-semibold text-slate-900 dark:text-slate-100 truncate min-w-0 max-w-sm"
                    title={graphData.focusedItem.title}
                  >
                    {graphData.focusedItem.title}
                  </span>
                  <span className="text-[10px] text-slate-400 truncate min-w-0 shrink" title={graphData.focusedItem.project}>
                    ({graphData.focusedItem.project})
                  </span>
                </span>

                {/* Inspected Item if different from focus */}
                {selectedWorkItem && selectedWorkItem.id !== graphData.focusedItem.id && (
                  <>
                    <span className="text-slate-300 dark:text-slate-700">•</span>
                    <span className="flex items-center gap-1.5 text-xs text-slate-500">
                      <span className="font-bold uppercase tracking-wider text-[11px]">{t('focus.inspecting')}</span>
                      <span className="font-mono font-bold text-slate-800 dark:text-slate-200">#{selectedWorkItem.id}</span>
                      <span className="truncate max-w-[200px] font-medium">{selectedWorkItem.title}</span>
                    </span>
                  </>
                )}
              </div>

              {/* Quick Task Switcher Dropdown & Live Updating Status */}
              <div className="flex items-center gap-2 shrink-0">
                {isGraphUpdating && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-brand-600 bg-brand-50 dark:bg-brand-950/60 border border-brand-200 dark:border-brand-900 animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-brand-500 animate-ping" />
                    <span>{t('focus.graphUpdating')}</span>
                  </span>
                )}
                <span className="text-[11px] text-slate-400">{t('focus.switchLabel')}</span>
                <select
                  value={focusId || ''}
                  onChange={e => {
                    const targetId = parseInt(e.target.value, 10);
                    handleSetFocus(targetId);
                  }}
                  aria-label={t('focus.switchAria')}
                  className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-800 dark:text-slate-200 rounded px-2 py-1 focus:outline-none cursor-pointer max-w-[240px] truncate"
                >
                  {dependentItems.map(item => (
                    <option key={item.id} value={item.id} className="bg-white dark:bg-slate-900">
                      #{item.id} {item.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Scope vs Center Focus Explanatory Badge & Context Strip */}
            <div className="flex items-center justify-between gap-3 text-[11px] pt-0.5 border-t border-slate-100 dark:border-slate-800/80">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md font-semibold bg-brand-50 dark:bg-brand-950/60 text-brand-700 dark:text-brand-300 border border-brand-200/90 dark:border-brand-800/80 shadow-2xs">
                  <Crosshair className="w-3 h-3 text-brand-500 shrink-0" />
                  <span>
                    {t('focus.focusDetails', {
                      id: graphData.focusedItem.id,
                      hopLabel:
                        hopDistance === 'connected'
                          ? t('hops.connected')
                          : hopDistance === 'all'
                          ? t('hops.fullChain')
                          : hopDistance === 1
                          ? t('hops.oneHop')
                          : t('hops.twoHops'),
                      nodes: hasLoadedPool ? nodes.length : '—',
                      edges: hasLoadedPool ? edges.length : '—'
                    })}
                  </span>
                </span>

                <span
                  className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 bg-slate-100/90 dark:bg-slate-900/90 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-800 truncate"
                  title={scopeTip}
                >
                  <Info className="w-3 h-3 text-slate-400 shrink-0" />
                  <span className="truncate">{scopeTip}</span>
                  <button
                    onClick={() => setActiveTab('matrix')}
                    className="text-brand-600 dark:text-brand-400 underline font-medium hover:text-brand-700 ml-1 shrink-0"
                  >
                    {t('tabs.matrix')}
                  </button>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Circular Dependency Alert */}
      {graphData.hasCycles && (
        <div className="p-2.5 px-6 bg-rose-50 dark:bg-rose-950/60 border-b border-rose-200 dark:border-rose-900/60 flex items-center gap-2 text-xs text-rose-800 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
          <span>
            <strong>{t('alert.title')}</strong>{' '}{t('alert.cycleLoop', { path: graphData.cyclePaths[0].join(' ➔ ') })}
          </span>
        </div>
      )}

      {/* 2. Main Work Area: Master (Graph or Matrix) + Detail (WorkItemInspector) */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Side: Interactive ReactFlow Graph or Tabular Matrix */}
        <div className="flex-1 flex flex-col min-w-0 h-full relative overflow-hidden">
          {booting || (poolLoading && !poolData) ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3" data-testid="dependency-loading">
              <div className="w-7 h-7 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">{t('graph.loading')}</span>
            </div>
          ) : poolError && !poolData ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-6" role="alert" data-testid="dependency-error">
              <Network className="w-8 h-8 text-rose-400" />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('graph.loadFailed')}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 max-w-sm">{poolError}</span>
              <button
                onClick={retryPool}
                data-testid="dependency-retry"
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-md transition-colors"
              >
                {t('graph.retry')}
              </button>
            </div>
          ) : activeTab === 'graph' ? (
            <div className="flex-1 w-full h-full relative">
              {nodes.length === 0 ? (
                <div className="flex-1 h-full flex flex-col items-center justify-center text-slate-400 gap-3">
                  <Network className="w-8 h-8 text-slate-300" />
                  <span className="text-xs">{t('graph.noDependencies')}</span>
                </div>
              ) : (
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onNodeClick={handleNodeClick}
                  nodeTypes={nodeTypes}
                  onInit={setReactFlowInstance}
                  fitView
                  fitViewOptions={{ padding: { top: '48px', bottom: '140px', left: '56px', right: '56px' }, minZoom: 0.35, maxZoom: 1.1 }}
                  minZoom={0.3}
                  maxZoom={1.5}
                  defaultViewport={{ x: 0, y: 0, zoom: 0.95 }}
                  proOptions={{ hideAttribution: true }}
                  className="bg-[#F8FAFC] dark:bg-[#0B0F17]"
                >
                  <Background
                    color={theme === 'dark' ? '#1F293D' : '#E2E8F0'}
                    gap={20}
                    size={1.5}
                  />
                  <Controls className="!bg-white dark:!bg-[#111726] !border-slate-200 dark:!border-slate-800 !rounded-lg !shadow-sm" />

                  {/* Flow Direction Overlay (Top-left keeps the bottom-left Controls clickable) */}
                  <div className="absolute top-3 left-3 z-10 p-2.5 rounded-lg bg-white/95 dark:bg-[#111726]/95 border border-slate-200 dark:border-slate-800 shadow-sm text-[11px] text-slate-600 dark:text-slate-400 flex items-center gap-3 backdrop-blur-xs select-none">
                    <span className="font-bold text-indigo-600 dark:text-indigo-400">
                      {t('legend.left')}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                    <span className="font-bold text-brand-600 dark:text-brand-400">
                      {t('legend.centerFocusedItem')}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                    <span className="font-bold text-cyan-600 dark:text-cyan-400">
                      {t('legend.right')}
                    </span>
                  </div>

                  {/* Redesigned Integrated MiniMap & Legend Dock Widget (Right) */}
                  <div className="absolute bottom-4 right-4 z-10 w-52 rounded-xl overflow-hidden bg-white/95 dark:bg-[#111726]/95 border border-slate-200/90 dark:border-slate-800 shadow-md backdrop-blur-md select-none">
                    {/* Dock Header */}
                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-300 bg-slate-50/70 dark:bg-slate-900/60">
                      <span className="flex items-center gap-1.5">
                        <Compass className="w-3.5 h-3.5 text-brand-500" />
                        <span>{t('legend.overview')}</span>
                      </span>
                    </div>

                    {/* MiniMap Canvas Area */}
                    <div className="h-28 w-full relative overflow-hidden bg-slate-50/40 dark:bg-slate-950/40">
                      <MiniMap
                        nodeColor={getMiniMapNodeColor}
                        nodeStrokeColor={theme === 'dark' ? '#0B0F17' : '#FFFFFF'}
                        nodeStrokeWidth={2}
                        nodeBorderRadius={4}
                        maskColor={theme === 'dark' ? 'rgba(11, 15, 23, 0.75)' : 'rgba(248, 250, 252, 0.75)'}
                        className="!static !m-0 !w-full !h-full !border-0 !bg-transparent"
                        zoomable
                        pannable
                      />
                    </div>

                    {/* Integrated Micro-Legend Footer matching exact MiniMap colors */}
                    <div className="p-2 px-3 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-600 dark:text-slate-300 grid grid-cols-2 gap-1.5 bg-white/95 dark:bg-[#111726]/95">
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#0284c7] shrink-0 shadow-2xs" />
                        <span className="truncate">{t('legend.center')}</span>
                      </span>
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#ef4444] shrink-0 shadow-2xs" />
                        <span className="truncate">{t('legend.blocked')}</span>
                      </span>
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b] shrink-0 shadow-2xs" />
                        <span className="truncate">{t('legend.blocking')}</span>
                      </span>
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#94a3b8] shrink-0 shadow-2xs" />
                        <span className="truncate">{t('legend.active')}</span>
                      </span>
                    </div>
                  </div>
                </ReactFlow>
              )}
            </div>
          ) : (
            /* Modern Data Grid Dependency Matrix with Overflow Protection */
            <div className="flex-1 overflow-x-auto overflow-y-auto p-4 sm:p-5">
              <div className="min-w-[680px] bg-white dark:bg-[#0E131F] rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-[#0B0F17]/95 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
                      <th className="py-2.5 px-3.5 w-16">{t('matrix.colId')}</th>
                      <th className="py-2.5 px-3">{t('matrix.colWorkItem')}</th>
                      <th className="py-2.5 px-3 w-20">{t('matrix.colState')}</th>
                      <th className="py-2.5 px-3 w-44">{t('matrix.colPredecessors')}</th>
                      <th className="py-2.5 px-3 w-36">{t('matrix.colSuccessors')}</th>
                      <th className="py-2.5 px-3 w-24 text-center">{t('matrix.colRisk')}</th>
                      <th className="py-2.5 px-3 w-28 text-right">{t('matrix.colAssignee')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                    {matrixItems.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-12 text-center text-slate-400 italic">
                          {t('matrix.noMatch')}
                        </td>
                      </tr>
                    ) : (
                      matrixItems.map(item => {
                        const evalResult = evaluateItemBlockedStatus(item);
                        const isSelected = selectedWorkItem?.id === item.id;
                        const isFocus = focusId === item.id;

                        // Tooltips for details
                        const predTooltip = [
                          ...evalResult.blockingPredecessors.map(p => t('matrix.tooltipBlocker', { id: p.id, title: p.title, state: stateLabel(t, p.state) })),
                          ...evalResult.resolvedPredecessors.map(p => t('matrix.tooltipDone', { id: p.id, title: p.title, state: stateLabel(t, p.state) }))
                        ].join('\n');

                        const succTooltip = (item.relations?.successors || [])
                          .map(s => t('matrix.tooltipSuccessor', { id: s.id, title: s.title || t('fallback.unresolved', { ns: 'common' }), state: s.state ? stateLabel(t, s.state) : t('fallback.unknownState', { ns: 'common' }) }))
                          .join('\n');

                        return (
                          <tr
                            key={item.id}
                            onClick={() => {
                              setSelectedWorkItem(item);
                            }}
                            onDoubleClick={() => {
                              handleSetFocus(item.id);
                              setActiveTab('graph');
                            }}
                            className={`cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-brand-50/70 dark:bg-brand-950/40 border-l-4 border-l-brand-600'
                                : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40 border-l-4 border-l-transparent'
                            }`}
                          >
                            {/* ID with quick focus trigger */}
                            <td className="py-2.5 px-3.5 font-mono font-bold text-slate-400">
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSetFocus(item.id);
                                    setActiveTab('graph');
                                  }}
                                  title={t('focus.focusInGraph')}
                                  data-testid={`matrix-focus-${item.id}`}
                                  className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-950/70 transition-colors"
                                >
                                  <Crosshair className="w-3 h-3" />
                                </button>
                                <span>#{item.id}</span>
                              </div>
                            </td>

                            {/* Work Item Title & Project */}
                            <td className="py-2.5 px-3 min-w-[180px]">
                              <div className="flex items-center gap-2">
                                <span
                                  title={item.title}
                                  className="font-semibold text-slate-900 dark:text-slate-100 text-[13.5px] truncate max-w-sm"
                                >
                                  {item.title}
                                </span>
                                {isFocus && (
                                  <span className="text-[10px] font-bold text-brand-600 bg-brand-50 dark:bg-brand-950 px-1.5 py-0.2 rounded shrink-0">
                                    {t('matrix.focusBadge')}
                                  </span>
                                )}
                              </div>
                              <span className="text-[11px] text-slate-400">{item.project} • {item.type}</span>
                            </td>

                            {/* State */}
                            <td className="py-2.5 px-3">
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                                {stateLabel(t, item.state)}
                              </span>
                            </td>

                            {/* Compact Predecessors Summary */}
                            <td className="py-2.5 px-3" title={predTooltip}>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {evalResult.blockingPredecessors.length > 0 && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400 border border-rose-200 dark:border-rose-900">
                                    <AlertTriangle className="w-3 h-3" />
                                    {t('matrix.blockers', { count: evalResult.blockingPredecessors.length })}
                                  </span>
                                )}
                                {evalResult.resolvedPredecessors.length > 0 && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900">
                                    <CheckCircle2 className="w-3 h-3" />
                                    {t('matrix.doneCount', { count: evalResult.resolvedPredecessors.length })}
                                  </span>
                                )}
                                {evalResult.blockingPredecessors.length === 0 && evalResult.resolvedPredecessors.length === 0 && (
                                  <span className="text-slate-400 italic text-[11px]">{t('matrix.none')}</span>
                                )}
                              </div>
                            </td>

                            {/* Compact Successors Summary */}
                            <td className="py-2.5 px-3" title={succTooltip}>
                              {item.relations?.successors?.length > 0 ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-cyan-50 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-900">
                                  <ArrowUpRight className="w-3 h-3" />
                                  {t('matrix.successors', { count: item.relations.successors.length })}
                                </span>
                              ) : (
                                <span className="text-slate-400 italic text-[11px]">{t('matrix.none')}</span>
                              )}
                            </td>

                            {/* Block Risk Status */}
                            <td className="py-2.5 px-3 text-center">
                              {evalResult.isBlocked ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400 border border-rose-200 dark:border-rose-900">
                                  <AlertTriangle className="w-3 h-3" />
                                  {t('matrix.riskBlocked')}
                                </span>
                              ) : evalResult.isBlocking ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400 border border-amber-200 dark:border-amber-900">
                                  {t('matrix.riskBlocking')}
                                </span>
                              ) : (
                                <span className="text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold">
                                  {t('matrix.riskClear')}
                                </span>
                              )}
                            </td>

                            {/* Assignee */}
                            <td className="py-2.5 px-3 text-right">
                              {item.isUnassigned ? (
                                <span className="text-amber-600 dark:text-amber-400 font-medium">{t('fields.unassigned', { ns: 'common' })}</span>
                              ) : (
                                <span className="text-slate-700 dark:text-slate-300 font-medium truncate max-w-[100px] inline-block">{item.assignedTo}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right Side: Work Item Inspector (Master-Detail side-by-side) */}
        {selectedWorkItem && (
          <WorkItemInspector
            item={selectedWorkItem}
            onClose={() => setSelectedWorkItem(null)}
            onNavigateToItem={(target) => {
              setSelectedWorkItem(target);
              void openWorkItem(target.id);
            }}
            onSetFocus={(target) => {
              handleSetFocus(target.id);
              setActiveTab('graph');
            }}
            isFocusedInGraph={focusId === selectedWorkItem.id}
          />
        )}
      </div>

      {/* 3. Footer Bar */}
      <div className="h-9 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] px-5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 select-none shrink-0">
        <div className="flex items-center gap-3">
          <span>
            {activeTab === 'graph'
              ? hasLoadedPool
                ? nodes.length > 0
                  ? t('focus.renderingInfo', { nodes: nodes.length, edges: edges.length })
                  : t('graph.noDependencies')
                : '—'
              : hasLoadedPool
              ? t('matrix.showing', { count: matrixItems.length })
              : '—'}
          </span>
          {filters.selectedProject !== 'all' && (
            <span>• {t('filters.project', { ns: 'kanban', project: filters.selectedProject })}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span>{t('focus.hint')}</span>
        </div>
      </div>
    </div>
  );
};
