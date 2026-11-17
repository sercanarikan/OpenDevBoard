import type { PRQuickFilter } from '../types/paging';
import { ROUTE_PATH_MAP } from './routes';

const PR_FILTERS: readonly PRQuickFilter[] = ['needs-my-review', 'created-by-me', 'involved', 'all'];

/** Reads the Pull Requests tab requested by the link that opened the page; anything unknown falls back to the default tab. */
export function parsePRFilter(search: string): PRQuickFilter {
  const value = new URLSearchParams(search).get('prFilter');
  return PR_FILTERS.find(f => f === value) ?? 'needs-my-review';
}

/** Pull Requests URL that opens a specific tab, keeping the selected project. */
export function pullRequestsPath(filter: PRQuickFilter, project?: string): string {
  const params = new URLSearchParams();
  if (project && project !== 'all') params.set('project', project);
  params.set('prFilter', filter);
  return `${ROUTE_PATH_MAP['pull-requests']}?${params.toString()}`;
}
