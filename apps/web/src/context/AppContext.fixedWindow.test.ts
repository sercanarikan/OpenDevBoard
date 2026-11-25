import { describe, expect, it } from 'vitest';
import appContextSource from './AppContext.tsx?raw';
import sidebarSource from '../components/Layout/Sidebar.tsx?raw';
import dashboardSource from '../components/Dashboard/DashboardOverview.tsx?raw';
import appSource from '../App.tsx?raw';

// Metric Registry review: temporal queries use the global range; AppContext keeps no fixed 30-day window.
describe('AppContext fixed-window queries', () => {
  it('does not request a hardcoded 30-day pipeline or deployment window', () => {
    expect(appContextSource).not.toMatch(/pipelinesSummary\(\s*30/);
    expect(appContextSource).not.toMatch(/deploymentsSummary\(/);
    expect(appContextSource).toMatch(/pipelinesSummary\(rangeQuery/);
  });

  it('mounts the date range above AppProvider so the context can read it', () => {
    expect(appSource.indexOf('<DateRangeProvider>')).toBeGreaterThan(-1);
    expect(appSource.indexOf('<DateRangeProvider>')).toBeLessThan(appSource.indexOf('<AppProvider>'));
  });

  it('feeds the dashboard pipeline card from the shared pipeline request instead of a second fetch', () => {
    expect(dashboardSource).not.toMatch(/api\.pipelinesSummary/);
  });

  it('labels the sidebar failed-pipeline badge as a period count', () => {
    expect(sidebarSource).toMatch(/failedRunsPeriod/);
  });

  it('fetches dashboard team and history cards through the cache job hook', () => {
    expect(dashboardSource).not.toMatch(/api\.teamActivitySummary\(rangeQuery, project, ctrl\.signal\)/);
    expect(dashboardSource).toMatch(/useCacheJob[^\n]*team:/);
    expect(dashboardSource).toMatch(/useCacheJob[^\n]*history:/);
  });
});
