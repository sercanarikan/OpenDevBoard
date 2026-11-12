import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AppContext, type AppContextType } from './useApp';
import { useLocation, useNavigate } from 'react-router-dom';
import type { WorkItem, WorkItemsPoolResponse, ViewMode, FilterOptions } from '../types';
import { getViewFromPath, getPathForView, ROUTE_PATH_MAP } from '../utils/routes';
import {
  ApiError,
  type SummaryResponse,
  type SyncReportResponse,
  type WorkItemsApi,
  type PullRequest,
  type PipelineRun,
  type DeploymentRecord
} from '../types/paging';
import { liveApi, fetchSyncReport, fetchPool, fetchOrgProjects, postSync, onNetworkEvent } from '../services/liveApi';
import { demoApi } from '../services/demoApi';
import { generateMockPoolResponse, CURRENT_USER_NAME } from '../services/mockData';
import { deriveSyncIndicator, type DataSourceKind } from '../utils/syncState';
import i18n from '../i18n';

export const SYNC_POLL_MS = 20000;
const LOST_AFTER_FAILURES = 2;


const defaultFilters: FilterOptions = {
  searchQuery: '',
  selectedProject: 'all',
  quickFilter: 'my-tasks', // Default to My Tasks
  selectedTypes: [],
  selectedStates: [],
  selectedPriorities: [],
  selectedAssignees: [],
  sortBy: 'changedDate',
  sortOrder: 'desc',
  density: 'compact'
};


const errMessage = (e: unknown): string => {
  if (e instanceof ApiError) return e.isNetwork ? i18n.t('api.connectionRefused') : e.message;
  return (e as Error)?.message || i18n.t('api.unexpectedConnectionError');
};

/** Keeps the previous summary visible during a new request and ignores aborted responses. */
function useScopedSummary<T>(
  request: (signal: AbortSignal) => Promise<T>, enabled: boolean, refreshToken: number, label: string
) {
  const requestKey = useMemo(() => ({ request, enabled, refreshToken }), [request, enabled, refreshToken]);
  const [result, setResult] = useState<{ key: typeof requestKey | null; data: T | null; error: string | null }>({
    key: null, data: null, error: null
  });
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    request(ctrl.signal).then(data => {
      if (!ctrl.signal.aborted) setResult({ key: requestKey, data, error: null });
    }).catch(e => {
      if (ctrl.signal.aborted || (e instanceof ApiError && e.isAbort)) return;
      const message = errMessage(e);
      setResult(prev => ({ key: requestKey, data: prev.data, error: message }));
      console.warn(`${label} summary failed:`, message);
    });
    return () => ctrl.abort();
  }, [request, enabled, requestKey, label]);
  return {
    data: result.data,
    loading: !enabled ? result.key === null : result.key !== requestKey,
    error: result.key === requestKey ? result.error : null
  };
}

const DENSITY_STORAGE_KEY = 'devopsflow_density';
const EMPTY_PROJECTS: string[] = [];
const readDensityPref = (): 'comfortable' | 'compact' => {
  try {
    const val = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (val === 'comfortable' || val === 'compact') return val;
  } catch {}
  return 'comfortable';
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('devopsflow_theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'light';
  });

  const location = useLocation();
  const navigate = useNavigate();
  const viewMode = getViewFromPath(location.pathname);
  const [selectedWorkItem, setSelectedWorkItemState] = useState<WorkItem | null>(null);

  const [filters, setFilters] = useState<FilterOptions>(() => {
    const params = new URLSearchParams(location.search);
    const proj = params.get('project');
    const qf = params.get('quickFilter') || params.get('view');
    const initial = { ...defaultFilters, density: readDensityPref() };
    if (proj && proj !== 'all') {
      initial.selectedProject = proj;
    }
    if (qf && ['all', 'my-tasks', 'unassigned', 'blocked', 'bugs'].includes(qf)) {
      initial.quickFilter = qf as any;
    }
    return initial;
  });

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);

  const density = filters.density;
  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, density);
    } catch {}
  }, [density]);

  const setDensity = useCallback((d: 'comfortable' | 'compact') => {
    setFilters(prev => ({ ...prev, density: d }));
  }, []);
  const toggleDensity = useCallback(() => {
    setFilters(prev => ({ ...prev, density: prev.density === 'compact' ? 'comfortable' : 'compact' }));
  }, []);

  const setViewMode = useCallback((mode: ViewMode) => {
    if (location.pathname !== ROUTE_PATH_MAP[mode]) {
      navigate(getPathForView(mode, location.search));
    }
  }, [location.pathname, location.search, navigate]);

  // Synchronize selectedProject to URL search parameters
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const currentProj = params.get('project') || 'all';
    if (filters.selectedProject !== currentProj) {
      if (filters.selectedProject === 'all') {
        params.delete('project');
      } else {
        params.set('project', filters.selectedProject);
      }
      const newSearch = params.toString() ? `?${params.toString()}` : '';
      navigate(`${location.pathname}${newSearch}`, { replace: true });
    }
  }, [filters.selectedProject, location.pathname, location.search, navigate]);

  const [api, setApi] = useState<WorkItemsApi>(liveApi);
  const [source, setSource] = useState<DataSourceKind>('live');
  const [booting, setBooting] = useState<boolean>(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isBannerDismissed, setIsBannerDismissed] = useState<boolean>(false);
  const [currentUserName, setCurrentUserName] = useState<string>('');
  const [userKnown, setUserKnown] = useState<boolean>(false);

  const [summaryResult, setSummaryResult] = useState<{
    data: SummaryResponse; project: string; user: string; api: WorkItemsApi;
  } | null>(null);
  const summary = summaryResult?.project === filters.selectedProject && summaryResult.user === currentUserName && summaryResult.api === api
    ? summaryResult.data : null;
  const orgScope = useMemo(() => ({ booting, source }), [booting, source]);
  const [orgResult, setOrgResult] = useState<{ scope: typeof orgScope | null; names: string[] }>({ scope: null, names: [] });
  const orgProjects = orgResult.scope === orgScope ? orgResult.names : EMPTY_PROJECTS;
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [syncReport, setSyncReport] = useState<SyncReportResponse | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const [livePoolData, setLivePoolData] = useState<WorkItemsPoolResponse | null>(null);
  const [poolWanted, setPoolWanted] = useState<boolean>(false);
  const [poolNonce, setPoolNonce] = useState<number>(0);
  const poolKey = useMemo(() => ({ poolWanted, booting, source, refreshToken, poolNonce }),
    [poolWanted, booting, source, refreshToken, poolNonce]);
  const [poolResult, setPoolResult] = useState<{ key: typeof poolKey | null; error: string | null }>({ key: null, error: null });
  const poolEnabled = poolWanted && !booting && source !== 'demo' && source !== 'lost';
  const poolLoading = poolEnabled && poolResult.key !== poolKey;
  const poolError = poolResult.key === poolKey ? poolResult.error : null;
  const demoPool = useMemo(() => poolWanted && !booting && source === 'demo' ? generateMockPoolResponse() : null,
    [poolWanted, booting, source]);
  const poolData = source === 'demo' ? demoPool : livePoolData;

  const failuresRef = useRef(0);
  const dataVersionRef = useRef<string>('');
  const sourceRef = useRef<DataSourceKind>('live');
  useEffect(() => { sourceRef.current = source; }, [source]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.remove('dark');
      root.classList.add('light');
    }
    localStorage.setItem('devopsflow_theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme(prev => (prev === 'dark' ? 'light' : 'dark')), []);

  const enterDemo = useCallback((reason: string) => {
    setApi(demoApi);
    setSource('demo');
    setCurrentUserName(CURRENT_USER_NAME);
    setUserKnown(true);
    setConnectionError(reason);
    setSyncReport(null);
    setLivePoolData(null);
    setBooting(false);
  }, []);

  /** Decides the data source: live (or fixture) backend when reachable, otherwise explicit Demo Mode. */
  const connectRef = useRef<AbortController | null>(null);
  const connect = useCallback(() => {
    connectRef.current?.abort();
    const ctrl = new AbortController();
    connectRef.current = ctrl;
    return liveApi.me(ctrl.signal).then(me => {
      if (ctrl.signal.aborted) return false;
      failuresRef.current = 0;
      setApi(liveApi);
      setSource(me.source === 'fixture' ? 'fixture' : 'live');
      setConnectionError(null);
      const name = (me.displayName || '').trim();
      setCurrentUserName(name);
      setUserKnown(!!name);
      if (!name) setFilters(f => (f.quickFilter === 'my-tasks' ? { ...f, quickFilter: 'all' } : f));
      setBooting(false);
      return true;
    }).catch(e => {
      if (ctrl.signal.aborted) return false;
      enterDemo(errMessage(e));
      return true;
    });
  }, [enterDemo]);

  useEffect(() => {
    connect();
    return () => connectRef.current?.abort();
  }, [connect]);

  const isBackend = source === 'live' || source === 'fixture' || source === 'lost';

  // Counters for the selected project scope.
  useEffect(() => {
    if (booting) return;
    const ctrl = new AbortController();
    api
      .summary(filters.selectedProject, currentUserName, ctrl.signal)
      .then(s => {
        if (!ctrl.signal.aborted) {
          setSummaryResult({ data: s, project: filters.selectedProject, user: currentUserName, api });
        }
      })
      .catch(e => {
        if (!ctrl.signal.aborted && !(e instanceof ApiError && e.isAbort)) console.warn('summary failed:', errMessage(e));
      });
    return () => ctrl.abort();
  }, [api, booting, filters.selectedProject, currentUserName, refreshToken]);

  // Org projects (including ones without active items); live only, the fixture/demo have no org.
  useEffect(() => {
    if (booting || source !== 'live') return;
    let cancelled = false;
    fetchOrgProjects().then(names => { if (!cancelled) setOrgResult({ scope: orgScope, names }); });
    return () => {
      cancelled = true;
    };
  }, [booting, source, refreshToken, orgScope]);

  // Poll the sync state: detects finished syncs (data version change), running syncs and a lost backend.
  useEffect(() => {
    if (booting || !isBackend) return;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const report = await fetchSyncReport();
        if (controller.signal.aborted) return;
        failuresRef.current = 0;
        setSyncReport(report);
        if (sourceRef.current === 'lost') {
          setSource(report.source === 'fixture' ? 'fixture' : 'live');
          setConnectionError(null);
          setRefreshToken(n => n + 1);
        }
        const v = report.dataVersion || '';
        if (dataVersionRef.current && v && v !== dataVersionRef.current) setRefreshToken(n => n + 1);
        if (v) dataVersionRef.current = v;
      } catch (e) {
        if (controller.signal.aborted) return;
        failuresRef.current += 1;
        if (failuresRef.current >= LOST_AFTER_FAILURES && sourceRef.current !== 'lost') {
          setSource('lost');
          setConnectionError(errMessage(e));
          setIsBannerDismissed(false);
        }
      }
    };

    tick();
    const id = setInterval(tick, SYNC_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [booting, isBackend]);

  // Any failed request (a page, a search, an Inspector load) flags the backend as unreachable immediately; waiting
  // for the next 20 s poll would leave the user without a warning. The poll still performs the recovery.
  useEffect(() => {
    if (booting || !isBackend) return;
    return onNetworkEvent(({ ok, error }) => {
      if (ok) return;
      failuresRef.current = LOST_AFTER_FAILURES;
      if (sourceRef.current !== 'lost') {
        setSource('lost');
        setConnectionError(errMessage(error));
        setIsBannerDismissed(false);
      }
    });
  }, [booting, isBackend]);

  // While the backend is unreachable, probe quickly so recovery is noticed within seconds.
  useEffect(() => {
    if (source !== 'lost') return;
    const controller = new AbortController();
    const id = setInterval(async () => {
      try {
        const report = await fetchSyncReport();
        if (controller.signal.aborted) return;
        failuresRef.current = 0;
        setSyncReport(report);
        setSource(report.source === 'fixture' ? 'fixture' : 'live');
        setConnectionError(null);
        setRefreshToken(n => n + 1);
      } catch {
        /* still down */
      }
    }, 3000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [source]);

  const refreshData = useCallback(async () => {
    setRefreshToken(n => n + 1);
  }, []);

  const triggerSync = useCallback(
    async (mode: 'incremental' | 'full' = 'incremental') => {
      if (source === 'demo') return;
      setIsSyncing(true);
      try {
        await postSync(mode);
        try {
          setSyncReport(await fetchSyncReport());
        } catch {
          /* the poll reports a lost backend */
        }
        setRefreshToken(n => n + 1);
      } finally {
        setIsSyncing(false);
      }
    },
    [source]
  );

  const retryConnection = useCallback(async () => {
    setBooting(true);
    setIsBannerDismissed(false);
    failuresRef.current = 0;
    if (await connect()) setRefreshToken(n => n + 1);
  }, [connect]);

  const dismissConnectionBanner = useCallback(() => setIsBannerDismissed(true), []);

  // ---- Lazy full hierarchy (Story & Tasks, Dependency Explorer) ------------------------------
  const ensurePool = useCallback(() => setPoolWanted(true), []);
  const retryPool = useCallback(() => setPoolNonce(n => n + 1), []);

  useEffect(() => {
    if (!poolEnabled) return;
    const ctrl = new AbortController();
    fetchPool(ctrl.signal)
      .then(p => {
        if (ctrl.signal.aborted) return;
        setLivePoolData(p);
        setPoolResult({ key: poolKey, error: null });
      })
      .catch(e => {
        if (ctrl.signal.aborted || (e instanceof ApiError && e.isAbort)) return;
        setPoolResult({ key: poolKey, error: errMessage(e) });
      });
    return () => ctrl.abort();
  }, [poolEnabled, poolKey]);

  // ---- Inspector -----------------------------------------------------------------------------
  const setSelectedWorkItem = useCallback((item: WorkItem | null) => setSelectedWorkItemState(item), []);

  const openWorkItem = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        const item = await api.item(id);
        if (!item) return false;
        setSelectedWorkItemState(item);
        return true;
      } catch (e) {
        console.warn('open work item failed:', errMessage(e));
        return false;
      }
    },
    [api]
  );

  // Keep the open item fresh after a sync without ever closing it because a list no longer contains it.
  const selectedIdRef = useRef<number | null>(null);
  useEffect(() => { selectedIdRef.current = selectedWorkItem?.id ?? null; }, [selectedWorkItem?.id]);
  useEffect(() => {
    const id = selectedIdRef.current;
    if (!id || refreshToken === 0 || booting) return;
    const ctrl = new AbortController();
    api
      .item(id, ctrl.signal)
      .then(fresh => {
        if (fresh && !ctrl.signal.aborted) setSelectedWorkItemState(current => current?.id === id ? fresh : current);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [refreshToken, api, booting]);

  const resetFilters = useCallback(() => setFilters(prev => ({ ...defaultFilters, density: prev.density })), []);

  const prRequest = useCallback((signal: AbortSignal) => api.pullRequestsSummary(filters.selectedProject, signal), [api, filters.selectedProject]);
  const pipelineRequest = useCallback((signal: AbortSignal) => api.pipelinesSummary(30, filters.selectedProject, signal), [api, filters.selectedProject]);
  const deploymentRequest = useCallback((signal: AbortSignal) => api.deploymentsSummary(30, filters.selectedProject, signal), [api, filters.selectedProject]);
  const { data: prSummary, loading: prSummaryLoading, error: prSummaryError } = useScopedSummary(prRequest, !booting, refreshToken, 'PR');
  const { data: pipelineSummary, loading: pipelineSummaryLoading, error: pipelineSummaryError } = useScopedSummary(pipelineRequest, !booting, refreshToken, 'Pipeline');
  const { data: deploymentSummary, loading: deploymentSummaryLoading, error: deploymentSummaryError } = useScopedSummary(deploymentRequest, !booting, refreshToken, 'Deployment');
  const [selectedPR, setSelectedPR] = useState<PullRequest | null>(null);
  const [selectedPipelineRun, setSelectedPipelineRun] = useState<PipelineRun | null>(null);

  const [deploymentSelection, setDeploymentSelection] = useState<{ deployment: DeploymentRecord; project: string } | null>(null);
  if (deploymentSelection && deploymentSelection.project !== filters.selectedProject) {
    setDeploymentSelection(null);
  }
  const selectedDeployment = deploymentSelection?.project === filters.selectedProject ? deploymentSelection.deployment : null;
  const setSelectedDeployment = useCallback((deployment: DeploymentRecord | null) => {
    setDeploymentSelection(deployment ? { deployment, project: filters.selectedProject } : null);
  }, [filters.selectedProject]);

  const openPR = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        const pr = await api.pullRequest(id);
        if (!pr) return false;
        setSelectedPR(pr);
        return true;
      } catch (e) {
        console.warn('open PR failed:', errMessage(e));
        return false;
      }
    },
    [api]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen(prev => !prev);
      } else if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
      } else if (e.key === 'Escape') {
        if (isCommandPaletteOpen) setIsCommandPaletteOpen(false);
        else if (selectedWorkItem) setSelectedWorkItemState(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCommandPaletteOpen, selectedWorkItem]);

  const syncIndicator = useMemo(
    () => deriveSyncIndicator({ source, report: syncReport, isSyncing }),
    [source, syncReport, isSyncing]
  );

  const projects = useMemo(() => {
    const base = summaryResult?.data.projects ?? [];
    const known = new Set(base.map(p => p.name));
    const extra = orgProjects.filter(n => !known.has(n)).map(name => ({ name, total: 0 }));
    return [...base, ...extra].sort((a, b) => a.name.localeCompare(b.name));
  }, [summaryResult, orgProjects]);

  const value: AppContextType = {
    theme,
    toggleTheme,
    viewMode,
    setViewMode,
    selectedWorkItem,
    setSelectedWorkItem,
    openWorkItem,
    api,
    source,
    booting,
    isLive: source === 'live' || source === 'fixture' || source === 'lost',
    isDemo: source === 'demo',
    connectionError,
    isBannerDismissed,
    dismissConnectionBanner,
    retryConnection,
    currentUserName,
    userKnown,
    summary,
    projects,
    refreshToken,
    refreshData,
    syncReport,
    syncIndicator,
    isSyncing,
    triggerSync,
    poolData,
    poolLoading,
    poolError,
    ensurePool,
    retryPool,
    density,
    setDensity,
    toggleDensity,
    filters,
    setFilters,
    resetFilters,
    isCommandPaletteOpen,
    setIsCommandPaletteOpen,
    prSummary,
    prSummaryLoading,
    prSummaryError,
    selectedPR,
    setSelectedPR,
    openPR,
    pipelineSummary,
    selectedPipelineRun,
    setSelectedPipelineRun,
    pipelineSummaryLoading,
    pipelineSummaryError,
    deploymentSummary,
    deploymentSummaryLoading,
    deploymentSummaryError,
    selectedDeployment,
    setSelectedDeployment
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};
