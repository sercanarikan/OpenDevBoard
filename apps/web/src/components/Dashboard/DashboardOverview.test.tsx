// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { DashboardOverview } from './DashboardOverview';
import { DateRangeProvider } from '../../context/DateRangeContext';

const mockApp = vi.hoisted(() => ({
  api: {},
  source: 'live',
  filters: { selectedProject: 'all' },
  dashboardFeedCache: {},
  setFilters: () => undefined,
  setViewMode: () => undefined,
  summary: null,
  prSummary: null,
  prSummaryLoading: false,
  prSummaryError: null,
  selectedPipelineRun: null,
  setSelectedPipelineRun: () => undefined,
  selectedDeployment: null,
  setSelectedDeployment: () => undefined,
  currentUserName: 'Ada',
  booting: true,
  refreshToken: 0,
  refreshData: async () => undefined,
  syncIndicator: null,
  selectedWorkItem: null,
  setSelectedWorkItem: () => undefined,
  selectedPR: null,
  setSelectedPR: () => undefined,
}));
vi.mock('../../context/useApp', () => ({ useApp: () => mockApp }));

async function html(lang: string) {
  await i18n.changeLanguage(lang);
  return renderToStaticMarkup(<MemoryRouter><DateRangeProvider><DashboardOverview /></DateRangeProvider></MemoryRouter>);
}

function card(markup: string, testId: string): string {
  const start = markup.indexOf(`data-testid="${testId}"`);
  expect(start, testId).toBeGreaterThan(-1);
  return markup.slice(start, start + 6000);
}

describe('DashboardOverview global range binding', () => {
  for (const [lang, live, period] of [['en', 'Current status', 'Last 30 days'], ['tr', 'Güncel durum', 'Son 30 gün']] as const) {
    it(`labels live cards and shows the applied period on period cards (${lang})`, async () => {
      const markup = await html(lang);
      for (const id of ['dash-card-my-tasks', 'dash-card-blocked', 'dash-card-pending-prs', 'dash-card-my-prs']) {
        expect(card(markup, id)).toContain(live);
      }
      for (const id of ['dash-pipeline-card', 'dash-deployment-card', 'dash-team-activity-card', 'dash-my-history-card']) {
        const body = card(markup, id);
        expect(body).toContain('data-testid="dash-period-label"');
        expect(body).toContain(period);
      }
    });
  }

  it('no longer renders the standalone activity card or its own metric select', async () => {
    const markup = await html('en');
    expect(markup).not.toContain('dash-activity-card');
    expect(markup).not.toContain('dash-activity-metric');
  });
});
