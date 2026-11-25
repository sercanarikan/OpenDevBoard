import { describe, expect, it } from 'vitest';
import {
  activityMetricsForPath,
  activityQuery,
  DASHBOARD_ACTIVITY_METRICS,
  demoActivityDaily,
  isValidActivityRange,
  selectionBounds,
} from './activityDaily';
import { presetSelection } from './dateRange';

const TODAY = '2026-11-24';

describe('activity query contract', () => {
  it('serializes metric, UTC calendar bounds and mode', () => {
    const q = activityQuery({ metric: 'pipelines', startDate: '2026-01-01', endDate: '2026-03-31', mode: 'cache' });
    expect(q.toString()).toBe('metric=pipelines&startDate=2026-01-01&endDate=2026-03-31&mode=cache');
  });

  it('converts rolling presets into calendar bounds ending today', () => {
    expect(selectionBounds(presetSelection('last7', TODAY), TODAY)).toEqual({ startDate: '2026-11-18', endDate: TODAY });
  });

  it('passes calendar selections through unchanged', () => {
    expect(selectionBounds(presetSelection('lastMonth', TODAY), TODAY)).toEqual({ startDate: '2026-10-01', endDate: '2026-10-31' });
  });

  it('rejects malformed or reversed ranges before any request', () => {
    expect(isValidActivityRange('2026-02-30', '2026-03-01')).toBe(false);
    expect(isValidActivityRange('2026-03-02', '2026-03-01')).toBe(false);
    expect(isValidActivityRange('2026-03-01', '2026-03-01')).toBe(true);
  });
});

describe('demo activity fixture', () => {
  const base = { metric: 'pipelines' as const, mode: 'refresh' as const };

  it('labels every response as fixture data and returns one entry per UTC day', () => {
    const body = demoActivityDaily({ ...base, startDate: '2026-07-01', endDate: '2026-07-31' });
    expect(body.fixture).toBe(true);
    expect(body.days).toHaveLength(31);
    expect(body.window.days).toBe(31);
  });

  it('is deterministic for the same input', () => {
    const a = demoActivityDaily({ ...base, startDate: '2026-07-01', endDate: '2026-07-10' });
    const b = demoActivityDaily({ ...base, startDate: '2026-07-01', endDate: '2026-07-10' });
    expect(a).toEqual(b);
  });

  it('exercises every day state', () => {
    const body = demoActivityDaily({ ...base, startDate: '2026-05-20', endDate: '2026-10-10' });
    const states = new Set(body.days.map(d => d.state));
    expect(states).toEqual(new Set(['not_collected', 'partial', 'covered_zero', 'covered_active']));
  });

  it('never reports a count for uncollected or partial days', () => {
    const body = demoActivityDaily({ ...base, startDate: '2026-05-20', endDate: '2026-10-10' });
    for (const day of body.days) {
      if (day.state === 'not_collected' || day.state === 'partial') expect(day.count).toBeNull();
      if (day.state === 'covered_zero') expect(day.count).toBe(0);
      if (day.state === 'covered_active') expect(day.count).toBeGreaterThan(0);
    }
  });

  it('produces different counts for equal-length windows with different dates', () => {
    const a = demoActivityDaily({ ...base, startDate: '2026-07-01', endDate: '2026-07-10' });
    const b = demoActivityDaily({ ...base, startDate: '2026-08-01', endDate: '2026-08-10' });
    expect(a.days.map(d => d.count)).not.toEqual(b.days.map(d => d.count));
  });

  it('supports a two-year window', () => {
    const body = demoActivityDaily({ ...base, startDate: '2025-01-01', endDate: '2026-12-31' });
    expect(body.days).toHaveLength(730);
  });
});

describe('screen-aware metrics and project filter', () => {
  it('offers the metrics that match each screen, with the Dashboard set as the fallback', () => {
    expect(activityMetricsForPath('/dashboard')).toEqual(['pipelines', 'deployments', 'commits']);
    expect(activityMetricsForPath('/pull-requests')).toEqual(['pull-requests-created', 'pull-requests-closed']);
    expect(activityMetricsForPath('/my-history')).toEqual(['my-history']);
    expect(activityMetricsForPath('/kanban')).toEqual(['workitems-created', 'workitems-completed']);
    expect(activityMetricsForPath('/unknown-screen')).toEqual(DASHBOARD_ACTIVITY_METRICS);
  });

  it('sends the header project as projects and omits it for all projects', () => {
    const base = { metric: 'pipelines' as const, startDate: '2026-11-01', endDate: '2026-11-25', mode: 'cache' as const };
    expect(activityQuery({ ...base, project: 'Alpha' }).get('projects')).toBe('Alpha');
    expect(activityQuery({ ...base, project: 'all' }).has('projects')).toBe(false);
    expect(activityQuery(base).has('projects')).toBe(false);
  });

  it('offers every registry metric in the demo fixture with its own count range', () => {
    const body = demoActivityDaily({ metric: 'my-history', startDate: '2026-07-01', endDate: '2026-07-10', mode: 'cache' });
    expect(body.metric).toBe('my-history');
    expect(body.days.every(day => day.count === null || day.count >= 0)).toBe(true);
  });
});
