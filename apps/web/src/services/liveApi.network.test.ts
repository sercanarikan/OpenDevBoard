import { describe, it, expect, vi, afterEach } from 'vitest';
import { getJson, hasRecentResponse, historyQuery, isTimeoutError, liveApi, onNetworkEvent, postSync, probeBackend, pullRequestSnapshotParams } from './liveApi';
import { ApiError } from '../types/paging';

const events: { ok: boolean; error?: ApiError }[] = [];
let off: (() => void) | null = null;

function listen() {
  events.length = 0;
  off?.();
  off = onNetworkEvent(e => events.push(e));
}

afterEach(() => {
  off?.();
  off = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('backend reachability probe', () => {
  const answer = (status = 200) => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status }));

  it('allows team activity summaries the same budget as the other dashboard summaries', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const result = expect(liveApi.teamActivitySummary(7, 'all')).rejects.toMatchObject({ message: 'timeout' });
    await vi.advanceTimersByTimeAsync(49999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
  });

  it('treats a recent HTTP answer as proof of reachability only when asked to for a client timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.stubGlobal('fetch', answer());
    await getJson('/work-items/summary');
    expect(hasRecentResponse()).toBe(true);

    // The health probe would hang behind busy browser connections; the recent answer makes it unnecessary.
    const health = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', health);
    await expect(probeBackend(true)).resolves.toBe(true);
    expect(health).not.toHaveBeenCalled();

    // Without the opt-in (refused connection, gateway error) the probe always asks the backend.
    const probe = probeBackend(false);
    const settled = vi.fn();
    void probe.then(settled);
    await vi.advanceTimersByTimeAsync(4999);
    expect(health).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(probe).resolves.toBe(false);
  });

  it('does not trust an old answer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.stubGlobal('fetch', answer());
    await getJson('/work-items/summary');
    vi.setSystemTime(new Date('2026-01-01T00:00:16Z'));
    expect(hasRecentResponse()).toBe(false);
    const health = answer(503);
    vi.stubGlobal('fetch', health);
    await expect(probeBackend(true)).resolves.toBe(false);
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('counts a 4xx/5xx answer as reachable but a gateway error as unreachable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })));
    await expect(getJson('/x')).rejects.toBeInstanceOf(ApiError);
    expect(hasRecentResponse()).toBe(true);

    vi.setSystemTime(new Date('2026-02-01T01:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad gateway' }), { status: 504 })));
    await expect(getJson('/x')).rejects.toBeInstanceOf(ApiError);
    expect(hasRecentResponse()).toBe(false);
  });

  it('recognises only client-side timeouts', () => {
    expect(isTimeoutError(new ApiError('timeout', 0, { isNetwork: true }))).toBe(true);
    expect(isTimeoutError(new ApiError('Failed to fetch', 0, { isNetwork: true }))).toBe(false);
    expect(isTimeoutError(new ApiError('HTTP 504', 504))).toBe(false);
    expect(isTimeoutError(new Error('timeout'))).toBe(false);
  });
});

describe('getJson network reporting', () => {
  it('keeps backend reachability true for a cold-cache loading response', async () => {
    listen();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Pull requests are loading',
      cacheStatus: { outcome: 'loading', hasSnapshot: false, refreshing: true }
    }), { status: 503, headers: { 'Retry-After': '2' } })));

    await expect(getJson('/pull-requests/summary')).rejects.toMatchObject({ isLoading: true });
    expect(events).toEqual([{ ok: true }]);
  });

  it('keeps real gateway failures offline and normal HTTP errors reachable', async () => {
    listen();
    for (const status of [502, 503, 504]) {
      events.length = 0;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unavailable' }), { status })));
      await expect(getJson('/pull-requests/summary')).rejects.toMatchObject({ status, isLoading: false });
      expect(events).toEqual([{ ok: false, error: expect.any(ApiError) }]);
    }

    events.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 })));
    await expect(getJson('/pull-requests/summary')).rejects.toMatchObject({ status: 400 });
    expect(events).toEqual([{ ok: true }]);
  });

  it('emits a reachable network event for successful JSON responses', async () => {
    listen();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(getJson('/pull-requests/summary')).resolves.toEqual({ ok: true });
    expect(events).toEqual([{ ok: true }]);
  });

  it('retries a bounded cold-cache loading response until the PR snapshot is ready', async () => {
    vi.useFakeTimers();
    const loading = () => new Response(JSON.stringify({
      error: 'Pull requests are loading',
      cacheStatus: { outcome: 'loading', refreshing: true, hasSnapshot: false }
    }), { status: 503, headers: { 'Retry-After': '2' } });
    const ready = new Response(JSON.stringify({
      needsMyReview: 3, createdByMe: 1, involved: 4, totalActive: 5,
      reviewerIdentityStatus: { groupMembership: 'available', refreshing: false }
    }), { status: 200 });
    const fetchMock = vi.fn().mockImplementationOnce(loading).mockImplementationOnce(loading).mockResolvedValueOnce(ready);
    vi.stubGlobal('fetch', fetchMock);

    const request = liveApi.pullRequestsSummary();
    const result = expect(request).resolves.toMatchObject({ needsMyReview: 3 });
    await vi.advanceTimersByTimeAsync(4000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops polling cold PR loading after the bounded wait without reporting a network timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Pull requests are loading',
      cacheStatus: { outcome: 'loading', refreshing: true, hasSnapshot: false }
    }), { status: 503, headers: { 'Retry-After': '2' } })));
    const request = liveApi.pullRequestsSummary();
    const result = expect(request).rejects.toMatchObject({ isLoading: true, message: 'pullRequestsLoading' });
    await vi.advanceTimersByTimeAsync(9000);
    await result;
  });

  it('allows deployment summaries more than 20 seconds and still times out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const request = liveApi.deploymentsSummary();
    const result = expect(request).rejects.toMatchObject({ message: 'timeout' });
    await vi.advanceTimersByTimeAsync(20000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30000);
    await result;
  });
  it('returns the fixture sync result so the UI can refresh the fixture status', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'success', fixture: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postSync('full')).resolves.toEqual({ status: 'success', fixture: true });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/sync'), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ mode: 'full' })
    }));
  });

  it('serializes the same project and date scope for history summary and timeline', () => {
    const timeline = historyQuery({ project: 'alms', days: 7, limit: 25, offset: 0 });
    const summary = new URLSearchParams({ days: '7', project: 'alms' });
    expect(timeline.get('project')).toBe(summary.get('project'));
    expect(timeline.get('days')).toBe(summary.get('days'));
  });

  it('builds a forced refresh request for PR snapshots after manual sync', () => {
    expect(pullRequestSnapshotParams('Alpha')).toEqual({
      project: 'Alpha',
      status: 'all',
      quickFilter: 'all',
      limit: 1,
      offset: 0,
      refresh: true
    });
  });

  it('sends the forced PR refresh through the live API query', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await liveApi.pullRequests(pullRequestSnapshotParams('Alpha'));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/pull-requests?');
    expect(url).toContain('refresh=true');
    expect(url).toContain('project=Alpha');
  });

  it('forwards history type and search filters to summary without pagination', async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ totalEvents: 0 }), { status: 200 });
    }) as typeof fetch;
    try {
      await liveApi.myHistorySummary(30, 'alms', undefined, { activityType: 'review', search: 'approve' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls[0]).toContain('project=alms');
    expect(urls[0]).toContain('days=30');
    expect(urls[0]).toContain('activityType=review');
    expect(urls[0]).toContain('search=approve');
    expect(urls[0]).not.toContain('limit=');
    expect(urls[0]).not.toContain('offset=');
  });
  it('reports success after a good response', async () => {
    listen();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ a: 1 }), { status: 200 })));
    await expect(getJson('/x')).resolves.toEqual({ a: 1 });
    expect(events).toEqual([{ ok: true }]);
  });

  it('reports a network failure immediately (backend unreachable)', async () => {
    listen();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(getJson('/x')).rejects.toMatchObject({ isNetwork: true });
    expect(events).toHaveLength(1);
    expect(events[0].ok).toBe(false);
  });

  it('treats gateway errors (nginx cannot reach the api) as unreachable', async () => {
    listen();
    for (const status of [502, 503, 504]) {
      events.length = 0;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad gateway' }), { status })));
      await expect(getJson('/x')).rejects.toBeInstanceOf(ApiError);
      expect(events[0].ok).toBe(false);
    }
  });

  it('does NOT flag the backend as lost for an application error (400 / 404 / 500)', async () => {
    listen();
    for (const status of [400, 404, 500]) {
      events.length = 0;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status })));
      await expect(getJson('/x')).rejects.toMatchObject({ status });
      expect(events).toEqual([{ ok: true }]);
    }
  });

  it('does not report a superseded (aborted) request as a failure', async () => {
    listen();
    const ctrl = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const p = getJson('/x', undefined, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ isAbort: true });
    expect(events).toEqual([]);
  });
});

describe('backend health probe', () => {
  it('confirms backend availability independently of a failed card request', async () => {
    const { probeBackend } = await import('./liveApi');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(probeBackend()).resolves.toBe(true);
  });

  it('reports a refused connection or proxy failure as unavailable', async () => {
    const { probeBackend } = await import('./liveApi');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(probeBackend()).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    await expect(probeBackend()).resolves.toBe(false);
  });
});
