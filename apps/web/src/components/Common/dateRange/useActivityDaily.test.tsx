// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityDailyResponse } from '../../../services/activityDaily';
import { ACTIVITY_POLL_MS, useActivityDaily, type UseActivityDailyOptions, type UseActivityDailyResult } from './useActivityDaily';

const mockApp = vi.hoisted(() => ({ isDemo: false, filters: { selectedProject: 'all' } }));
const fetchActivityDaily = vi.hoisted(() => vi.fn());

vi.mock('../../../context/useApp', () => ({ useApp: () => mockApp }));
vi.mock('../../../services/liveApi', () => ({ fetchActivityDaily, isTimeoutError: () => false }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function response(state: 'running' | 'done', marker: number): ActivityDailyResponse {
  return {
    metric: 'pipelines',
    window: { kind: 'calendar', startDate: '2026-11-01', endDate: '2026-11-02', days: 2, timezone: 'UTC' },
    days: [{ date: '2026-11-01', count: marker, state: 'covered_active', stale: false }],
    job: { state, pending: state === 'running' ? 1 : 0, completed: 0, partial: 0, failed: 0 },
    cacheStatus: { complete: state === 'done', partialDays: 0, notCollectedDays: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function Probe(props: UseActivityDailyOptions & { onResult: (r: UseActivityDailyResult) => void }) {
  const { onResult, ...options } = props;
  onResult(useActivityDaily(options));
  return null;
}

describe('useActivityDaily', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let latest: UseActivityDailyResult | null = null;

  const render = async (options: UseActivityDailyOptions) => {
    await act(async () => {
      root!.render(<Probe {...options} onResult={r => { latest = r; }} />);
    });
  };

  beforeEach(() => {
    fetchActivityDaily.mockReset();
    mockApp.isDemo = false;
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const base: UseActivityDailyOptions = { metric: 'pipelines', startDate: '2026-11-01', endDate: '2026-11-02', mode: 'cache', enabled: true };

  it('makes no request while disabled', async () => {
    await render({ ...base, enabled: false });
    expect(fetchActivityDaily).not.toHaveBeenCalled();
  });

  it('returns the response for the current request', async () => {
    fetchActivityDaily.mockResolvedValue(response('done', 3));
    await render(base);
    expect(latest?.data?.days[0].count).toBe(3);
    expect(latest?.loading).toBe(false);
  });

  it('ignores a slow earlier response after the selection changed', async () => {
    const first = deferred<ActivityDailyResponse>();
    const second = deferred<ActivityDailyResponse>();
    fetchActivityDaily.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render(base);
    await render({ ...base, startDate: '2026-10-01', endDate: '2026-10-31' });
    await act(async () => second.resolve(response('done', 9)));
    await act(async () => first.resolve(response('done', 1)));
    expect(latest?.data?.days[0].count).toBe(9);
  });

  it('polls while the backend job is running and stops when done', async () => {
    vi.useFakeTimers();
    fetchActivityDaily
      .mockResolvedValueOnce(response('running', 1))
      .mockResolvedValueOnce(response('done', 2));
    await render({ ...base, mode: 'refresh' });
    expect(fetchActivityDaily).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MS); });
    expect(fetchActivityDaily).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MS * 3); });
    expect(fetchActivityDaily).toHaveBeenCalledTimes(2);
    expect(latest?.data?.days[0].count).toBe(2);
  });

  it('uses the deterministic fixture in demo mode without any request', async () => {
    mockApp.isDemo = true;
    await render(base);
    expect(fetchActivityDaily).not.toHaveBeenCalled();
    expect(latest?.data?.fixture).toBe(true);
  });

  it('aborts the in-flight request on unmount', async () => {
    let signal: AbortSignal | undefined;
    fetchActivityDaily.mockImplementation((_params: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise(() => undefined);
    });
    await render(base);
    await act(async () => root?.unmount());
    root = null;
    expect(signal?.aborted).toBe(true);
  });
});
