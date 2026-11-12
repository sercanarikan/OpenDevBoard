import type { HistoryEvent } from '../../types/paging';

export function groupTimelineEvents(events: HistoryEvent[], asOf: number) {
  const now = new Date(asOf);
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(asOf - 86400000).toISOString().slice(0, 10);
  const weekAgo = new Date(asOf - 7 * 86400000);
  const groups: Record<'today' | 'yesterday' | 'thisWeek' | 'earlier', HistoryEvent[]> = {
    today: [], yesterday: [], thisWeek: [], earlier: []
  };

  for (const ev of events) {
    if (!ev.occurredAt) {
      groups.earlier.push(ev);
    } else if (ev.occurredAt.slice(0, 10) === todayStr) {
      groups.today.push(ev);
    } else if (ev.occurredAt.slice(0, 10) === yesterdayStr) {
      groups.yesterday.push(ev);
    } else if (new Date(ev.occurredAt) >= weekAgo) {
      groups.thisWeek.push(ev);
    } else {
      groups.earlier.push(ev);
    }
  }
  return groups;
}
