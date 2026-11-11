import { describe, expect, it } from 'vitest';
import { demoApi } from './demoApi';
import { historyQuery, liveApi } from './liveApi';

describe('history request scope', () => {
  it('uses the same activity and search scope for summary counts and timeline totals', async () => {
    const allSummary = await demoApi.myHistorySummary(30, 'sample-catalog');
    const filteredSummary = await demoApi.myHistorySummary(30, 'sample-catalog', undefined, {
      activityType: 'pullRequest', search: 'token'
    });
    const filteredTimeline = await demoApi.myHistoryTimeline({
      project: 'sample-catalog', days: 30, activityType: 'pullRequest', search: 'token', limit: 25, offset: 0
    });
    expect(filteredSummary.totalEvents).toBeLessThan(allSummary.totalEvents);
    expect(filteredSummary.totalMatchingEvents).toBe(filteredTimeline.total);
  });

  it('serializes matching project, date, event-type and search scope without pagination on summary', async () => {
    const timeline = historyQuery({
      project: 'alms',
      days: 30,
      activityType: 'pullRequest',
      search: 'fix',
      limit: 25,
      offset: 25
    });
    expect(timeline.toString()).toBe('limit=25&offset=25&search=fix&project=alms&activityType=pullRequest&days=30');

    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ totalEvents: 0 }), { status: 200 });
    }) as typeof fetch;
    try {
      await liveApi.myHistorySummary(30, 'alms', undefined, { activityType: 'pullRequest', search: 'fix' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const summary = new URL(urls[0], 'http://localhost').searchParams;
    expect(summary.get('search')).toBe(timeline.get('search'));
    expect(summary.get('project')).toBe(timeline.get('project'));
    expect(summary.get('activityType')).toBe(timeline.get('activityType'));
    expect(summary.get('days')).toBe(timeline.get('days'));
    expect(summary.has('limit')).toBe(false);
    expect(summary.has('offset')).toBe(false);
  });
});
