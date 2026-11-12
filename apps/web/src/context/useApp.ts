import { createContext, useContext } from 'react';
import type React from 'react';
import type { WorkItem, WorkItemsPoolResponse, ViewMode, FilterOptions } from '../types';
import type { SummaryResponse, SyncReportResponse, WorkItemsApi, PullRequest, PullRequestsSummary, PipelineSummary, PipelineRun, DeploymentSummary, DeploymentRecord } from '../types/paging';
import type { DataSourceKind, SyncIndicator } from '../utils/syncState';

export interface AppContextType {
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


export const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
