import { describe, expect, it } from 'vitest';
import type { HistoryEvent } from '../../types/paging';
import { groupTimelineEvents } from './timelineGroups';

function event(id: string, occurredAt: string): HistoryEvent {
  return { id, occurredAt, eventType: 'git.commit', project: 'fixture', summary: id,
    entity: { type: 'commit', id, title: id }, actor: { displayName: 'Fixture' } };
}

describe('history timeline grouping', () => {
  it('preserves UTC day groups, the inclusive seven-day boundary and event order', () => {
    const events = [event('today', '2026-11-12T00:01:00Z'), event('yesterday', '2026-11-11T23:59:59Z'),
      event('boundary', '2026-11-05T12:00:00Z'), event('inside', '2026-11-06T12:00:00Z'),
      event('before', '2026-11-05T11:59:59Z'), event('missing', ''), event('invalid', 'invalid')];
    const groups = groupTimelineEvents(events, Date.parse('2026-11-12T12:00:00Z'));
    expect(groups.today.map(e => e.id)).toEqual(['today']);
    expect(groups.yesterday.map(e => e.id)).toEqual(['yesterday']);
    expect(groups.thisWeek.map(e => e.id)).toEqual(['boundary', 'inside']);
    expect(groups.earlier.map(e => e.id)).toEqual(['before', 'missing', 'invalid']);
  });

  it('reclassifies the same events when a later snapshot is received', () => {
    const events = [event('item', '2026-11-11T23:00:00Z')];
    expect(groupTimelineEvents(events, Date.parse('2026-11-11T23:30:00Z')).today).toEqual(events);
    expect(groupTimelineEvents(events, Date.parse('2026-11-12T00:30:00Z')).yesterday).toEqual(events);
  });
});
