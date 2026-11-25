import { useEffect, useState } from 'react';

export const CACHE_JOB_POLL_MS = 2000;

export type CacheJobState = 'idle' | 'running' | 'done' | 'partial' | 'failed' | 'deferred';

/** Background chunk job state attached to cache-first calendar responses. */
export interface CacheJob {
  state: CacheJobState;
  pending: number;
  completed: number;
  partial: number;
  failed: number;
  deferred: number;
  /** Chunks refused because the background queue was full. */
  busy: number;
  retryAfterSeconds: number;
}

/** Number of calendar chunks per coverage state. */
export interface CacheCoverage {
  complete: number;
  partial: number;
  missing: number;
}

export interface CacheJobResponse {
  job?: Partial<CacheJob> & { state: CacheJobState };
  cacheStatus?: { coverage?: CacheCoverage } | null;
}

export interface UseCacheJobOptions<T> {
  /** Identity of the request; a changed key aborts the previous request and discards its response. */
  requestKey: string;
  fetch: (signal: AbortSignal) => Promise<T>;
  /** False for rolling ranges and demo mode: the request is issued once and never polled. */
  poll?: boolean;
  enabled?: boolean;
  /** Keep showing the previous key's data while the new key loads (never applied to a newer key's data). */
  keepPrevious?: boolean;
}

export interface UseCacheJobResult<T> {
  data: T | null;
  job: CacheJob | null;
  coverage: CacheCoverage | null;
  loading: boolean;
  error: string | null;
}

interface Snapshot<T> {
  key: string;
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function normalizeJob(raw: CacheJobResponse['job']): CacheJob | null {
  if (!raw) return null;
  return {
    state: raw.state,
    pending: raw.pending ?? 0,
    completed: raw.completed ?? 0,
    partial: raw.partial ?? 0,
    failed: raw.failed ?? 0,
    deferred: raw.deferred ?? 0,
    busy: raw.busy ?? 0,
    retryAfterSeconds: raw.retryAfterSeconds ?? 0,
  };
}

/**
 * Cache-first request with job polling. While the backend reports job.state === 'running' the same request is
 * re-issued every 2 s; done, partial, failed, deferred and idle stop polling (deferred never polls faster:
 * the wait is shown instead). The last good data stays visible while polling or after a failed poll, and a
 * response whose key is no longer the latest is dropped. Polling stops on key change and on unmount.
 */
export function useCacheJob<T extends CacheJobResponse>({ requestKey, fetch, poll = true, enabled = true, keepPrevious = false }: UseCacheJobOptions<T>): UseCacheJobResult<T> {
  const [snapshot, setSnapshot] = useState<Snapshot<T> | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = () => {
      fetch(controller.signal)
        .then(data => {
          if (cancelled) return;
          setSnapshot({ key: requestKey, data, error: null, loading: false });
          if (poll && data.job?.state === 'running') timer = setTimeout(load, CACHE_JOB_POLL_MS);
        })
        .catch((e: unknown) => {
          const err = e as { name?: string; isAbort?: boolean; message?: string } | null;
          if (cancelled || controller.signal.aborted || err?.name === 'AbortError' || err?.isAbort) return;
          setSnapshot(previous => ({
            key: requestKey,
            data: previous && (keepPrevious || previous.key === requestKey) ? previous.data : null,
            error: err?.message || 'Request failed',
            loading: false,
          }));
        });
    };

    setSnapshot(previous => ({ key: requestKey, data: previous && (keepPrevious || previous.key === requestKey) ? previous.data : null, error: null, loading: true }));
    load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // requestKey encodes every input the fetch reads; the fetch identity is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled, poll, keepPrevious]);

  const current = snapshot && snapshot.key === requestKey ? snapshot : null;
  const shown = current ?? (keepPrevious ? snapshot : null);
  return {
    data: shown?.data ?? null,
    job: normalizeJob(shown?.data?.job),
    coverage: shown?.data?.cacheStatus?.coverage ?? null,
    loading: enabled && (current ? current.loading : true),
    error: current?.error ?? null,
  };
}

const STATE_PRIORITY: CacheJobState[] = ['running', 'deferred', 'failed', 'partial', 'done', 'idle'];

/** Combines the job of two requests that back one screen (summary plus list): the most active state wins. */
export function mergeCacheJobs(a: CacheJobResponse['job'], b: CacheJobResponse['job']): CacheJobResponse['job'] {
  if (!a || !b) return a ?? b;
  const state = STATE_PRIORITY.find(s => s === a.state || s === b.state) ?? 'idle';
  return {
    state,
    pending: (a.pending ?? 0) + (b.pending ?? 0),
    completed: (a.completed ?? 0) + (b.completed ?? 0),
    partial: (a.partial ?? 0) + (b.partial ?? 0),
    failed: (a.failed ?? 0) + (b.failed ?? 0),
    deferred: (a.deferred ?? 0) + (b.deferred ?? 0),
    busy: Math.max(a.busy ?? 0, b.busy ?? 0),
    retryAfterSeconds: Math.max(a.retryAfterSeconds ?? 0, b.retryAfterSeconds ?? 0),
  };
}

export type CacheNoticeKey = 'running' | 'partial' | 'missing';

/** Picks the coverage notice: text only, nothing when the range is fully collected. */
export function coverageNoticeKey(job: CacheJob | null, coverage: CacheCoverage | null): CacheNoticeKey | null {
  if (job?.state === 'running') return 'running';
  if (!coverage) return null;
  if (coverage.partial > 0) return 'partial';
  if (coverage.missing > 0) return 'missing';
  return null;
}
