import { describe, expect, it } from 'vitest';
import { demoApi, filterDemoByRange, rangeFromParams } from './demoApi';
import { customSelection, presetSelection, toApiRange } from './dateRange';

// Demo data is pinned to 2026-11-05/06 and rolling windows are anchored to 2026-11-07 (see demoApi).
const TODAY = '2026-11-07';

describe('demo date ranges follow the real selected dates', () => {
  it('selects different records for equal-length ranges that cover different days', async () => {
    const first = await demoApi.myHistoryTimeline({ startDate: '2026-11-05', endDate: '2026-11-05' } as never);
    const second = await demoApi.myHistoryTimeline({ startDate: '2026-11-06', endDate: '2026-11-06' } as never);
    expect(first.total).toBeGreaterThan(0);
    expect(second.total).toBeGreaterThan(0);
    expect(first.items.map(i => i.id)).not.toEqual(second.items.map(i => i.id));
    expect(first.items.every(i => i.occurredAt.startsWith('2026-11-05'))).toBe(true);
    expect(second.items.every(i => i.occurredAt.startsWith('2026-11-06'))).toBe(true);
  });

  it('keeps list totals and summary totals on the same calendar window', async () => {
    const range = { startDate: '2026-11-05', endDate: '2026-11-06' };
    const list = await demoApi.deployments({ startDate: range.startDate, endDate: range.endDate, limit: 100 } as never);
    const summary = await demoApi.deploymentsSummary(range);
    expect(summary.totalDeployments).toBe(list.total);
    const pipelines = await demoApi.pipelines({ startDate: range.startDate, endDate: range.endDate, limit: 100 } as never);
    const pipelineSummary = await demoApi.pipelinesSummary(range);
    expect(pipelineSummary.totalRuns).toBe(pipelines.total);
  });

  it('excludes a day outside a calendar range even when the day count matches the rolling preset', async () => {
    const calendar = await demoApi.teamActivitySummary({ startDate: '2026-10-01', endDate: '2026-10-07' });
    const rolling = await demoApi.teamActivitySummary(7);
    expect(calendar.totalCommits).toBe(0);
    expect(rolling.totalCommits).toBeGreaterThan(0);
  });

  it('applies rolling presets against the fixed demo reference day', async () => {
    const last7 = await demoApi.pipelinesSummary(7);
    expect(last7.totalRuns).toBeGreaterThan(0);
    expect(toApiRange(presetSelection('last7', TODAY))).toEqual({ days: 7 });
  });

  it('keeps the calendar range selected in the UI as the API range', () => {
    const selection = customSelection('2026-11-01', '2026-11-06');
    expect(toApiRange(selection)).toEqual({ startDate: '2026-11-01', endDate: '2026-11-06' });
    expect(rangeFromParams({ days: 30, startDate: '2026-11-01', endDate: '2026-11-06' })).toEqual({
      startDate: '2026-11-01',
      endDate: '2026-11-06'
    });
  });

  it('drops records without a timestamp for calendar ranges', () => {
    const kept = filterDemoByRange([{ d: '2026-11-05T10:00:00Z' }, { d: undefined }], { startDate: '2026-11-05', endDate: '2026-11-05' }, x => x.d);
    expect(kept).toHaveLength(1);
  });
});
