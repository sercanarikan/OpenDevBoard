// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_JOB_POLL_MS, useCacheJob, type CacheJobResponse, type UseCacheJobResult } from './useCacheJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Resp = CacheJobResponse & { marker: number };
const job = (state: string, extra: Record<string, unknown> = {}) => ({ state, pending: 0, completed: 0, partial: 0, failed: 0, deferred: 0, busy: 0, retryAfterSeconds: 0, ...extra });
const resp = (marker: number, state: string, extra: Record<string, unknown> = {}): Resp => ({
  marker,
  job: job(state, extra) as Resp['job'],
  cacheStatus: { coverage: { complete: 1, partial: 0, missing: 1 } },
});

function Probe(props: { requestKey: string; fetch: (s: AbortSignal) => Promise<Resp>; poll?: boolean; enabled?: boolean; onResult: (r: UseCacheJobResult<Resp>) => void }) {
  const { onResult, requestKey, fetch, poll, enabled } = props;
  onResult(useCacheJob<Resp>({ requestKey, fetch, poll, enabled }));
  return null;
}

describe('useCacheJob', () => {
  let root: Root;
  let container: HTMLDivElement;
  let latest: UseCacheJobResult<Resp> | null = null;
  const render = async (props: Omit<Parameters<typeof Probe>[0], 'onResult'>) => {
    await act(async () => { root.render(<Probe {...props} onResult={r => { latest = r; }} />); });
  };
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  beforeEach(() => {
    vi.useFakeTimers();
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('polls every 2000 ms while running and stops when done', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(resp(1, 'running', { pending: 1 }))
      .mockResolvedValueOnce(resp(2, 'running', { pending: 1 }))
      .mockResolvedValue(resp(3, 'done'));
    await render({ requestKey: 'a', fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(latest?.data?.marker).toBe(1);
    expect(latest?.coverage).toEqual({ complete: 1, partial: 0, missing: 1 });
    await tick(CACHE_JOB_POLL_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(latest?.data?.marker).toBe(2);
    await tick(CACHE_JOB_POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(latest?.job?.state).toBe('done');
    await tick(CACHE_JOB_POLL_MS * 5);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['partial', 'failed', 'idle'])('does not poll on %s', async state => {
    const fetch = vi.fn().mockResolvedValue(resp(1, state));
    await render({ requestKey: 'a', fetch });
    await tick(CACHE_JOB_POLL_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good data visible while polling and when a poll fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(resp(1, 'running', { pending: 1 }))
      .mockRejectedValueOnce(new Error('boom'));
    await render({ requestKey: 'a', fetch });
    await tick(CACHE_JOB_POLL_MS);
    expect(latest?.data?.marker).toBe(1);
    expect(latest?.error).toBe('boom');
  });

  it('drops a response for a key that is no longer the latest', async () => {
    const resolvers: Record<string, (r: Resp) => void> = {};
    const fetch = vi.fn((_s: AbortSignal) => new Promise<Resp>(resolve => { resolvers[`c${fetch.mock.calls.length}`] = resolve; }));
    await render({ requestKey: 'a', fetch });
    await render({ requestKey: 'b', fetch });
    await act(async () => { resolvers.c2(resp(2, 'done')); });
    await act(async () => { resolvers.c1(resp(1, 'done')); });
    expect(latest?.data?.marker).toBe(2);
    expect(fetch.mock.calls[0][0].aborted).toBe(true);
  });

  it('stops polling on unmount', async () => {
    const fetch = vi.fn().mockResolvedValue(resp(1, 'running', { pending: 1 }));
    await render({ requestKey: 'a', fetch });
    await act(async () => root.unmount());
    root = createRoot(container);
    await tick(CACHE_JOB_POLL_MS * 4);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not poll faster than 2 s when deferred, and does not report an error', async () => {
    const fetch = vi.fn().mockResolvedValue(resp(1, 'deferred', { deferred: 1, retryAfterSeconds: 1 }));
    await render({ requestKey: 'a', fetch });
    await tick(CACHE_JOB_POLL_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(latest?.job?.retryAfterSeconds).toBe(1);
    expect(latest?.error).toBeNull();
  });

  it('does not poll when poll is false (rolling range)', async () => {
    const fetch = vi.fn().mockResolvedValue(resp(1, 'running', { pending: 1 }));
    await render({ requestKey: 'a', fetch, poll: false });
    await tick(CACHE_JOB_POLL_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
