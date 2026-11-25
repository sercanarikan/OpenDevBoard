// Persistence of the applied global date range. Everything read back is validated again, never trusted.

import {
  DEFAULT_DATE_RANGE_PRESET,
  ROLLING_PRESETS,
  presetSelection,
  utcTodayKey,
  validateCustomRange,
  type DateRangePresetId,
  type DateRangeSelection,
} from './dateRange';

/** Versioned so an incompatible shape can be dropped instead of migrated. */
export const DATE_RANGE_STORAGE_KEY = 'opendevboard.dateRange.v1';

// Presets that are defined relative to "today": their dates are recomputed on load, never trusted from storage.
const RELATIVE_CALENDAR_PRESETS = new Set<string>([
  'last1', 'last6m', 'last1y', 'today', 'yesterday', 'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'thisYear', 'lastYear',
]);
const STORED_CALENDAR_PRESETS = new Set<string>(['custom', 'day', 'month', 'quarter', 'year']);

export const defaultRange = (todayKey: string = utcTodayKey()): DateRangeSelection => presetSelection(DEFAULT_DATE_RANGE_PRESET, todayKey);

export function serializeRange(range: DateRangeSelection): string {
  return JSON.stringify({ v: 1, range });
}

/** Reads a stored selection. Anything corrupt, from another version, or outside the allowed window gives the default. */
export function parseStoredRange(raw: string | null, todayKey: string = utcTodayKey()): DateRangeSelection {
  const fallback = defaultRange(todayKey);
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1) return fallback;
    const range = (parsed as { range?: unknown }).range as Record<string, unknown> | undefined;
    if (!range || typeof range !== 'object') return fallback;
    if (range.kind === 'rolling') {
      const preset = range.preset as string;
      if (!Object.prototype.hasOwnProperty.call(ROLLING_PRESETS, preset)) return fallback;
      const days = ROLLING_PRESETS[preset as keyof typeof ROLLING_PRESETS];
      return range.days === days ? presetSelection(preset as DateRangePresetId, todayKey) : fallback;
    }
    if (range.kind === 'calendar') {
      const preset = range.preset;
      if (typeof preset === 'string' && RELATIVE_CALENDAR_PRESETS.has(preset)) return presetSelection(preset as DateRangePresetId, todayKey);
      if (typeof preset !== 'string' || !STORED_CALENDAR_PRESETS.has(preset)) return fallback;
      const { startDate, endDate } = range;
      if (typeof startDate !== 'string' || typeof endDate !== 'string') return fallback;
      if (validateCustomRange(startDate, endDate, todayKey)) return fallback;
      return { kind: 'calendar', preset: preset as 'custom' | 'day' | 'month' | 'quarter' | 'year', startDate, endDate };
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function readStoredRange(): DateRangeSelection {
  try {
    return parseStoredRange(window.localStorage.getItem(DATE_RANGE_STORAGE_KEY));
  } catch {
    return defaultRange();
  }
}

export function writeStoredRange(range: DateRangeSelection): void {
  try {
    window.localStorage.setItem(DATE_RANGE_STORAGE_KEY, serializeRange(range));
  } catch {
    // Storage can be blocked (private mode, quota); the in-memory selection still works.
  }
}

