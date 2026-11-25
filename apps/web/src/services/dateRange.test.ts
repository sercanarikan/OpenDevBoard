import { describe, expect, it } from 'vitest';
import {
  addDaysToKey,
  addMonthsToKey,
  buildMonthGrid,
  chartLabelStep,
  dayCountInclusive,
  isPickableDay,
  periodSelection,
  presetSelection,
  selectionDayCount,
  toApiRange,
  utcTodayKey,
  validateCustomRange
} from './dateRange';

const TODAY = '2026-11-24';

describe('preset selections', () => {
  it('keeps rolling presets on the legacy days contract', () => {
    expect(toApiRange(presetSelection('last30', TODAY))).toEqual({ days: 30 });
    expect(toApiRange(presetSelection('last7', TODAY))).toEqual({ days: 7 });
    expect(toApiRange(presetSelection('last90', TODAY))).toEqual({ days: 90 });
  });

  it('computes this month from the first UTC day through today', () => {
    expect(presetSelection('thisMonth', TODAY)).toEqual({ kind: 'calendar', preset: 'thisMonth', startDate: '2026-11-01', endDate: TODAY });
  });

  it('computes last month as the full previous calendar month, not a day count', () => {
    expect(presetSelection('lastMonth', TODAY)).toEqual({ kind: 'calendar', preset: 'lastMonth', startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(selectionDayCount(presetSelection('lastMonth', TODAY))).toBe(31);
  });

  it('handles the year boundary for last month', () => {
    expect(presetSelection('lastMonth', '2027-01-10')).toEqual({ kind: 'calendar', preset: 'lastMonth', startDate: '2026-12-01', endDate: '2026-12-31' });
  });

  it('handles leap-year February for last month', () => {
    expect(presetSelection('lastMonth', '2028-03-05')).toEqual({ kind: 'calendar', preset: 'lastMonth', startDate: '2028-02-01', endDate: '2028-02-29' });
  });

  it('computes last 1 day, today and yesterday as single UTC days', () => {
    expect(presetSelection('last1', TODAY)).toEqual({ kind: 'calendar', preset: 'last1', startDate: TODAY, endDate: TODAY });
    expect(presetSelection('today', TODAY)).toEqual({ kind: 'calendar', preset: 'today', startDate: TODAY, endDate: TODAY });
    expect(presetSelection('yesterday', TODAY)).toEqual({ kind: 'calendar', preset: 'yesterday', startDate: '2026-11-23', endDate: '2026-11-23' });
  });

  it('computes last 6 months and last 1 year inclusive of today', () => {
    expect(presetSelection('last6m', TODAY)).toEqual({ kind: 'calendar', preset: 'last6m', startDate: '2026-05-25', endDate: TODAY });
    expect(presetSelection('last1y', TODAY)).toEqual({ kind: 'calendar', preset: 'last1y', startDate: '2025-11-25', endDate: TODAY });
  });

  it('clamps month arithmetic at month ends and leap days', () => {
    expect(addMonthsToKey('2027-08-31', -6)).toBe('2027-02-28');
    expect(addMonthsToKey('2028-02-29', 12)).toBe('2029-02-28');
  });

  it('computes this and last quarter, including the year boundary', () => {
    expect(presetSelection('thisQuarter', TODAY)).toEqual({ kind: 'calendar', preset: 'thisQuarter', startDate: '2026-10-01', endDate: TODAY });
    expect(presetSelection('lastQuarter', TODAY)).toEqual({ kind: 'calendar', preset: 'lastQuarter', startDate: '2026-07-01', endDate: '2026-09-30' });
    expect(presetSelection('lastQuarter', '2028-01-10')).toEqual({ kind: 'calendar', preset: 'lastQuarter', startDate: '2027-10-01', endDate: '2027-12-31' });
  });

  it('computes this year and last year as calendar years', () => {
    expect(presetSelection('thisYear', TODAY)).toEqual({ kind: 'calendar', preset: 'thisYear', startDate: '2026-01-01', endDate: TODAY });
    expect(presetSelection('lastYear', TODAY)).toEqual({ kind: 'calendar', preset: 'lastYear', startDate: '2025-01-01', endDate: '2025-12-31' });
  });
});

describe('period selections', () => {
  it('selects a single day', () => {
    expect(periodSelection('day', { date: '2026-11-03' }, TODAY)).toEqual({ kind: 'calendar', preset: 'day', startDate: '2026-11-03', endDate: '2026-11-03' });
  });

  it('selects a whole month including leap February', () => {
    expect(periodSelection('month', { year: 2028, month: 2 }, TODAY)).toEqual({ kind: 'calendar', preset: 'month', startDate: '2028-02-01', endDate: '2028-02-29' });
  });

  it('selects a quarter, including Q1 of a leap year', () => {
    expect(periodSelection('quarter', { year: 2028, quarter: 1 }, TODAY)).toEqual({ kind: 'calendar', preset: 'quarter', startDate: '2028-01-01', endDate: '2028-03-31' });
    expect(periodSelection('quarter', { year: 2027, quarter: 4 }, TODAY)).toEqual({ kind: 'calendar', preset: 'quarter', startDate: '2027-10-01', endDate: '2027-12-31' });
  });

  it('selects a whole calendar year', () => {
    expect(periodSelection('year', { year: 2027 }, TODAY)).toEqual({ kind: 'calendar', preset: 'year', startDate: '2027-01-01', endDate: '2027-12-31' });
  });
});

describe('custom range validation', () => {
  it('accepts a valid inclusive range', () => {
    expect(validateCustomRange('2026-11-01', '2026-11-24', TODAY)).toBeNull();
  });

  it('accepts exactly 1096 days and rejects one more (three-year query window)', () => {
    const start = addDaysToKey(TODAY, -1095);
    expect(dayCountInclusive(start, TODAY)).toBe(1096);
    expect(validateCustomRange(start, TODAY, TODAY)).toBeNull();
    expect(validateCustomRange(addDaysToKey(start, -1), TODAY, TODAY)).toBe('tooLong');
  });

  it('rejects an end before the start', () => {
    expect(validateCustomRange('2026-11-10', '2026-11-09', TODAY)).toBe('endBeforeStart');
  });

  it('rejects future end dates instead of clipping them', () => {
    expect(validateCustomRange('2026-11-20', '2026-11-25', TODAY)).toBe('future');
  });

  it('rejects starts older than 3650 days (today included in the count)', () => {
    const oldest = addDaysToKey(TODAY, -3650);
    expect(validateCustomRange(oldest, oldest, TODAY)).toBeNull();
    expect(validateCustomRange(addDaysToKey(oldest, -1), addDaysToKey(oldest, -1), TODAY)).toBe('tooOld');
  });

  it('rejects malformed and impossible dates', () => {
    expect(validateCustomRange('2026-02-30', '2026-03-01', TODAY)).toBe('invalidDate');
    expect(validateCustomRange('2026-1-1', '2026-01-02', TODAY)).toBe('invalidDate');
    expect(validateCustomRange('', '2026-01-02', TODAY)).toBe('invalidDate');
  });

  it('accepts a leap day and rejects Feb 29 in a non-leap year', () => {
    expect(validateCustomRange('2028-02-29', '2028-03-01', '2028-03-10')).toBeNull();
    expect(validateCustomRange('2027-02-29', '2027-03-01', '2027-03-10')).toBe('invalidDate');
  });
});

describe('picking days', () => {
  it('allows any day within the last 3650 days when no anchor exists', () => {
    expect(isPickableDay(TODAY, TODAY, null)).toBe(true);
    expect(isPickableDay(addDaysToKey(TODAY, -3650), TODAY, null)).toBe(true);
    expect(isPickableDay(addDaysToKey(TODAY, -3651), TODAY, null)).toBe(false);
    expect(isPickableDay('2026-11-25', TODAY, null)).toBe(false);
  });

  it('rejects future days even when an anchor is set', () => {
    expect(isPickableDay('2026-11-25', TODAY, '2026-11-01')).toBe(false);
  });

  it('keeps a picked end within 1096 days of the anchor in either direction', () => {
    const farBack = addDaysToKey(TODAY, -1095);
    expect(isPickableDay(farBack, TODAY, TODAY)).toBe(true);
    expect(isPickableDay('2026-11-01', TODAY, farBack)).toBe(true);
    expect(isPickableDay(addDaysToKey(TODAY, -1096), TODAY, TODAY)).toBe(false);
  });
});

describe('date arithmetic and grids', () => {
  it('moves across month and year boundaries', () => {
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToKey('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('builds a Monday-first grid with padding for November 2026', () => {
    const grid = buildMonthGrid(2026, 10);
    // 1 Nov 2026 is a Sunday, so the first week has six leading blanks.
    expect(grid[0]).toEqual([null, null, null, null, null, null, '2026-11-01']);
    expect(grid.flat().filter(Boolean)).toHaveLength(30);
    expect(grid.every(week => week.length === 7)).toBe(true);
  });

  it('derives today in UTC', () => {
    expect(utcTodayKey(new Date('2026-11-24T23:30:00Z'))).toBe('2026-11-24');
  });
});

describe('chart label step', () => {
  it('keeps the historical 7/14/30-day labelling and thins longer ranges', () => {
    expect(chartLabelStep(7)).toBe(1);
    expect(chartLabelStep(14)).toBe(1);
    expect(chartLabelStep(30)).toBe(5);
    expect(chartLabelStep(90)).toBe(15);
    expect(chartLabelStep(31)).toBe(6);
  });
});
