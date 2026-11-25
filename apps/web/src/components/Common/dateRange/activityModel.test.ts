import { describe, expect, it } from 'vitest';
import type { ActivityDay } from '../../../services/activityDaily';
import { bin, clampHandle, dayVisual, maxCoveredCount, stepHandle, timelineGranularity } from './activityModel';

const day = (date: string, state: ActivityDay['state'], count: number | null = null, stale = false): ActivityDay => ({
  date,
  state,
  count,
  stale,
});

describe('day visuals', () => {
  it('shows scanned zero activity as the lowest level with no pattern', () => {
    expect(dayVisual(day('2026-01-01', 'covered_zero', 0), 10)).toEqual({ level: 0, pattern: 'none', stale: false, covered: true });
  });

  it('maps covered activity to levels 1–4 by quartile of the largest count', () => {
    expect(dayVisual(day('a', 'covered_active', 1), 8).level).toBe(1);
    expect(dayVisual(day('a', 'covered_active', 4), 8).level).toBe(2);
    expect(dayVisual(day('a', 'covered_active', 6), 8).level).toBe(3);
    expect(dayVisual(day('a', 'covered_active', 8), 8).level).toBe(4);
  });

  it('never gives uncollected, partial or retention-expired days a density level', () => {
    expect(dayVisual(day('a', 'partial'), 8)).toMatchObject({ level: 0, pattern: 'hatch', covered: false });
    expect(dayVisual(day('a', 'not_collected'), 8)).toMatchObject({ level: 0, pattern: 'dashed', covered: false });
    expect(dayVisual(day('a', 'unavailable_retention'), 8)).toMatchObject({ level: 0, pattern: 'dashed', covered: false });
  });

  it('keeps stale as a flag on covered days, not a separate state', () => {
    expect(dayVisual(day('a', 'covered_active', 3, true), 3)).toMatchObject({ level: 4, stale: true, covered: true });
  });

  it('finds the largest covered count in view', () => {
    expect(maxCoveredCount([day('a', 'covered_active', 3), day('b', 'partial'), day('c', 'covered_active', 7)])).toBe(7);
    expect(maxCoveredCount([day('a', 'not_collected')])).toBe(0);
  });
});

describe('timeline granularity and binning', () => {
  it('uses day bars up to 45 days, weekly up to 200 and monthly beyond', () => {
    expect(timelineGranularity(45)).toBe('day');
    expect(timelineGranularity(46)).toBe('week');
    expect(timelineGranularity(200)).toBe('week');
    expect(timelineGranularity(201)).toBe('month');
  });

  it('bins weeks Monday to Sunday and keeps every day', () => {
    // 2026-11-23 is a Monday; 2026-11-29 is a Sunday; 2026-11-30 starts the next week.
    const days = ['2026-11-23', '2026-11-24', '2026-11-29', '2026-11-30'].map(d => day(d, 'covered_active', 1));
    const bins = bin(days, 'week');
    expect(bins).toHaveLength(2);
    expect(bins[0]).toMatchObject({ start: '2026-11-23', end: '2026-11-29', count: 3, state: 'covered_active' });
    expect(bins[1]).toMatchObject({ start: '2026-11-30', end: '2026-11-30', count: 1 });
  });

  it('groups months across a year boundary without losing days', () => {
    const days = [day('2026-12-31', 'covered_zero', 0), day('2027-01-01', 'covered_zero', 0)];
    expect(bin(days, 'month').map(b => b.start)).toEqual(['2026-12-31', '2027-01-01']);
  });

  it('reports the worst state in a mixed bin and sums only covered days', () => {
    const bins = bin([day('2026-09-01', 'covered_active', 4), day('2026-09-02', 'partial')], 'week');
    expect(bins[0]).toMatchObject({ count: 4, state: 'partial' });
  });

  it('reports no count for a bin without covered days', () => {
    expect(bin([day('2026-09-01', 'not_collected')], 'day')[0].count).toBeNull();
  });
});

describe('range handles', () => {
  it('clamps handles to the allowed bounds', () => {
    expect(clampHandle('2025-01-01', '2026-01-01', '2026-12-31')).toBe('2026-01-01');
    expect(clampHandle('2027-01-01', '2026-01-01', '2026-12-31')).toBe('2026-12-31');
    expect(clampHandle('2026-06-01', '2026-01-01', '2026-12-31')).toBe('2026-06-01');
  });

  it('steps one day with arrows and one week with shift', () => {
    expect(stepHandle('2026-03-01', 'ArrowLeft', false, '2026-01-01', '2026-12-31')).toBe('2026-02-28');
    expect(stepHandle('2028-02-28', 'ArrowRight', false, '2028-01-01', '2028-12-31')).toBe('2028-02-29');
    expect(stepHandle('2026-03-10', 'ArrowRight', true, '2026-01-01', '2026-12-31')).toBe('2026-03-17');
  });

  it('jumps to the bounds with Home and End and never leaves them', () => {
    expect(stepHandle('2026-06-01', 'Home', false, '2026-01-01', '2026-12-31')).toBe('2026-01-01');
    expect(stepHandle('2026-06-01', 'End', false, '2026-01-01', '2026-12-31')).toBe('2026-12-31');
    expect(stepHandle('2026-01-01', 'ArrowLeft', true, '2026-01-01', '2026-12-31')).toBe('2026-01-01');
  });
});
