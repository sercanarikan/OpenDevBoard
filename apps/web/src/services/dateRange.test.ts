import { describe, expect, it } from 'vitest';
import {
  addDaysToKey,
  buildMonthGrid,
  chartLabelStep,
  dayCountInclusive,
  isPickableDay,
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
});

describe('custom range validation', () => {
  it('accepts a valid inclusive range', () => {
    expect(validateCustomRange('2026-11-01', '2026-11-24', TODAY)).toBeNull();
  });

  it('accepts exactly 90 days (the oldest allowed start is today minus 89 days)', () => {
    expect(validateCustomRange('2026-08-27', TODAY, TODAY)).toBeNull();
    expect(dayCountInclusive('2026-08-27', TODAY)).toBe(90);
    expect(validateCustomRange('2026-08-26', '2026-08-26', TODAY)).toBe('tooOld');
  });

  it('rejects an end before the start', () => {
    expect(validateCustomRange('2026-11-10', '2026-11-09', TODAY)).toBe('endBeforeStart');
  });

  it('rejects future end dates instead of clipping them', () => {
    expect(validateCustomRange('2026-11-20', '2026-11-25', TODAY)).toBe('future');
  });

  it('rejects starts older than the 90-day window', () => {
    expect(validateCustomRange('2026-08-27', TODAY, TODAY)).toBeNull();
    expect(validateCustomRange('2026-08-26', '2026-08-26', TODAY)).toBe('tooOld');
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
  it('allows any day within the last 90 days when no anchor exists', () => {
    expect(isPickableDay(TODAY, TODAY, null)).toBe(true);
    expect(isPickableDay('2026-08-27', TODAY, null)).toBe(true);
    expect(isPickableDay('2026-08-26', TODAY, null)).toBe(false);
    expect(isPickableDay('2026-11-25', TODAY, null)).toBe(false);
  });

  it('rejects future days even when an anchor is set', () => {
    expect(isPickableDay('2026-11-25', TODAY, '2026-11-01')).toBe(false);
  });

  it('keeps a picked end within 90 days of the anchor in either direction', () => {
    expect(isPickableDay('2026-08-27', TODAY, '2026-11-24')).toBe(true);
    expect(isPickableDay('2026-11-01', TODAY, '2026-08-27')).toBe(true);
    expect(isPickableDay('2026-08-26', TODAY, '2026-11-24')).toBe(false);
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
