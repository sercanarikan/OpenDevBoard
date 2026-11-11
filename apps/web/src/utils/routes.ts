import type { ViewMode } from '../types';

export const ROUTE_PATH_MAP: Record<ViewMode, string> = {
  dashboard: '/dashboard',
  explorer: '/tasks',
  board: '/kanban',
  hierarchy: '/hierarchy',
  dependencies: '/dependencies',
  'pull-requests': '/pull-requests',
  pipelines: '/pipelines',
  deployments: '/deployments',
  'team-activity': '/team-activity',
  'my-history': '/my-history',
};

export const PATH_ROUTE_MAP: Record<string, ViewMode> = {
  '/dashboard': 'dashboard',
  '/tasks': 'explorer',
  '/kanban': 'board',
  '/hierarchy': 'hierarchy',
  '/dependencies': 'dependencies',
  '/pull-requests': 'pull-requests',
  '/pipelines': 'pipelines',
  '/deployments': 'deployments',
  '/team-activity': 'team-activity',
  '/my-history': 'my-history',
};

export function getPathForView(view: ViewMode, currentSearch?: string): string {
  const base = ROUTE_PATH_MAP[view] || '/dashboard';
  if (!currentSearch) return base;
  const cleanSearch = currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch;
  if (!cleanSearch) return base;

  // Preserve global params like 'project' across view navigation
  const params = new URLSearchParams(cleanSearch);
  const preserved = new URLSearchParams();
  const project = params.get('project');
  if (project && project !== 'all') {
    preserved.set('project', project);
  }
  const str = preserved.toString();
  return str ? `${base}?${str}` : base;
}

export function getViewFromPath(pathname: string): ViewMode | null {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/') return 'dashboard';
  return PATH_ROUTE_MAP[clean] || null;
}
