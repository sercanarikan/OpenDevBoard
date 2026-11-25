import type { WorkItem, WorkItemsPoolResponse } from '../types';
import { applyRangeParams, rangeParams, type AnalyticsRange } from './dateRange';
import { adaptLiveWorkItemsPool } from './dataAdapter';
import { activityQuery, type ActivityDailyParams, type ActivityDailyResponse } from './activityDaily';
import { buildGraphItems, buildProgressHierarchy, type ContextItem } from '../utils/contextHierarchy';
import {
  ApiError,
  type BatchResponse,
  type CanonicalProgress,
  type ChildrenResponse,
  type KanbanParams,
  type KanbanResponse,
  type ListParams,
  type ListResponse,
  type MeResponse,
  type SummaryResponse,
  type SyncReportResponse,
  type WorkItemsApi,
  type PullRequest,
  type PullRequestParams,
  type PullRequestsResponse,
  type PullRequestsSummary,
  type PipelineRun,
  type PipelineParams,
  type PipelineRunsResponse,
  type PipelineSummary,
  type DeploymentRecord,
  type DeploymentParams,
  type DeploymentsResponse,
  type DeploymentSummary,
  type TeamActivityParams,
  type TeamActivitySummary,
  type TeamContributorsResponse,
  type TeamCommitsResponse,
  type HistorySummary,
  type HistoryTimelineResponse,
  type HistoryParams
} from '../types/paging';

const API_BASE: string = import.meta.env?.VITE_API_BASE_URL || '/api';
const DEFAULT_TIMEOUT_MS = 20000;
const PR_LOADING_MAX_WAIT_MS = 8000;

function buildUrl(path: string, query?: URLSearchParams): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const url = new URL(`${API_BASE}${path}`, origin);
  if (query) query.forEach((v, k) => url.searchParams.append(k, v));
  return url.toString();
}

/** Any HTTP answer (even a 4xx/5xx other than a gateway error) is proof that the backend is reachable. */
let lastResponseAt = 0;
const RECENT_RESPONSE_MS = 15000;

export function hasRecentResponse(now = Date.now()): boolean {
  return now - lastResponseAt < RECENT_RESPONSE_MS;
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof ApiError && error.isNetwork && error.message === 'timeout';
}

/**
 * Check the backend separately from requests that can fail or time out upstream.
 *
 * `trustRecentResponse` is for a client-side timeout only: the browser allows six HTTP/1.1 connections per origin,
 * so while slow summary requests hold them this probe can queue past its own timeout although the backend answers.
 * A response received moments ago proves reachability; refused connections and gateway errors never use the shortcut.
 */
export async function probeBackend(trustRecentResponse = false): Promise<boolean> {
  if (trustRecentResponse && hasRecentResponse()) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(buildUrl('/health'), { signal: controller.signal, cache: 'no-store' });
    return response.status !== 502 && response.status !== 503 && response.status !== 504;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type NetworkListener = (event: { ok: boolean; error?: ApiError }) => void;
const networkListeners = new Set<NetworkListener>();

/**
 * Lets the app react to the outcome of ANY request right away (instead of waiting for the next poll):
 * a network failure marks the backend as unreachable, the next success clears it.
 */
export function onNetworkEvent(listener: NetworkListener): () => void {
  networkListeners.add(listener);
  return () => networkListeners.delete(listener);
}

function emitNetwork(event: { ok: boolean; error?: ApiError }) {
  networkListeners.forEach(l => l(event));
}

/** GET + JSON with a timeout that composes with the caller's AbortSignal (a superseded request aborts cleanly). */
/**
 * `reportNetwork: false` keeps a secondary request out of the global connection status: its timeouts and
 * successes neither mark the backend unreachable nor refresh the recent-response shortcut.
 */
export async function getJson<T>(
  path: string,
  query?: URLSearchParams,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { reportNetwork?: boolean } = {}
): Promise<T> {
  const reportNetwork = options.reportNetwork !== false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) controller.abort();

  try {
    const res = await fetch(buildUrl(path, query), {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let payload: any;
      try {
        payload = await res.json();
        if (payload && typeof payload.error === 'string') message = payload.error;
      } catch {
        /* non-JSON error body */
      }
      const isLoading = payload?.cacheStatus?.outcome === 'loading';
      const retryAfterSeconds = Number(res.headers.get('Retry-After'));
      throw new ApiError(isLoading ? 'pullRequestsLoading' : message, res.status, {
        isLoading,
        payload,
        retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined
      });
    }
    const body = (await res.json()) as T;
    if (reportNetwork) {
      lastResponseAt = Date.now();
      emitNetwork({ ok: true });
    }
    return body;
  } catch (err: any) {
    if (err instanceof ApiError) {
      if (!reportNetwork) throw err;
      // A cold PR snapshot is an intentional loading response; a 503 otherwise still means the backend is unavailable.
      if (err.isLoading) {
        lastResponseAt = Date.now();
        emitNetwork({ ok: true });
      } else if (err.status === 502 || err.status === 503 || err.status === 504) emitNetwork({ ok: false, error: err });
      else {
        lastResponseAt = Date.now();
        emitNetwork({ ok: true });
      }
      throw err;
    }
    if (signal?.aborted) throw new ApiError('aborted', 0, { isAbort: true });
    const apiErr =
      err?.name === 'AbortError'
        ? new ApiError('timeout', 0, { isNetwork: true })
        : new ApiError(err?.message || 'network error', 0, { isNetwork: true });
    if (reportNetwork) emitNetwork({ ok: false, error: apiErr });
    throw apiErr;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function waitForPrRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ApiError('aborted', 0, { isAbort: true }));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiError('aborted', 0, { isAbort: true }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function getPullRequestsJson<T extends { reviewerIdentityStatus?: { refreshing?: boolean } }>(
  path: string, query?: URLSearchParams, signal?: AbortSignal
): Promise<T> {
  const deadline = Date.now() + PR_LOADING_MAX_WAIT_MS;
  let lastIdentityPending: T | null = null;
  while (true) {
    if (signal?.aborted) throw new ApiError('aborted', 0, { isAbort: true });
    try {
      const body = await getJson<T>(path, query, signal);
      if (!body.reviewerIdentityStatus?.refreshing) return body;
      lastIdentityPending = body;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return lastIdentityPending;
      await waitForPrRetry(Math.min(1000, remaining), signal);
    } catch (error) {
      if (!(error instanceof ApiError) || !error.isLoading) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      const delayMs = Math.min(error.retryAfterMs ?? 1000, remaining);
      await waitForPrRetry(delayMs, signal);
      if (Date.now() >= deadline) throw error;
    }
  }
}

export function listQuery(p: ListParams): URLSearchParams {
  const q = new URLSearchParams();
  if (p.limit !== undefined) q.set('limit', String(p.limit));
  if (p.offset !== undefined) q.set('offset', String(p.offset));
  if (p.search && p.search.trim()) q.set('search', p.search.trim());
  if (p.project && p.project !== 'all') q.set('project', p.project);
  for (const a of p.assignee || []) q.append('assignee', a);
  if (p.quickFilter && p.quickFilter !== 'all') q.set('quickFilter', p.quickFilter);
  if (p.currentUser) q.set('currentUser', p.currentUser);
  if (p.types?.length) q.set('type', p.types.join(','));
  if (p.states?.length) q.set('state', p.states.join(','));
  if (p.priorities?.length) q.set('priority', p.priorities.join(','));
  if (p.column) q.set('column', p.column);
  if (p.lane) q.set('lane', p.lane);
  if (p.includeCompleted) q.set('includeCompleted', 'true');
  if (p.sortBy) q.set('sortBy', p.sortBy);
  if (p.sortOrder) q.set('sortOrder', p.sortOrder);
  return q;
}

export function kanbanQuery(p: KanbanParams): URLSearchParams {
  const q = listQuery({ ...p, limit: undefined, offset: undefined });
  if (p.swimlane) q.set('swimlane', p.swimlane);
  if (p.laneLimit !== undefined) q.set('laneLimit', String(p.laneLimit));
  if (p.laneOffset !== undefined) q.set('laneOffset', String(p.laneOffset));
  if (p.cardLimit !== undefined) q.set('cardLimit', String(p.cardLimit));
  if (p.hideCompleted) q.set('hideCompleted', 'true');
  return q;
}

export function prQuery(p: PullRequestParams): URLSearchParams {
  const q = new URLSearchParams();
  if (p.limit !== undefined) q.set('limit', String(p.limit));
  if (p.offset !== undefined) q.set('offset', String(p.offset));
  if (p.search && p.search.trim()) q.set('search', p.search.trim());
  if (p.project && p.project !== 'all') q.set('project', p.project);
  if (p.repository) q.set('repository', p.repository);
  if (p.status && p.status !== 'all') q.set('status', p.status);
  if (p.quickFilter && p.quickFilter !== 'all') q.set('quickFilter', p.quickFilter);
  if (p.sortBy) q.set('sortBy', p.sortBy);
  if (p.sortOrder) q.set('sortOrder', p.sortOrder);
  if (p.refresh) q.set('refresh', 'true');
  return q;
}

export function pullRequestSnapshotParams(project?: string): PullRequestParams {
  return { project, status: 'all', quickFilter: 'all', limit: 1, offset: 0, refresh: true };
}

export function pipelineQuery(p: PipelineParams): URLSearchParams {
  const q = new URLSearchParams();
  if (p.limit !== undefined) q.set('limit', String(p.limit));
  if (p.offset !== undefined) q.set('offset', String(p.offset));
  if (p.search && p.search.trim()) q.set('search', p.search.trim());
  if (p.project && p.project !== 'all') q.set('project', p.project);
  if (p.status && p.status !== 'all') q.set('status', p.status);
  if (p.result && p.result !== 'all') q.set('result', p.result);
  if (p.branch && p.branch !== 'all') q.set('branch', p.branch);
  applyRangeParams(q, p);
  if (p.refresh) q.set('refresh', 'true');
  return q;
}

export function deploymentQuery(p: DeploymentParams): URLSearchParams {
  const q = new URLSearchParams();
  if (p.limit !== undefined) q.set('limit', String(p.limit));
  if (p.offset !== undefined) q.set('offset', String(p.offset));
  if (p.search && p.search.trim()) q.set('search', p.search.trim());
  if (p.project && p.project !== 'all') q.set('project', p.project);
  if (p.environment && p.environment !== 'all') q.set('environment', p.environment);
  if (p.status && p.status !== 'all') q.set('status', p.status);
  applyRangeParams(q, p);
  if (p.refresh) q.set('refresh', 'true');
  return q;
}

export function teamQuery(p: TeamActivityParams): URLSearchParams {
  const q = new URLSearchParams();
  if (p.limit !== undefined) q.set('limit', String(p.limit));
  if (p.offset !== undefined) q.set('offset', String(p.offset));
  if (p.search && p.search.trim()) q.set('search', p.search.trim());
  if (p.project && p.project !== 'all') q.set('project', p.project);
  if (p.repository && p.repository !== 'all') q.set('repository', p.repository);
  if (p.contributor && p.contributor !== 'all') q.set('contributor', p.contributor);
  applyRangeParams(q, p);
  if (p.sortBy) q.set('sortBy', p.sortBy);
  if (p.sortOrder) q.set('sortOrder', p.sortOrder);
  if (p.refresh) q.set('refresh', 'true');
  return q;
}

export function historyQuery(p: HistoryParams): URLSearchParams {
  const q = new URLSearchParams();
  if (p.limit !== undefined) q.set('limit', String(p.limit));
  if (p.offset !== undefined) q.set('offset', String(p.offset));
  if (p.search && p.search.trim()) q.set('search', p.search.trim());
  if (p.project && p.project !== 'all') q.set('project', p.project);
  if (p.activityType && p.activityType !== 'all') q.set('activityType', p.activityType);
  applyRangeParams(q, p);
  if (p.refresh) q.set('refresh', 'true');
  return q;
}

/** Full active scope + context rows for Story & Tasks / Dependency Explorer. Never falls back to demo data. */
export async function fetchPool(signal?: AbortSignal): Promise<WorkItemsPoolResponse> {
  const raw = await getJson<{ context_items?: ContextItem[] }>('/work-items-pool', undefined, signal);
  const pool = adaptLiveWorkItemsPool(raw, 'https://dev.azure.com');
  // Canonical progress is computed over the COMPLETE hierarchy (completed descendants + ancestors), while the
  // screens keep showing only active work.
  pool.progressHierarchy = buildProgressHierarchy(pool.flat_items, raw.context_items || []);
  pool.graphItems = buildGraphItems(pool.flat_items, raw.context_items || []);
  return pool;
}

/** Org project names (live only). Failures are not fatal: the selector falls back to projects with active items. */
export async function fetchOrgProjects(): Promise<string[]> {
  try {
    const res = await getJson<{ projects: { name: string }[] }>('/projects');
    return (res.projects || []).map(p => p.name).filter(Boolean);
  } catch {
    return [];
  }
}

export function fetchSyncReport(signal?: AbortSignal): Promise<SyncReportResponse> {
  return getJson<SyncReportResponse>('/sync-status', undefined, signal);
}

/** Starts a backend sync (the backend only reads from Azure DevOps). Never throws: failures show up in the report. */
export async function postSync(mode: 'incremental' | 'full'): Promise<{ status: string; fixture?: boolean; error?: string }> {
  try {
    const res = await fetch(buildUrl('/sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ mode })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { status: 'error', error: typeof body.error === 'string' ? body.error : undefined };
    }
    return (await res.json()) as { status: string; fixture?: boolean; error?: string };
  } catch {
    return { status: 'error' };
  }
}

export const liveApi: WorkItemsApi = {
  mode: 'live',

  me: signal => getJson<MeResponse>('/me', undefined, signal),

  summary(project, currentUser, signal) {
    const q = new URLSearchParams();
    if (project && project !== 'all') q.set('project', project);
    if (currentUser) q.set('currentUser', currentUser);
    return getJson<SummaryResponse>('/work-items/summary', q, signal);
  },

  list: (params, signal) => getJson<ListResponse>('/work-items', listQuery(params), signal),

  kanban: (params, signal) => getJson<KanbanResponse>('/kanban', kanbanQuery(params), signal),

  async progress(ids, signal) {
    if (ids.length === 0) return {};
    const out: Record<number, CanonicalProgress> = {};
    for (let i = 0; i < ids.length; i += 500) {
      const q = new URLSearchParams({ ids: ids.slice(i, i + 500).join(',') });
      const res = await getJson<{ progress: Record<string, CanonicalProgress> }>('/work-items/progress', q, signal);
      for (const [k, v] of Object.entries(res.progress || {})) out[Number(k)] = v;
    }
    return out;
  },

  children: (id, signal) => getJson<ChildrenResponse>(`/work-items/${id}/children`, undefined, signal),

  async batch(ids, signal) {
    const unique = Array.from(new Set(ids));
    const merged: BatchResponse = { items: [], missing: [], dataVersion: '' };
    for (let i = 0; i < unique.length; i += 100) {
      const q = new URLSearchParams({ ids: unique.slice(i, i + 100).join(',') });
      const res = await getJson<BatchResponse>('/work-items/batch', q, signal);
      merged.items.push(...res.items);
      merged.missing.push(...res.missing);
      merged.dataVersion = res.dataVersion;
    }
    return merged;
  },

  async item(id, signal) {
    try {
      return await getJson<WorkItem>(`/work-items/${id}`, undefined, signal);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  pullRequests: (params, signal) => getPullRequestsJson<PullRequestsResponse>('/pull-requests', prQuery(params), signal),

  pullRequestsSummary: (project, signal) => {
    const q = new URLSearchParams();
    if (project && project !== 'all') q.set('project', project);
    return getPullRequestsJson<PullRequestsSummary>('/pull-requests/summary', q, signal);
  },

  async pullRequest(id, signal) {
    try {
      return await getJson<PullRequest>(`/pull-requests/${id}`, undefined, signal);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  pipelines: (params, signal) => getJson<PipelineRunsResponse>('/pipelines/runs', pipelineQuery(params), signal),

  pipelinesSummary: (range: AnalyticsRange = 30, project, signal) => {
    const q = rangeParams(range);
    if (project && project !== 'all') q.set('project', project);
    return getJson<PipelineSummary>('/pipelines/summary', q, signal, 50000);
  },

  async pipelineRun(id, project, signal) {
    try {
      const q = project && project !== 'all' ? new URLSearchParams({ project }) : undefined;
      return await getJson<PipelineRun>(`/pipelines/runs/${id}`, q, signal);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  deployments: (params, signal) => getJson<DeploymentsResponse>('/deployments', deploymentQuery(params), signal),

  deploymentsSummary: (range: AnalyticsRange = 30, project, signal) => {
    const q = rangeParams(range);
    if (project && project !== 'all') q.set('project', project);
    return getJson<DeploymentSummary>('/deployments/summary', q, signal, 50000);
  },

  async deployment(id, project, signal) {
    try {
      const q = project && project !== 'all' ? new URLSearchParams({ project }) : undefined;
      return await getJson<DeploymentRecord>(`/deployments/${id}`, q, signal);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  teamActivitySummary: (range: AnalyticsRange = 30, project, signal) => {
    const q = rangeParams(range);
    if (project && project !== 'all') q.set('project', project);
    return getJson<TeamActivitySummary>('/team-activity/summary', q, signal, 50000);
  },

  teamContributors: (params, signal) => getJson<TeamContributorsResponse>('/team-activity/contributors', teamQuery(params), signal),

  teamCommits: (params, signal) => getJson<TeamCommitsResponse>('/team-activity/commits', teamQuery(params), signal),

  myHistorySummary: (range: AnalyticsRange = 30, project = 'all', signal, filters = {}) => {
    const q = rangeParams(range);
    if (project && project !== 'all') q.set('project', project);
    if (filters.activityType && filters.activityType !== 'all') q.set('activityType', filters.activityType);
    if (filters.search?.trim()) q.set('search', filters.search.trim());
    return getJson<HistorySummary>('/my-history/summary', q, signal);
  },

  myHistoryTimeline: (params, signal) => getJson<HistoryTimelineResponse>('/my-history/timeline', historyQuery(params), signal)
};

/** Per-day activity counts with coverage states. `mode=cache` never starts upstream work. */
export function fetchActivityDaily(params: ActivityDailyParams, signal?: AbortSignal): Promise<ActivityDailyResponse> {
  return getJson<ActivityDailyResponse>('/activity/daily', activityQuery(params), signal, 30_000, { reportNetwork: false });
}
