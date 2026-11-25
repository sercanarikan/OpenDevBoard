// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { PipelineExplorer } from './Pipelines/PipelineExplorer';
import { DeploymentExplorer } from './Deployments/DeploymentExplorer';
import { TeamActivityExplorer } from './TeamActivity/TeamActivityExplorer';
import { MyHistoryTimeline } from './MyHistory/MyHistoryTimeline';
import { advance, APRIL, cacheStatusOf, createScript, deferred, flush, jobOf, MARCH, mount, NOTICE_TEXT, rangeOfParams, type Reply } from '../test/pollingHarness';

const scripts = { pipelines: createScript(), deployments: createScript(), team: createScript(), history: createScript() };

const h = vi.hoisted(() => ({ app: {} as Record<string, unknown> }));
vi.mock('../context/useApp', () => ({ useApp: () => h.app }));

type Params = { days?: number; startDate?: string; endDate?: string };
const page = { limit: 25, offset: 0, hasMore: false };
const pipelineSummary = { periodDays: 30, totalPipelines: 1, totalRuns: 1, succeeded: 1, failed: 0, partiallySucceeded: 0, inProgress: 0, canceled: 0, successRate: 100, failedRuns: [], dailyStats: [] };
const deploymentSummary = { periodDays: 30, totalDeployments: 1, succeeded: 1, failed: 0, inProgress: 0, successRate: 100, environments: [], projects: [], dailyStats: [] };
const historySummary = { periodDays: 30, totalEvents: 1, completedWorkItems: 0, commitsCount: 1, prsCount: 0, reviewsCount: 0, projectsTouched: [], dailyHeatmap: [] };

h.app = {
  api: {
    pipelines: async (params: Params) => {
      const reply: Reply = await scripts.pipelines.next(rangeOfParams(params));
      return {
        ...page, total: 1, summary: pipelineSummary, job: jobOf(reply), cacheStatus: cacheStatusOf(reply),
        items: [{ id: 1, project: 'P', pipelineName: reply.marker, pipelineType: 'yaml', buildNumber: '1', status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', requestedBy: 'Ada', queueTime: '2025-03-02T00:00:00Z', durationSeconds: 10, url: '' }],
      };
    },
    deployments: async (params: Params) => {
      const reply: Reply = await scripts.deployments.next(rangeOfParams(params));
      return {
        ...page, total: 1, summary: deploymentSummary, job: jobOf(reply), cacheStatus: cacheStatusOf(reply), dataScope: 'all',
        items: [{ id: 1, project: 'P', releaseName: reply.marker, definitionName: 'D', environmentName: 'Prod', status: 'succeeded', attempt: 1, startedOn: '2025-03-02T00:00:00Z', durationSeconds: 10, requestedBy: 'Ada', url: '' }],
      };
    },
    teamActivitySummary: async (range: Params) => {
      const reply: Reply = await scripts.team.next(rangeOfParams(range));
      return {
        periodDays: 30, totalCommits: 1, totalPRs: 1, activeContributors: 1, dailyStats: [], repositories: [],
        contributors: [{ name: reply.marker, email: '', commitCount: 1, authoredPRs: 0, reviewsCount: 0, lastActivity: '' }],
        job: jobOf(reply), cacheStatus: cacheStatusOf(reply),
      };
    },
    teamCommits: async () => ({ ...page, items: [], total: 0 }),
    myHistorySummary: async () => historySummary,
    myHistoryTimeline: async (params: Params) => {
      const reply: Reply = await scripts.history.next(rangeOfParams(params));
      return {
        ...page, total: 1, job: jobOf(reply), cacheStatus: { outcome: 'complete', complete: true, stale: false, coverage: reply.coverage },
        items: [{ id: 'e1', eventType: 'commit', occurredAt: '2025-03-02T00:00:00Z', project: 'P', entity: { type: 'commit', id: 'c', title: 't' }, summary: reply.marker, actor: { displayName: 'Ada' } }],
      };
    },
  },
  filters: { selectedProject: 'all' },
  refreshToken: 0,
  selectedPipelineRun: null,
  setSelectedPipelineRun: () => undefined,
  selectedDeployment: null,
  setSelectedDeployment: () => undefined,
  selectedWorkItem: null,
  setSelectedWorkItem: () => undefined,
  selectedPR: null,
  setSelectedPR: () => undefined,
  currentUserName: 'Ada',
};

const SCREENS = [
  { name: 'Pipeline', key: 'pipelines' as const, element: <PipelineExplorer /> },
  { name: 'Deployment', key: 'deployments' as const, element: <DeploymentExplorer /> },
  { name: 'Team Activity', key: 'team' as const, element: <TeamActivityExplorer /> },
  { name: 'My History', key: 'history' as const, element: <MyHistoryTimeline /> },
];

beforeEach(() => { localStorage.clear(); for (const s of Object.values(scripts)) s.reset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe.each(SCREENS)('$name screen polling', ({ key, element }) => {
  const script = scripts[key];

  it('polls every 2000 ms while running and stops once done', async () => {
    await i18n.changeLanguage('en');
    script.plan(MARCH, { marker: 'M1', state: 'running' }, { marker: 'M2', state: 'running' }, { marker: 'M3', state: 'done' });
    const view = await mount(element, MARCH);
    await flush();
    const first = script.count(MARCH);
    expect(first).toBeGreaterThan(0);
    await advance(1999);
    expect(script.count(MARCH)).toBe(first);
    await advance(1);
    expect(script.count(MARCH)).toBe(first * 2);
    await advance(2000);
    expect(script.count(MARCH)).toBe(first * 3);
    await advance(10000);
    expect(script.count(MARCH)).toBe(first * 3);
    await view.unmount();
  });

  it('does not let a stale response for an older range overwrite the newer range', async () => {
    await i18n.changeLanguage('en');
    const old = deferred<Reply>();
    script.plan(MARCH, old.promise);
    script.plan(APRIL, { marker: 'NEWER', state: 'done' });
    const view = await mount(element, MARCH);
    await flush();
    await view.setRange(APRIL);
    await flush();
    expect(view.host.textContent).toContain('NEWER');
    old.resolve({ marker: 'STALE', state: 'done' });
    await flush();
    expect(view.host.textContent).toContain('NEWER');
    expect(view.host.textContent).not.toContain('STALE');
    await view.unmount();
  });

  for (const lang of ['en', 'tr'] as const) {
    for (const kind of ['partial', 'missing'] as const) {
      it(`shows the ${kind} coverage notice (${lang})`, async () => {
        await i18n.changeLanguage(lang);
        const coverage = { complete: 0, partial: kind === 'partial' ? 1 : 0, missing: kind === 'missing' ? 1 : 0 };
        script.plan(MARCH, { marker: 'M', state: 'done', coverage });
        const view = await mount(element, MARCH);
        await flush();
        expect(view.host.textContent).toContain(NOTICE_TEXT[lang][kind]);
        await view.unmount();
      });
    }
  }

  it('makes no polling request for a rolling range', async () => {
    await i18n.changeLanguage('en');
    script.plan({ kind: 'rolling', days: 30 } as never, { marker: 'R', state: 'running' });
    const view = await mount(element);
    await flush();
    const first = script.calls.length;
    expect(first).toBeGreaterThan(0);
    await advance(10000);
    expect(script.calls.length).toBe(first);
    await view.unmount();
  });
});
