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
  /** Records summed over covered days only; null when the bucket has no covered day. */
  count: number | null;
  /** Number of calendar days the bucket spans; bar widths are proportional to this. */
  days: number;
  coveredDays: number;
  /** Days in the bucket with no scan (partial, not collected, unavailable). Known activity is never hidden by these. */
  uncoveredDays: number;
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
  const bins = new Map<string, TimelineBin & { covered: number }>();
  for (const day of days) {
    const key = binKey(day.date, granularity);
    const covered = day.state === 'covered_active' || day.state === 'covered_zero';
    let entry = bins.get(key);
    if (!entry) {
      entry = { start: day.date, end: day.date, count: null, days: 0, coveredDays: 0, uncoveredDays: 0, state: day.state, covered: 0 };
      bins.set(key, entry);
    }
    entry.end = day.date;
    entry.days += 1;
    if (covered) {
      entry.covered += day.count ?? 0;
      entry.coveredDays += 1;
    } else {
      entry.uncoveredDays += 1;
    }
    if (STATE_RANK[day.state] > STATE_RANK[entry.state]) entry.state = day.state;
  }
  return Array.from(bins.values()).map(({ covered, ...b }) => ({
    ...b,
    count: b.coveredDays > 0 ? covered : null,
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


export type DensityLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Calendar density for a covered, active day: six steps against the largest count in view. */
export function densityLevel(count: number, maxCount: number): DensityLevel {
  if (maxCount <= 0) return 1;
  const ratio = Math.min(1, Math.max(0, count / maxCount));
  return Math.min(6, Math.max(1, Math.ceil(ratio * 6))) as DensityLevel;
}

/** Finest granularity that stays legible: days up to 120 days, weeks up to 400, months beyond. */
function finestGranularity(dayCount: number): TimelineGranularity {
  if (dayCount <= 120) return 'day';
  if (dayCount <= 400) return 'week';
  return 'month';
}

const GRANULARITY_ORDER: TimelineGranularity[] = ['day', 'week', 'month'];

/** The chosen granularity, made coarser when the span is too long to draw at that detail. */
export function effectiveGranularity(selected: TimelineGranularity, dayCount: number): TimelineGranularity {
  const minimum = finestGranularity(dayCount);
  return GRANULARITY_ORDER.indexOf(selected) >= GRANULARITY_ORDER.indexOf(minimum) ? selected : minimum;
}
