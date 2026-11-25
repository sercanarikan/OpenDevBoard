// Pure date-range model shared by the analytics screens.
//
// All calendar days are UTC `YYYY-MM-DD` keys, matching the backend `date_window`
// contract (startDate/endDate inclusive, interpreted in UTC). Rolling presets keep
// sending the legacy `days` parameter so existing API behaviour is unchanged.

// Query windows may span three years (mirrors backend QUERY_MAX_SPAN_DAYS). Long windows are served
// by chunked, coverage-tracked fetches on the backend.
export const DATE_RANGE_MAX_SPAN_DAYS = 1096;
// Start may be at most 3650 days before today (UTC), today included in the count.
export const DATE_RANGE_MAX_AGE_DAYS = 3650;
export const DEFAULT_DATE_RANGE_PRESET: RollingPresetId = 'last30';

export type RollingPresetId = 'last7' | 'last14' | 'last30' | 'last90';
export type CalendarPresetId =
  | 'last1'
  | 'last6m'
  | 'last1y'
  | 'today'
  | 'yesterday'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisQuarter'
  | 'lastQuarter'
  | 'thisYear'
  | 'lastYear'
  | 'day'
  | 'month'
  | 'quarter'
  | 'year'
  | 'custom';
export type DateRangePresetId = RollingPresetId | CalendarPresetId;
export type PeriodKind = 'day' | 'month' | 'quarter' | 'year';

export const ROLLING_PRESETS: Record<RollingPresetId, number> = { last7: 7, last14: 14, last30: 30, last90: 90 };

export type DateRangeSelection =
  | { kind: 'rolling'; preset: RollingPresetId; days: number }
  | { kind: 'calendar'; preset: CalendarPresetId; startDate: string; endDate: string };

/** Parameters understood by the liveApi/demoApi range arguments. */
export type DateRangeQuery = { days: number } | { startDate: string; endDate: string };

export type CustomRangeError = 'invalidDate' | 'endBeforeStart' | 'tooLong' | 'future' | 'tooOld';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value: string): boolean {
  if (!KEY_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Today's UTC calendar day as a key. Presets are computed in UTC to match the backend. */
export function utcTodayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDaysToKey(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Inclusive number of UTC days between two keys (1 for the same day). */
export function dayCountInclusive(startKey: string, endKey: string): number {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / DAY_MS) + 1;
}

function firstOfMonthKey(todayKey: string): string {
  return `${todayKey.slice(0, 8)}01`;
}

function lastOfPreviousMonthKey(todayKey: string): string {
  return addDaysToKey(firstOfMonthKey(todayKey), -1);
}

function firstOfPreviousMonthKey(todayKey: string): string {
  const last = lastOfPreviousMonthKey(todayKey);
  return `${last.slice(0, 8)}01`;
}

/** Adds calendar months to a key, clamping the day to the target month's length. */
export function addMonthsToKey(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + delta, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)).toISOString().slice(0, 10);
}

function quarterStartKey(todayKey: string, quarterOffset = 0): string {
  const [y, m] = todayKey.split('-').map(Number);
  const index = Math.floor((m - 1) / 3) + quarterOffset; // may be negative: previous year
  const year = y + Math.floor(index / 4);
  const month = ((index % 4) + 4) % 4 * 3 + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function quarterEndKey(startKey: string): string {
  return addDaysToKey(addMonthsToKey(startKey, 3), -1);
}

/** Selection for a preset, relative to the given UTC day. */
export function presetSelection(preset: DateRangePresetId, todayKey: string): DateRangeSelection {
  if (preset === 'last1') {
    return { kind: 'calendar', preset, startDate: todayKey, endDate: todayKey };
  }
  if (preset === 'last6m') {
    return { kind: 'calendar', preset, startDate: addDaysToKey(addMonthsToKey(todayKey, -6), 1), endDate: todayKey };
  }
  if (preset === 'last1y') {
    return { kind: 'calendar', preset, startDate: addDaysToKey(addMonthsToKey(todayKey, -12), 1), endDate: todayKey };
  }
  if (preset === 'today') {
    return { kind: 'calendar', preset, startDate: todayKey, endDate: todayKey };
  }
  if (preset === 'yesterday') {
    const yesterday = addDaysToKey(todayKey, -1);
    return { kind: 'calendar', preset, startDate: yesterday, endDate: yesterday };
  }
  if (preset === 'thisMonth') {
    return { kind: 'calendar', preset, startDate: firstOfMonthKey(todayKey), endDate: todayKey };
  }
  if (preset === 'lastMonth') {
    return { kind: 'calendar', preset, startDate: firstOfPreviousMonthKey(todayKey), endDate: lastOfPreviousMonthKey(todayKey) };
  }
  if (preset === 'thisQuarter') {
    return { kind: 'calendar', preset, startDate: quarterStartKey(todayKey), endDate: todayKey };
  }
  if (preset === 'lastQuarter') {
    const start = quarterStartKey(todayKey, -1);
    return { kind: 'calendar', preset, startDate: start, endDate: quarterEndKey(start) };
  }
  if (preset === 'thisYear') {
    return { kind: 'calendar', preset, startDate: `${todayKey.slice(0, 4)}-01-01`, endDate: todayKey };
  }
  if (preset === 'lastYear') {
    const year = Number(todayKey.slice(0, 4)) - 1;
    return { kind: 'calendar', preset, startDate: `${year}-01-01`, endDate: `${year}-12-31` };
  }
  if (preset === 'custom' || preset === 'day' || preset === 'month' || preset === 'quarter' || preset === 'year') {
    // Custom and period kinds start from the current month so the picker always opens on a valid range.
    return { kind: 'calendar', preset, startDate: firstOfMonthKey(todayKey), endDate: todayKey };
  }
  return { kind: 'rolling', preset, days: ROLLING_PRESETS[preset] };
}

export type PeriodParams = { date?: string; year?: number; month?: number; quarter?: number };

/** Direct period selection: a single day, a calendar month, a quarter or a whole year. */
export function periodSelection(kind: PeriodKind, params: PeriodParams, todayKey: string): DateRangeSelection {
  if (kind === 'day') {
    const date = params.date ?? todayKey;
    return { kind: 'calendar', preset: 'day', startDate: date, endDate: date };
  }
  if (kind === 'month') {
    const year = params.year ?? Number(todayKey.slice(0, 4));
    const month = params.month ?? Number(todayKey.slice(5, 7));
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    return { kind: 'calendar', preset: 'month', startDate: start, endDate: lastDayOfMonthKey(start) };
  }
  if (kind === 'quarter') {
    const year = params.year ?? Number(todayKey.slice(0, 4));
    const quarter = params.quarter ?? Math.floor((Number(todayKey.slice(5, 7)) - 1) / 3) + 1;
    const start = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
    return { kind: 'calendar', preset: 'quarter', startDate: start, endDate: quarterEndKey(start) };
  }
  const year = params.year ?? Number(todayKey.slice(0, 4));
  return { kind: 'calendar', preset: 'year', startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

function lastDayOfMonthKey(startKey: string): string {
  return addDaysToKey(addMonthsToKey(startKey, 1), -1);
}

/** Explicit custom selection; the caller must validate with `validateCustomRange` first. */
export function customSelection(startDate: string, endDate: string): DateRangeSelection {
  return { kind: 'calendar', preset: 'custom', startDate, endDate };
}

export function validateCustomRange(
  startDate: string,
  endDate: string,
  todayKey: string,
  maxSpanDays: number = DATE_RANGE_MAX_SPAN_DAYS
): CustomRangeError | null {
  if (!isDateKey(startDate) || !isDateKey(endDate) || !isDateKey(todayKey)) return 'invalidDate';
  if (endDate < startDate) return 'endBeforeStart';
  if (endDate > todayKey) return 'future';
  if (startDate < addDaysToKey(todayKey, -DATE_RANGE_MAX_AGE_DAYS)) return 'tooOld';
  if (dayCountInclusive(startDate, endDate) > maxSpanDays) return 'tooLong';
  return null;
}

/** Whether a day can be picked, given the first click (anchor) of a range being built. */
export function isPickableDay(
  dayKey: string,
  todayKey: string,
  anchorKey: string | null,
  maxSpanDays: number = DATE_RANGE_MAX_SPAN_DAYS
): boolean {
  if (dayKey > todayKey) return false;
  if (dayKey < addDaysToKey(todayKey, -DATE_RANGE_MAX_AGE_DAYS)) return false;
  if (anchorKey === null) return true;
  // Once the start is chosen, only days that keep the span within the limit are selectable.
  const earlier = dayKey < anchorKey ? dayKey : anchorKey;
  const later = dayKey < anchorKey ? anchorKey : dayKey;
  return dayCountInclusive(earlier, later) <= maxSpanDays;
}

export function toApiRange(selection: DateRangeSelection): DateRangeQuery {
  if (selection.kind === 'rolling') return { days: selection.days };
  return { startDate: selection.startDate, endDate: selection.endDate };
}

export function selectionDayCount(selection: DateRangeSelection): number {
  if (selection.kind === 'rolling') return selection.days;
  return dayCountInclusive(selection.startDate, selection.endDate);
}

/** Stable key for memoization and request identity. */
export function selectionKey(selection: DateRangeSelection): string {
  return selection.kind === 'rolling'
    ? `rolling:${selection.days}`
    : `calendar:${selection.startDate}:${selection.endDate}`;
}

/** Month grid for a calendar view. Weeks start on Monday; `null` marks padding days. */
export function buildMonthGrid(year: number, month: number): (string | null)[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const leading = (first.getUTCDay() + 6) % 7; // Monday = 0
  const cells: (string | null)[] = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function formatDayLabel(key: string, locale: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** Summary endpoints accept a legacy day count or an explicit calendar range. */
export type AnalyticsRange = number | DateRangeQuery;

export function rangeParams(range: AnalyticsRange): URLSearchParams {
  const q = new URLSearchParams();
  applyRangeParams(q, typeof range === 'number' ? { days: range } : range);
  return q;
}

/** Writes the range onto a query string; calendar bounds win when both shapes are given. */
export function applyRangeParams(q: URLSearchParams, p: { days?: number; startDate?: string; endDate?: string }): void {
  if (p.startDate !== undefined && p.endDate !== undefined) {
    q.set('startDate', p.startDate);
    q.set('endDate', p.endDate);
  } else if (p.days !== undefined) {
    q.set('days', String(p.days));
  }
}

/** Day count for demo/fixture computations that only know about a number of days. */
export function analyticsRangeDays(range: AnalyticsRange): number {
  if (typeof range === 'number') return range;
  if ('days' in range) return range.days;
  return dayCountInclusive(range.startDate, range.endDate);
}

/**
 * Label step for day-bucket charts. 7/14 days label every day; 30 days labels every 5th day
 * (unchanged from the previous fixed behaviour); longer or custom ranges stay around six labels.
 */
export function chartLabelStep(dayCount: number): number {
  if (dayCount <= 14) return 1;
  return Math.ceil(dayCount / 6);
}

/** Number of UTC days a selection covers. */
export function selectionSpanDays(selection: DateRangeSelection): number {
  return selection.kind === 'rolling' ? selection.days : dayCountInclusive(selection.startDate, selection.endDate);
}
