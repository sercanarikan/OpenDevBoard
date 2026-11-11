import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { WorkItem, WorkItemsPoolResponse, ViewMode, FilterOptions } from '../types';
import { getViewFromPath, getPathForView, ROUTE_PATH_MAP } from '../utils/routes';
import {
  ApiError,
  type SummaryResponse,
  type SyncReportResponse,
  type WorkItemsApi,
  type PullRequest,
  type PullRequestsSummary,
  type PipelineSummary,
  type PipelineRun,
  type DeploymentSummary,
  type DeploymentRecord
} from '../types/paging';
import { liveApi, fetchSyncReport, fetchPool, fetchOrgProjects, postSync, onNetworkEvent } from '../services/liveApi';
import { demoApi } from '../services/demoApi';
import { generateMockPoolResponse, CURRENT_USER_NAME } from '../services/mockData';
import { deriveSyncIndicator, type DataSourceKind, type SyncIndicator } from '../utils/syncState';
import i18n from '../i18n';

export const SYNC_POLL_MS = 20000;
const LOST_AFTER_FAILURES = 2;

interface AppContextType {
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  viewMode: ViewMode | null;
  setViewMode: (mode: ViewMode) => void;

  /** Inspector selection. Independent of any list: it may point at an item no list currently shows. */
  selectedWorkItem: WorkItem | null;
  setSelectedWorkItem: (item: WorkItem | null) => void;
  /** Opens any work item by id (fetched from the API when it is not on screen). */
  openWorkItem: (id: number) => Promise<boolean>;

  /** Data access for the current source. Demo and live never mix: it is decided once per (re)connect. */
  api: WorkItemsApi;
  source: DataSourceKind;
  booting: boolean;
  isLive: boolean;      // live backend or fixture backend
  isDemo: boolean;
  connectionError: string | null;
  isBannerDismissed: boolean;
  dismissConnectionBanner: () => void;
  retryConnection: () => Promise<void>;

  currentUserName: string;
  userKnown: boolean;

  /** Canonical counters for the selected project scope (same definitions the list endpoints use). */
  summary: SummaryResponse | null;
  projects: { name: string; total: number }[];
  /** Increments whenever the served data changed (sync finished, manual refresh). */
  refreshToken: number;
  refreshData: () => Promise<void>;

  syncReport: SyncReportResponse | null;
  syncIndicator: SyncIndicator;
  isSyncing: boolean;
  triggerSync: (mode?: 'incremental' | 'full') => Promise<void>;

  /** Full hierarchy + relations. Loaded lazily, only for Story & Tasks / Dependency Explorer. */
  poolData: WorkItemsPoolResponse | null;
  poolLoading: boolean;
  poolError: string | null;
  ensurePool: () => void;
  retryPool: () => void;

  density: 'comfortable' | 'compact';
  setDensity: (density: 'comfortable' | 'compact') => void;
  toggleDensity: () => void;

  filters: FilterOptions;
  setFilters: React.Dispatch<React.SetStateAction<FilterOptions>>;
  resetFilters: () => void;
  isCommandPaletteOpen: boolean;
  setIsCommandPaletteOpen: (open: boolean) => void;

  prSummary: PullRequestsSummary | null;
  prSummaryLoading: boolean;
  prSummaryError: string | null;
  selectedPR: PullRequest | null;
  setSelectedPR: (pr: PullRequest | null) => void;
  openPR: (id: number) => Promise<boolean>;

  pipelineSummary: PipelineSummary | null;
  pipelineSummaryLoading: boolean;
  pipelineSummaryError: string | null;
  selectedPipelineRun: PipelineRun | null;
  setSelectedPipelineRun: (run: PipelineRun | null) => void;

  deploymentSummary: DeploymentSummary | null;
  deploymentSummaryLoading: boolean;
  deploymentSummaryError: string | null;
  selectedDeployment: DeploymentRecord | null;
  setSelectedDeployment: (dep: DeploymentRecord | null) => void;
}

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

const AppContext = createContext<AppContextType | undefined>(undefined);

const errMessage = (e: unknown): string => {
  if (e instanceof ApiError) return e.isNetwork ? i18n.t('api.connectionRefused') : e.message;
  return (e as Error)?.message || i18n.t('api.unexpectedConnectionError');
};

const DENSITY_STORAGE_KEY = 'devopsflow_density';
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

  const [density, setDensityState] = useState<'comfortable' | 'compact'>(readDensityPref);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, density);
    } catch {}
  }, [density]);

  const setDensity = useCallback((d: 'comfortable' | 'compact') => {
    setDensityState(d);
    setFilters(prev => ({ ...prev, density: d }));
  }, []);

  const toggleDensity = useCallback(() => {
    setDensityState(d => {
      const next = d === 'compact' ? 'comfortable' : 'compact';
      setFilters(prev => ({ ...prev, density: next }));
      return next;
    });
  }, []);

  const location = useLocation();
  const navigate = useNavigate();

  const currentPathView = getViewFromPath(location.pathname);
  const [viewMode, setViewModeState] = useState<ViewMode | null>(() => currentPathView);
  const [selectedWorkItem, setSelectedWorkItemState] = useState<WorkItem | null>(null);

  const [filters, setFilters] = useState<FilterOptions>(() => {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
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

  // Synchronize viewMode when browser pathname changes (Back / Forward)
  useEffect(() => {
    const v = getViewFromPath(location.pathname);
    if (v !== viewMode) {
      setViewModeState(v);
    }
  }, [location.pathname]);

  // Handle programmatical view navigation
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
    const targetUrl = getPathForView(mode, location.search);
    if (location.pathname !== ROUTE_PATH_MAP[mode]) {
      navigate(targetUrl);
    }
  }, [location.pathname, location.search, navigate]);

  // Synchronize URL search params (e.g. ?project=alms, ?quickFilter=blocked) on mount
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const proj = params.get('project');
    const qf = params.get('quickFilter') || params.get('view');
    const updates: Partial<FilterOptions> = {};
    if (proj && proj !== 'all') {
      updates.selectedProject = proj;
    }
    if (qf && ['all', 'my-tasks', 'unassigned', 'blocked', 'bugs'].includes(qf)) {
      updates.quickFilter = qf as any;
    }
    if (Object.keys(updates).length > 0) {
      setFilters(prev => ({ ...prev, ...updates }));
    }
  }, []);

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

  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [orgProjects, setOrgProjects] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [syncReport, setSyncReport] = useState<SyncReportResponse | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const [poolData, setPoolData] = useState<WorkItemsPoolResponse | null>(null);
  const [poolLoading, setPoolLoading] = useState<boolean>(false);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [poolWanted, setPoolWanted] = useState<boolean>(false);
  const [poolNonce, setPoolNonce] = useState<number>(0);

  const failuresRef = useRef(0);
  const dataVersionRef = useRef<string>('');
  const sourceRef = useRef<DataSourceKind>('live');
  sourceRef.current = source;

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
    setPoolData(null);
    setPoolError(null);
    setBooting(false);
  }, []);

  /** Decides the data source: live (or fixture) backend when reachable, otherwise explicit Demo Mode. */
  const connect = useCallback(async () => {
    setBooting(true);
    try {
      const me = await liveApi.me();
      failuresRef.current = 0;
      setApi(liveApi);
      setSource(me.source === 'fixture' ? 'fixture' : 'live');
      setConnectionError(null);
      const name = (me.displayName || '').trim();
      setCurrentUserName(name);
      setUserKnown(!!name);
      if (!name) setFilters(f => (f.quickFilter === 'my-tasks' ? { ...f, quickFilter: 'all' } : f));
      setBooting(false);
    } catch (e) {
      enterDemo(errMessage(e));
    }
  }, [enterDemo]);

  useEffect(() => {
    connect();
  }, [connect]);

  const isBackend = source === 'live' || source === 'fixture' || source === 'lost';

  // Counters for the selected project scope.
  useEffect(() => {
    if (booting) return;
    const ctrl = new AbortController();
    api
      .summary(filters.selectedProject, currentUserName, ctrl.signal)
      .then(s => {
        setSummary(s);
      })
      .catch(e => {
        if (!(e instanceof ApiError && e.isAbort)) console.warn('summary failed:', errMessage(e));
      });
    return () => ctrl.abort();
  }, [api, booting, filters.selectedProject, currentUserName, refreshToken]);

  // Org projects (including ones without active items); live only, the fixture/demo have no org.
  useEffect(() => {
    if (booting || source !== 'live') {
      setOrgProjects([]);
      return;
    }
    let cancelled = false;
    fetchOrgProjects().then(names => !cancelled && setOrgProjects(names));
    return () => {
      cancelled = true;
    };
  }, [booting, source, refreshToken]);

  // Poll the sync state: detects finished syncs (data version change), running syncs and a lost backend.
  useEffect(() => {
    if (booting || !isBackend) return;
    let stopped = false;

    const tick = async () => {
      try {
        const report = await fetchSyncReport();
        if (stopped) return;
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
        if (stopped) return;
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
      stopped = true;
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
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const report = await fetchSyncReport();
        if (stopped) return;
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
      stopped = true;
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
    setIsBannerDismissed(false);
    failuresRef.current = 0;
    await connect();
    setRefreshToken(n => n + 1);
  }, [connect]);

  const dismissConnectionBanner = useCallback(() => setIsBannerDismissed(true), []);

  // ---- Lazy full hierarchy (Story & Tasks, Dependency Explorer) ------------------------------
  const ensurePool = useCallback(() => setPoolWanted(true), []);
  const retryPool = useCallback(() => setPoolNonce(n => n + 1), []);

  useEffect(() => {
    if (!poolWanted || booting) return;
    if (source === 'demo') {
      setPoolData(generateMockPoolResponse());
      setPoolError(null);
      return;
    }
    if (source === 'lost') return;

    const ctrl = new AbortController();
    setPoolLoading(true);
    setPoolError(null);
    fetchPool(ctrl.signal)
      .then(p => {
        setPoolData(p);
        setPoolLoading(false);
      })
      .catch(e => {
        if (e instanceof ApiError && e.isAbort) return;
        setPoolError(errMessage(e));
        setPoolLoading(false);
      });
    return () => ctrl.abort();
  }, [poolWanted, booting, source, refreshToken, poolNonce]);

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
  selectedIdRef.current = selectedWorkItem?.id ?? null;
  useEffect(() => {
    const id = selectedIdRef.current;
    if (!id || refreshToken === 0 || booting) return;
    api
      .item(id)
      .then(fresh => {
        if (fresh && selectedIdRef.current === id) setSelectedWorkItemState(fresh);
      })
      .catch(() => undefined);
  }, [refreshToken, api, booting]);

  const resetFilters = useCallback(() => setFilters(defaultFilters), []);

  const [prSummary, setPrSummary] = useState<PullRequestsSummary | null>(null);
  const [prSummaryLoading, setPrSummaryLoading] = useState<boolean>(true);
  const [prSummaryError, setPrSummaryError] = useState<string | null>(null);
  const [selectedPR, setSelectedPR] = useState<PullRequest | null>(null);

  const [pipelineSummary, setPipelineSummary] = useState<PipelineSummary | null>(null);
  const [pipelineSummaryLoading, setPipelineSummaryLoading] = useState<boolean>(true);
  const [pipelineSummaryError, setPipelineSummaryError] = useState<string | null>(null);
  const [selectedPipelineRun, setSelectedPipelineRun] = useState<PipelineRun | null>(null);

  const [deploymentSummary, setDeploymentSummary] = useState<DeploymentSummary | null>(null);
  const [deploymentSummaryLoading, setDeploymentSummaryLoading] = useState<boolean>(true);
  const [deploymentSummaryError, setDeploymentSummaryError] = useState<string | null>(null);
  const [selectedDeployment, setSelectedDeployment] = useState<DeploymentRecord | null>(null);

  useEffect(() => {
    if (booting) return;
    setPrSummaryLoading(true);
    setPrSummaryError(null);
    const ctrl = new AbortController();
    api
      .pullRequestsSummary(filters.selectedProject, ctrl.signal)
      .then(s => {
        setPrSummary(s);
        setPrSummaryLoading(false);
      })
      .catch(e => {
        if (!(e instanceof ApiError && e.isAbort)) {
          const msg = errMessage(e);
          setPrSummaryError(msg);
          setPrSummaryLoading(false);
          console.warn('PR summary failed:', msg);
        }
      });
    return () => ctrl.abort();
  }, [api, booting, filters.selectedProject, refreshToken]);

  useEffect(() => {
    if (booting) return;
    setPipelineSummaryLoading(true);
    setPipelineSummaryError(null);
    const ctrl = new AbortController();
    api
      .pipelinesSummary(30, filters.selectedProject, ctrl.signal)
      .then(s => {
        setPipelineSummary(s);
        setPipelineSummaryLoading(false);
      })
      .catch(e => {
        if (!(e instanceof ApiError && e.isAbort)) {
          const msg = errMessage(e);
          setPipelineSummaryError(msg);
          setPipelineSummaryLoading(false);
          console.warn('Pipeline summary failed:', msg);
        }
      });
    return () => ctrl.abort();
  }, [api, booting, filters.selectedProject, refreshToken]);

  useEffect(() => {
    if (booting) return;
    setDeploymentSummaryLoading(true);
    setDeploymentSummaryError(null);
    const ctrl = new AbortController();
    api
      .deploymentsSummary(30, filters.selectedProject, ctrl.signal)
      .then(s => {
        setDeploymentSummary(s);
        setDeploymentSummaryLoading(false);
      })
      .catch(e => {
        if (!(e instanceof ApiError && e.isAbort)) {
          const msg = errMessage(e);
          setDeploymentSummaryError(msg);
          setDeploymentSummaryLoading(false);
          console.warn('Deployment summary failed:', msg);
        }
      });
    return () => ctrl.abort();
  }, [api, booting, filters.selectedProject, refreshToken]);

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
    const base = summary?.projects ?? [];
    const known = new Set(base.map(p => p.name));
    const extra = orgProjects.filter(n => !known.has(n)).map(name => ({ name, total: 0 }));
    return [...base, ...extra].sort((a, b) => a.name.localeCompare(b.name));
  }, [summary, orgProjects]);

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

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
