// Pure view model for the activity heatmap and timeline. No React, no network.

import { addDaysToKey } from '../../../services/dateRange';
import type { ActivityDay, ActivityDayState } from '../../../services/activityDaily';

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;
export type ActivityPattern = 'none' | 'hatch' | 'dashed';

export interface DayVisual {
  level: ActivityLevel;
  pattern: ActivityPattern;
  stale: boolean;
  covered: boolean;
}

/** Density level for covered days (quartiles of the largest count in view); other states carry a pattern instead. */
export function dayVisual(day: ActivityDay, maxCount: number): DayVisual {
  switch (day.state) {
    case 'covered_zero':
      return { level: 0, pattern: 'none', stale: day.stale, covered: true };
    case 'covered_active': {
      const count = day.count ?? 0;
      const ratio = maxCount > 0 ? count / maxCount : 0;
      const level = Math.min(4, Math.max(1, Math.ceil(ratio * 4))) as ActivityLevel;
      return { level, pattern: 'none', stale: day.stale, covered: true };
    }
    case 'partial':
      return { level: 0, pattern: 'hatch', stale: day.stale, covered: false };
    case 'not_collected':
    case 'unavailable_retention':
      return { level: 0, pattern: 'dashed', stale: false, covered: false };
  }
}

export function maxCoveredCount(days: ActivityDay[]): number {
  return days.reduce((max, day) => (day.state === 'covered_active' && (day.count ?? 0) > max ? (day.count as number) : max), 0);
}

export type TimelineGranularity = 'day' | 'week' | 'month';

/** Day bars up to 45 days, weekly bars up to 200 days, monthly bars beyond. */
export function timelineGranularity(dayCount: number): TimelineGranularity {
  if (dayCount <= 45) return 'day';
  if (dayCount <= 200) return 'week';
  return 'month';
}

export interface TimelineBin {
  start: string;
  end: string;
  count: number | null;
  state: ActivityDayState;
}

// Worst state wins when a bin mixes states. Retention and not-collected outrank partial, which outranks zero.
const STATE_RANK: Record<ActivityDayState, number> = {
  covered_active: 0,
  covered_zero: 1,
  partial: 2,
  not_collected: 3,
  unavailable_retention: 4,
};

function binKey(date: string, granularity: TimelineGranularity): string {
  if (granularity === 'day') return date;
  if (granularity === 'month') return date.slice(0, 7);
  // Monday-start weeks, identified by their Monday.
  const [y, m, d] = date.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDaysToKey(date, -dow);
}

/**
 * Groups days into bars. `count` is the sum over covered days in the bin, or null when the bin has no covered
 * day. `state` is the worst state in the bin, so a partly uncollected bar is never shown as complete.
 */
export function bin(days: ActivityDay[], granularity: TimelineGranularity): TimelineBin[] {
  const bins = new Map<string, { bin: TimelineBin; covered: number; coveredDays: number }>();
  for (const day of days) {
    const key = binKey(day.date, granularity);
    const covered = day.state === 'covered_active' || day.state === 'covered_zero';
    let entry = bins.get(key);
    if (!entry) {
      entry = { bin: { start: day.date, end: day.date, count: null, state: day.state }, covered: 0, coveredDays: 0 };
      bins.set(key, entry);
    }
    entry.bin.end = day.date;
    if (covered) {
      entry.covered += day.count ?? 0;
      entry.coveredDays += 1;
    }
    if (STATE_RANK[day.state] > STATE_RANK[entry.bin.state]) entry.bin.state = day.state;
  }
  return Array.from(bins.values()).map(({ bin: b, covered, coveredDays }) => ({
    ...b,
    count: coveredDays > 0 ? covered : null,
  }));
}

export function clampHandle(dateKey: string, minKey: string, maxKey: string): string {
  if (dateKey < minKey) return minKey;
  if (dateKey > maxKey) return maxKey;
  return dateKey;
}

export type HandleKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/** Keyboard step for a range handle. Arrows move one day, Shift+arrows one week, Home/End jump to the bounds. */
export function stepHandle(dateKey: string, key: HandleKey, shiftKey: boolean, minKey: string, maxKey: string): string {
  if (key === 'Home') return minKey;
  if (key === 'End') return maxKey;
  const step = shiftKey ? 7 : 1;
  const delta = key === 'ArrowLeft' ? -step : step;
  return clampHandle(addDaysToKey(dateKey, delta), minKey, maxKey);
}

