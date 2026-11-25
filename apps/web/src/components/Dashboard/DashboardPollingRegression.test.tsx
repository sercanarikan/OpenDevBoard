// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { DashboardOverview } from './DashboardOverview';
import { advance, APRIL, cacheStatusOf, createScript, deferred, flush, jobOf, MARCH, mount, NOTICE_TEXT, rangeOfParams, type Reply } from '../../test/pollingHarness';

const scripts = { history: createScript(), team: createScript() };
const never = () => new Promise<never>(() => undefined);

const h = vi.hoisted(() => ({ app: {} as Record<string, unknown> }));
vi.mock('../../context/useApp', () => ({ useApp: () => h.app }));

const empty = { items: [], total: 0, limit: 5, offset: 0, hasMore: false };
h.app = {
  api: {
    list: async () => empty,
    pullRequests: async () => empty,
    deploymentsSummary: never,
    pipelinesSummary: never,
    item: never,
    myHistoryTimeline: async (params: { days?: number; startDate?: string; endDate?: string }) => {
      const reply: Reply = await scripts.history.next(rangeOfParams(params));
      return {
        ...empty,
        items: [{ id: reply.marker, eventType: 'commit', occurredAt: '2025-03-02T00:00:00Z', project: 'P', entity: { type: 'commit', id: 'c', title: 't' }, summary: reply.marker, actor: { displayName: 'Ada' } }],
        total: 1,
        job: jobOf(reply),
        cacheStatus: { outcome: 'complete', complete: true, stale: false, coverage: reply.coverage },
      };
    },
    teamActivitySummary: async (range: { days?: number; startDate?: string; endDate?: string }) => {
      const reply: Reply = await scripts.team.next(rangeOfParams(range));
      return {
        periodDays: 30, totalCommits: 1, totalPRs: 1, activeContributors: 1, dailyStats: [], repositories: [],
        contributors: [{ name: reply.marker, email: '', commitCount: 1, authoredPRs: 0, reviewsCount: 0, lastActivity: '' }],
        job: jobOf(reply),
        cacheStatus: cacheStatusOf(reply),
      };
    },
  },
  source: 'live',
  filters: { selectedProject: 'all' },
  dashboardFeedCache: {},
  setFilters: () => undefined,
  setViewMode: () => undefined,
  summary: null,
  prSummary: null,
  prSummaryLoading: false,
  prSummaryError: null,
  pipelineSummary: null,
  pipelineSummaryLoading: false,
  pipelineSummaryError: null,
  pipelineJob: null,
  pipelineCoverage: null,
  selectedPipelineRun: null,
  setSelectedPipelineRun: () => undefined,
  selectedDeployment: null,
  setSelectedDeployment: () => undefined,
  currentUserName: 'Ada',
  booting: false,
  refreshToken: 0,
  refreshData: async () => undefined,
  syncIndicator: null,
  selectedWorkItem: null,
  setSelectedWorkItem: () => undefined,
  selectedPR: null,
  setSelectedPR: () => undefined,
};

const element = <MemoryRouter><DashboardOverview /></MemoryRouter>;
const CARDS = [
  { name: 'Team Activity card', testId: 'dash-team-activity-card', key: 'team' as const },
  { name: 'My History card', testId: 'dash-my-history-card', key: 'history' as const },
] as const;

beforeEach(() => { localStorage.clear(); scripts.history.reset(); scripts.team.reset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

const cardText = (host: HTMLElement, testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';

describe.each(CARDS)('Dashboard $name polling', ({ testId, key }) => {
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
    expect(cardText(view.host, testId)).toContain('NEWER');
    old.resolve({ marker: 'STALE', state: 'done' });
    await flush();
    expect(cardText(view.host, testId)).toContain('NEWER');
    expect(cardText(view.host, testId)).not.toContain('STALE');
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
        expect(cardText(view.host, testId)).toContain(NOTICE_TEXT[lang][kind]);
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
