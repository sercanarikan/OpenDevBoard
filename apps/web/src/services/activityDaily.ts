// Client contract for GET /api/activity/daily and the demo/fixture counterpart.
//
// Day states mirror services/api/activity_service.py. A count is only meaningful for covered days.
// The demo generator is fixture data: every response it produces carries `fixture: true`.

import { addDaysToKey, dayCountInclusive, isDateKey, type DateRangeSelection } from './dateRange';

export type ActivityMetric = 'pipelines' | 'deployments' | 'commits';
export type ActivityDayState =
  | 'covered_zero'
  | 'covered_active'
  | 'partial'
  | 'not_collected'
  | 'unavailable_retention';
export type ActivityJobState = 'idle' | 'running' | 'done' | 'partial' | 'failed';
export type ActivityMode = 'cache' | 'refresh';

export const ACTIVITY_METRICS: ActivityMetric[] = ['pipelines', 'deployments', 'commits'];

export interface ActivityDay {
  date: string;
  count: number | null;
  state: ActivityDayState;
  stale: boolean;
}

export interface ActivityDailyResponse {
  metric: ActivityMetric;
  window: { kind: string; startDate: string; endDate: string; days: number; timezone: 'UTC' };
  days: ActivityDay[];
  job: { state: ActivityJobState; pending: number; completed: number; partial: number; failed: number };
  cacheStatus: { complete: boolean; partialDays: number; notCollectedDays: number };
  fixture?: true;
}

export interface ActivityDailyParams {
  metric: ActivityMetric;
  startDate: string;
  endDate: string;
  mode: ActivityMode;
}

/** Calendar bounds for a selection. Rolling presets are converted from their day count ending today. */
export function selectionBounds(selection: DateRangeSelection, todayKey: string): { startDate: string; endDate: string } {
  if (selection.kind === 'calendar') return { startDate: selection.startDate, endDate: selection.endDate };
  return { startDate: addDaysToKey(todayKey, -(selection.days - 1)), endDate: todayKey };
}

export function activityQuery(params: ActivityDailyParams): URLSearchParams {
  const q = new URLSearchParams();
  q.set('metric', params.metric);
  q.set('startDate', params.startDate);
  q.set('endDate', params.endDate);
  q.set('mode', params.mode);
  return q;
}

export function isValidActivityRange(startDate: string, endDate: string): boolean {
  return isDateKey(startDate) && isDateKey(endDate) && endDate >= startDate;
}

// Demo data: deterministic, synthetic, and explicitly labelled as fixture.
// Days before the fixture start are not collected; one month is partial so every state is visible.
const DEMO_COLLECTED_FROM = '2026-06-01';
const DEMO_PARTIAL_MONTH = '2026-09';
const DEMO_MAX_COUNT: Record<ActivityMetric, number> = { pipelines: 18, deployments: 6, commits: 12 };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function demoCount(metric: ActivityMetric, date: string): number {
  const h = hash(`${metric}:${date}`);
  if (h % 10 < 3) return 0; // roughly 30% of collected days are quiet
  return 1 + (h % DEMO_MAX_COUNT[metric]);
}

export function demoActivityDaily(params: ActivityDailyParams): ActivityDailyResponse {
  const days: ActivityDay[] = [];
  const total = dayCountInclusive(params.startDate, params.endDate);
  for (let i = 0; i < total; i += 1) {
    const date = addDaysToKey(params.startDate, i);
    if (date < DEMO_COLLECTED_FROM) {
      days.push({ date, count: null, state: 'not_collected', stale: false });
    } else if (date.slice(0, 7) === DEMO_PARTIAL_MONTH) {
      days.push({ date, count: null, state: 'partial', stale: false });
    } else {
      const count = demoCount(params.metric, date);
      days.push({ date, count, state: count > 0 ? 'covered_active' : 'covered_zero', stale: false });
    }
  }
  const partialDays = days.filter(d => d.state === 'partial').length;
  const notCollectedDays = days.filter(d => d.state === 'not_collected').length;
  return {
    metric: params.metric,
    window: { kind: 'calendar', startDate: params.startDate, endDate: params.endDate, days: total, timezone: 'UTC' },
    days,
    job: { state: 'idle', pending: 0, completed: 0, partial: 0, failed: 0 },
    cacheStatus: { complete: partialDays === 0 && notCollectedDays === 0, partialDays, notCollectedDays },
    fixture: true,
  };
}
