import { describe, it, expect, vi, afterEach } from 'vitest';
import { getJson, historyQuery, liveApi, onNetworkEvent, postSync, pullRequestSnapshotParams } from './liveApi';
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

describe('getJson network reporting', () => {
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
