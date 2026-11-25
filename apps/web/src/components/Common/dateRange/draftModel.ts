// Draft state of the date range picker. Pure functions: the draft is edited freely and only becomes the applied
// selection (and therefore a data request) when the user presses Apply.

import {
  customSelection,
  isDateKey,
  periodSelection,
  presetSelection,
  validateCustomRange,
  type CustomRangeError,
  type DateRangePresetId,
  type DateRangeSelection,
  type PeriodKind,
} from '../../../services/dateRange';
import { selectionBounds } from '../../../services/activityDaily';

export interface Draft {
  start: string;
  end: string;
  /** The preset the bounds came from, or null once the user edited the bounds by hand. */
  preset: DateRangePresetId | null;
}

/** Most used periods, always visible. */
export const PRESET_MAIN: DateRangePresetId[] = ['last7', 'last14', 'last30', 'last90', 'today', 'thisMonth', 'lastMonth', 'thisYear'];
/** Everything else, behind "More periods". */
export const PRESET_MORE: DateRangePresetId[] = ['yesterday', 'thisQuarter', 'lastQuarter', 'lastYear', 'last6m', 'last1y'];
export const RELATIVE_PRESETS: DateRangePresetId[] = [...PRESET_MAIN, ...PRESET_MORE];

const PERIOD_KINDS: PeriodKind[] = ['day', 'month', 'quarter', 'year'];

const isRelative = (preset: DateRangePresetId) => RELATIVE_PRESETS.includes(preset);
const isPeriodKind = (preset: DateRangePresetId): preset is PeriodKind => (PERIOD_KINDS as string[]).includes(preset);

export function draftFromSelection(selection: DateRangeSelection, todayKey: string): Draft {
  const { startDate, endDate } = selectionBounds(selection, todayKey);
  return { start: startDate, end: endDate, preset: selection.preset === 'custom' ? null : selection.preset };
}

export function draftFromPreset(preset: DateRangePresetId, todayKey: string): Draft {
  return draftFromSelection(presetSelection(preset, todayKey), todayKey);
}

function periodFor(kind: PeriodKind, start: string, todayKey: string): DateRangeSelection {
  if (kind === 'day') return periodSelection('day', { date: start }, todayKey);
  if (kind === 'month') return periodSelection('month', { year: Number(start.slice(0, 4)), month: Number(start.slice(5, 7)) }, todayKey);
  if (kind === 'quarter') return periodSelection('quarter', { year: Number(start.slice(0, 4)), quarter: Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1 }, todayKey);
  return periodSelection('year', { year: Number(start.slice(0, 4)) }, todayKey);
}

/**
 * The selection a draft becomes on Apply. A draft that still matches its preset or a full period keeps that
 * identity (rolling presets stay rolling); anything edited by hand, or a period clipped at today, is custom.
 */
export function selectionFromDraft(draft: Draft, todayKey: string): DateRangeSelection {
  const { preset } = draft;
  if (preset && isRelative(preset)) {
    const selection = presetSelection(preset, todayKey);
    const bounds = selectionBounds(selection, todayKey);
    if (bounds.startDate === draft.start && bounds.endDate === draft.end) return selection;
  } else if (preset && isPeriodKind(preset)) {
    const selection = periodFor(preset, draft.start, todayKey);
    if (selection.kind === 'calendar' && selection.startDate === draft.start && selection.endDate === draft.end) return selection;
  }
  return customSelection(draft.start, draft.end);
}

export function validateDraft(start: string, end: string, todayKey: string): CustomRangeError | null {
  return validateCustomRange(start, end, todayKey);
}

/** Strict `YYYY-MM-DD` parsing for the manual start and end fields. */
export function parseDateInput(text: string): string | null {
  const value = text.trim();
  return isDateKey(value) ? value : null;
}
