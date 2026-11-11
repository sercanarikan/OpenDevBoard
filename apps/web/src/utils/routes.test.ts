import { describe, expect, it } from 'vitest';
import { getPathForView, getViewFromPath, PATH_ROUTE_MAP } from './routes';

describe('route contract', () => {
  it('defines exactly one stable route for each lazy-loaded view', () => {
    const expected = [
      ['/dashboard', 'dashboard'], ['/tasks', 'explorer'], ['/kanban', 'board'],
      ['/hierarchy', 'hierarchy'], ['/dependencies', 'dependencies'],
      ['/pull-requests', 'pull-requests'], ['/pipelines', 'pipelines'],
      ['/deployments', 'deployments'], ['/team-activity', 'team-activity'],
      ['/my-history', 'my-history'],
    ];
    expect(Object.entries(PATH_ROUTE_MAP)).toEqual(expected);
  });

  it('maps all ten views to stable paths', () => {
    expect(Object.values(PATH_ROUTE_MAP)).toHaveLength(10);
    expect(getPathForView('pull-requests')).toBe('/pull-requests');
    expect(getPathForView('explorer')).toBe('/tasks');
  });

  it('maps root and trailing slash paths and rejects unknown paths', () => {
    expect(getViewFromPath('/')).toBe('dashboard');
    expect(getViewFromPath('/pipelines/')).toBe('pipelines');
    expect(getViewFromPath('/not-a-page')).toBeNull();
  });

  it('preserves only project scope when switching views', () => {
    expect(getPathForView('explorer', '?project=alms&status=active')).toBe('/tasks?project=alms');
    expect(getPathForView('explorer', '?project=all&status=active')).toBe('/tasks');
  });
});
