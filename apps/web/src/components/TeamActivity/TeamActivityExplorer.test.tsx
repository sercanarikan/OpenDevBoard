// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { TeamActivityExplorer } from './TeamActivityExplorer';
import { DateRangeProvider } from '../../context/DateRangeContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockApp = vi.hoisted(() => ({
  api: {
    teamActivitySummary: async () => ({
      periodDays: 30, project: 'all', repository: 'all', totalCommits: 0, totalPRs: 0, activeContributors: 2,
      dailyStats: [], repositories: [],
      contributors: [
        { name: 'Low', email: '', commitCount: 0, authoredPRs: 0, reviewsCount: 1, reviewerAssignments: 1, reviewVotesCount: 0, lastActivity: '' },
        { name: 'High', email: '', commitCount: 0, authoredPRs: 0, reviewsCount: 5, reviewerAssignments: 5, reviewVotesCount: 1, lastActivity: '' },
      ],
    }),
    teamCommits: async () => ({ items: [], total: 0 }),
  },
  filters: { selectedProject: 'all' },
  refreshToken: 0,
}));
vi.mock('../../context/useApp', () => ({ useApp: () => mockApp }));

async function render() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<DateRangeProvider><TeamActivityExplorer /></DateRangeProvider>); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { host, root };
}

describe('TeamActivityExplorer reviewer assignment label', () => {
  for (const [lang, label, stale] of [
    ['en', 'PRs assigned as reviewer', 'Reviews'],
    ['tr', 'Reviewer olarak atandığı PR', 'İnceleme'],
  ] as const) {
    it(`renders the assignment label and sorts by reviewerAssignments in ${lang}`, async () => {
      await i18n.changeLanguage(lang);
      const { host, root } = await render();
      const headers = Array.from(host.querySelectorAll('th')).map(th => th.textContent ?? '');
      const header = Array.from(host.querySelectorAll('th')).find(th => (th.textContent ?? '').includes(label));
      expect(header, `${lang} header`).toBeTruthy();
      expect(headers.some(h => h.trim() === stale)).toBe(false);
      await act(async () => { header!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const rows = () => Array.from(host.querySelectorAll('tbody tr')).map(tr => tr.textContent ?? '');
      expect(rows()[0]).toContain('Low'); // first click toggles the order to ascending
      await act(async () => { header!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(rows()[0]).toContain('High');
      await act(async () => { root.unmount(); });
      host.remove();
    });
  }
});
