import type { WorkItem } from '../types';
import type { HistoryEvent, PullRequest, TeamActivitySummary } from '../types/paging';

/**
 * Last successful result of each dashboard card that loads its own data. It lives in the app context, so it
 * outlives the dashboard page: coming back shows the previous result at once while the card refreshes quietly.
 * Every entry remembers the scope it was loaded for and is only reused for that exact scope.
 */
export interface DashboardFeedCache {
  tasks?: { scope: string; priority: WorkItem[]; recent: WorkItem[] };
  prs?: { scope: string; items: PullRequest[] };
  history?: { scope: string; items: HistoryEvent[] };
  team?: { scope: string; snapshot: TeamActivitySummary };
}

export function taskFeedScope(project: string, user: string): string {
  return JSON.stringify([project, user]);
}

/** The cached entry of one card, or undefined when it was loaded for a different scope. */
export function seedFor<K extends keyof DashboardFeedCache>(
  cache: DashboardFeedCache, key: K, scope: string
): DashboardFeedCache[K] | undefined {
  const entry = cache[key];
  return entry && entry.scope === scope ? entry : undefined;
}
