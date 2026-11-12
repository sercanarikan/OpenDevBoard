// Controlled synthetic responses ignore abort to exercise both stages of each request.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
let total = 0;
let passed = 0;
function check(name, value) {
  total++;
  if (value) passed++;
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
  if (!value) throw new Error(name);
}

async function exercise({ path, prefix, summaryPath, listPath }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(paths => {
      const realFetch = window.fetch.bind(window);
      window.pending = { summary: [], list: [] };
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const kind = url.pathname === paths.summaryPath ? 'summary' : url.pathname === paths.listPath ? 'list' : null;
        if (!kind) return realFetch(input, init);
        return new Promise(resolve => window.pending[kind].push({ resolve, signal: init?.signal }));
      };
      window.answer = (kind, index, status, body) => window.pending[kind][index].resolve(
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      );
    }, { summaryPath, listPath });
    const wait = (kind, n) => page.waitForFunction(({ kind, n }) => window.pending[kind].length >= n, { kind, n });
    const answer = (kind, index, status, body) => page.evaluate(x => window.answer(x.kind, x.index, x.status, x.body), { kind, index, status, body });
    const summary = n => prefix === 'history'
      ? { periodDays: 30, totalEvents: n, totalMatchingEvents: 1, completedWorkItems: 0, commitsCount: 1, prsCount: 0, reviewsCount: 0, projectsTouched: [], dailyHeatmap: [] }
      : { periodDays: 30, totalCommits: n, totalPRs: 0, activeContributors: 0, dailyStats: [], contributors: [], repositories: [] };
    const list = id => ({ items: prefix === 'history'
      ? [{ id: `event-${id}`, eventType: 'git.commit', occurredAt: '2026-11-11T23:00:00Z', project: 'Fixture', entity: { type: 'commit', id, title: `Event ${id}` }, summary: `Event ${id}`, actor: { displayName: 'Fixture' } }]
      : [{ commitId: `commit${id}`, project: 'Fixture', repository: 'Fixture', author: 'Fixture', date: '', comment: `Commit ${id}` }], total: 1, limit: 25, offset: 0, hasMore: false });
    const refresh = () => page.getByTitle('Yenile', { exact: true }).last().click();
    const showItem = id => prefix === 'history' ? page.getByTestId('history-event-card').filter({ hasText: `Event ${id}` }) : page.getByTestId('commits-view').getByText(`Commit ${id}`, { exact: true });
    await page.goto(`${process.env.WEB_URL}${path}`, { waitUntil: 'domcontentloaded' });
    await wait('summary', 1);
    check(`${prefix}: initial loading`, await page.getByTestId(`${prefix}-loading`).isVisible());
    await answer('summary', 0, 200, summary(314));
    await wait('list', 1);
    if (prefix === 'team') check('team: partial summary visible while list is pending', await page.getByText('314', { exact: true }).isVisible());
    await answer('list', 0, 500, { error: 'Synthetic list failure' });
    const error = page.getByTestId(`${prefix}-error`);
    await error.waitFor();
    check(`${prefix}: list error and partial summary visible`, (await error.innerText()).includes('Synthetic list failure') && await page.getByText('314', { exact: true }).isVisible());
    await error.getByRole('button', { name: 'Tekrar Dene' }).click();
    await wait('summary', 2);
    await answer('summary', 1, 200, summary(315));
    await wait('list', 2);
    await answer('list', 1, 200, list(1));
    if (prefix === 'team') await page.getByTestId('tab-commits').click();
    await showItem(1).waitFor();
    check(`${prefix}: retry succeeds`, await showItem(1).isVisible());
    await refresh();
    await wait('summary', 3);
    await refresh();
    await wait('summary', 4);
    check(`${prefix}: superseded summary aborted`, await page.evaluate(() => window.pending.summary[2].signal.aborted));
    await answer('summary', 3, 200, summary(316));
    await wait('list', 3);
    await answer('list', 2, 200, list(3));
    await showItem(3).waitFor();
    await answer('summary', 2, 200, summary(999));
    await page.waitForTimeout(150);
    check(`${prefix}: stale summary does not start a list or replace current data`, await page.evaluate(() => window.pending.list.length === 3) && await page.getByText('999', { exact: true }).count() === 0 && await showItem(3).isVisible());
    await refresh();
    await wait('summary', 5);
    await answer('summary', 4, 200, summary(317));
    await wait('list', 4);
    await refresh();
    await wait('summary', 6);
    await answer('summary', 5, 200, summary(318));
    await wait('list', 5);
    await answer('list', 4, 200, list(5));
    await showItem(5).waitFor();
    await answer('list', 3, 200, list(4));
    await page.waitForTimeout(150);
    check(`${prefix}: stale list cannot overwrite newest list`, await showItem(5).isVisible() && await showItem(4).count() === 0);
    await refresh();
    await wait('summary', 7);
    await page.getByTestId('nav-explorer').click();
    await page.waitForURL('**/tasks');
    await page.waitForFunction(() => window.pending.summary[6].signal.aborted, null, { timeout: 10000 });
    check(`${prefix}: unmount aborts pending request`, await page.evaluate(() => window.pending.summary[6].signal.aborted));
    await answer('summary', 6, 200, summary(999));
    await page.waitForTimeout(150);
    check(`${prefix}: unmounted request does not start list or raise page error`, await page.evaluate(() => window.pending.list.length === 5) && errors.length === 0);
  } catch (error) {
    console.error(error);
    if (!total || passed === total) total++;
  } finally {
    await page.close();
  }
}

try {
  await exercise({ path: '/my-history', prefix: 'history', summaryPath: '/api/my-history/summary', listPath: '/api/my-history/timeline' });
  await exercise({ path: '/team-activity', prefix: 'team', summaryPath: '/api/team-activity/summary', listPath: '/api/team-activity/commits' });
} finally {
  await browser.close();
}
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
