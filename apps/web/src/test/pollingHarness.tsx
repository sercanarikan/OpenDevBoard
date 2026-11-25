import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { DateRangeProvider } from '../context/DateRangeContext';
import { useDateRangeActions } from '../context/useDateRange';
import { customSelection, type DateRangeSelection } from '../services/dateRange';
import type { CacheCoverage, CacheJobState } from '../hooks/useCacheJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type Range = { days: number } | { startDate: string; endDate: string };

/** What a fake backend answers for one request: a marker shown by the screen, the job state and the coverage. */
export interface Reply { marker: string; state?: CacheJobState; coverage?: CacheCoverage }

export const MARCH = customSelection('2025-03-01', '2025-03-31');
export const APRIL = customSelection('2025-04-01', '2025-04-30');
export const ROLLING_KEY = 'days:30';

export function rangeKeyOf(range: Range): string {
  return 'startDate' in range ? `${range.startDate}:${range.endDate}` : `days:${range.days}`;
}

export function rangeOfParams(params: { days?: number; startDate?: string; endDate?: string }): Range {
  return params.startDate && params.endDate ? { startDate: params.startDate, endDate: params.endDate } : { days: params.days ?? 30 };
}

export function selectionKeyOf(selection: DateRangeSelection): string {
  return selection.kind === 'rolling' ? `days:${selection.days}` : `${selection.startDate}:${selection.endDate}`;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

type Step = Reply | Promise<Reply>;

/** Scripted answers per range. Each primary request takes the next step; the last step repeats. */
export function createScript() {
  const plans = new Map<string, Step[]>();
  const calls: string[] = [];
  return {
    calls,
    count: (selection: DateRangeSelection) => calls.filter(k => k === selectionKeyOf(selection)).length,
    plan(selection: DateRangeSelection, ...steps: Step[]) { plans.set(selectionKeyOf(selection), steps); },
    reset() { plans.clear(); calls.length = 0; },
    next(range: Range): Promise<Reply> {
      const key = rangeKeyOf(range);
      calls.push(key);
      const steps = plans.get(key) ?? [{ marker: `default-${key}`, state: 'done' }];
      const step = steps.length > 1 ? steps.shift()! : steps[0];
      return Promise.resolve(step);
    },
  };
}

export function jobOf(reply: Reply) {
  return reply.state ? { state: reply.state } : undefined;
}

export function cacheStatusOf(reply: Reply) {
  return { outcome: 'complete', complete: true, stale: false, coverage: reply.coverage };
}

export async function mount(element: ReactElement, initial?: DateRangeSelection) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  let setter: (range: DateRangeSelection) => void = () => undefined;
  function Capture() {
    setter = useDateRangeActions().setRange;
    return null;
  }
  await act(async () => { root.render(<DateRangeProvider><Capture />{element}</DateRangeProvider>); });
  if (initial) await act(async () => { setter(initial); });
  return {
    host,
    setRange: (range: DateRangeSelection) => act(async () => { setter(range); }),
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

export const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
export const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

export const NOTICE_TEXT = {
  en: { partial: 'Partially collected', missing: 'Not collected yet' },
  tr: { partial: 'Bu aralık kısmen toplandı', missing: 'Bu aralık henüz toplanmadı' },
} as const;
