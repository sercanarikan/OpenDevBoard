// Dashboard request lifecycle checks against the isolated synthetic fixture stack.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
let total = 0;
let passed = 0;
function check(name, value) {
  total++;
  if (value) passed++;
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
}

async function makePage() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.pending = { me: [], priority: [], recent: [], pr: [], history: [], team: [] };
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/sync') return Promise.resolve(new Response(JSON.stringify({ status: 'success', fixture: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      let kind = null;
      if (url.pathname === '/api/me') kind = 'me';
      if (url.pathname === '/api/work-items' && url.searchParams.get('limit') === '5' && url.searchParams.get('sortBy') === 'priority') kind = 'priority';
      if (url.pathname === '/api/work-items' && url.searchParams.get('limit') === '5' && url.searchParams.get('sortBy') === 'changedDate') kind = 'recent';
      if (url.pathname === '/api/pull-requests' && url.searchParams.get('limit') === '5') kind = 'pr';
      if (url.pathname === '/api/my-history/timeline' && url.searchParams.get('limit') === '5') kind = 'history';
      if (url.pathname === '/api/team-activity/summary' && url.searchParams.get('days') === '7') kind = 'team';
      if (!kind) return originalFetch(input, init);
      return new Promise(resolve => window.pending[kind].push({ resolve, signal: init?.signal }));
    };
    window.answer = (kind, index, status, body) => window.pending[kind][index].resolve(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    );
  });
  return { page, errors };
}

const item = (id, title) => ({ id, title, type: 'Task', state: 'Active', project: 'Fixture', priority: 1, changedDate: '', assignedTo: 'Fixture', relations: { predecessors: [], successors: [], related: [], total: 0 }, children: [] });
const list = items => ({ items, total: items.length, limit: 5, offset: 0, hasMore: false });
const pr = id => ({ id, title: `PR ${id}`, repository: 'Fixture', authorName: 'Fixture', project: 'Fixture', status: 'active', reviewers: [] });
const event = id => ({ id: `event-${id}`, eventType: 'git.commit', occurredAt: '', project: 'Fixture', entity: { type: 'commit', id, title: `Event ${id}` }, summary: `Event ${id}`, actor: { displayName: 'Fixture' } });
const team = n => ({ periodDays: 7, totalCommits: n, totalPRs: 0, activeContributors: 0, contributors: [], repositories: [], dailyStats: [] });

async function exercise() {
  const { page, errors } = await makePage();
  const wait = (kind, n) => page.waitForFunction(({ kind, n }) => window.pending[kind].length >= n, { kind, n });
  const answer = (kind, index, status, body) => page.evaluate(x => window.answer(x.kind, x.index, x.status, x.body), { kind, index, status, body });
  const refresh = () => page.getByTitle('Yenile', { exact: true }).last().click();
  try {
    await page.goto(`${process.env.WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await wait('me', 1);
    await page.waitForTimeout(150);
    check('booting starts no dashboard requests', await page.evaluate(() => ['priority', 'pr', 'history', 'team'].every(k => window.pending[k].length === 0)));
    await answer('me', 0, 200, { displayName: 'Fixture', source: 'fixture' });
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 1)));
    await page.waitForTimeout(150);
    check('boot completion starts one request per independent group', await page.evaluate(() => ['priority', 'pr', 'history', 'team'].every(k => window.pending[k].length === 1) && window.pending.recent.length === 0));
    await answer('priority', 0, 200, list([item(101, 'Priority 101')]));
    await wait('recent', 1);
    await answer('recent', 0, 200, list([item(102, 'Recent 102')]));
    await answer('pr', 0, 200, list([pr(201)]));
    await answer('history', 0, 200, list([event(301)]));
    await answer('team', 0, 500, { error: 'Team failure' });
    await page.getByText('Priority 101', { exact: true }).waitFor();
    await page.getByText('Event 301', { exact: true }).waitFor();
    check('one group failing leaves other successful groups visible', await page.getByText('Recent 102', { exact: true }).isVisible() && await page.getByText('PR 201', { exact: true }).isVisible() && await page.getByTestId('dash-team-activity-card').getByText('Henüz ekip aktivitesi bulunmuyor.').isVisible());

    await refresh();
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 2)));
    check('refresh retains prior successful data while pending', await page.getByText('Priority 101', { exact: true }).isVisible() && await page.getByText('Recent 102', { exact: true }).isVisible() && await page.getByText('PR 201', { exact: true }).isVisible() && await page.getByText('Event 301', { exact: true }).isVisible());
    await refresh();
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 3)));
    check('superseded parallel requests are aborted', await page.evaluate(() => ['priority', 'pr', 'history', 'team'].every(k => window.pending[k][1].signal.aborted)));
    await answer('priority', 2, 200, list([item(103, 'Priority 103')]));
    await wait('recent', 2);
    await answer('recent', 1, 200, list([item(104, 'Recent 104')]));
    await answer('pr', 2, 200, list([pr(203)]));
    await answer('history', 2, 200, list([event(303)]));
    await answer('team', 2, 200, team(43));
    await page.getByText('Recent 104', { exact: true }).waitFor();
    await answer('priority', 1, 200, list([item(999, 'Stale priority')]));
    await answer('pr', 1, 500, { error: 'Stale PR failure' });
    await answer('history', 1, 200, list([event(999)]));
    await answer('team', 1, 200, team(999));
    await page.waitForTimeout(150);
    check('late successes and errors cannot overwrite newer groups', await page.getByText('Priority 103', { exact: true }).isVisible() && await page.getByText('PR 203', { exact: true }).isVisible() && await page.getByText('Event 303', { exact: true }).isVisible() && await page.getByText('Stale PR failure').count() === 0 && await page.getByTestId('dash-team-activity-card').getByText('43', { exact: true }).isVisible() && await page.evaluate(() => window.pending.recent.length === 2));

    await refresh();
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 4)));
    await answer('priority', 3, 500, { error: 'Priority failure' });
    await answer('pr', 3, 200, list([pr(204)]));
    await answer('history', 3, 200, list([event(304)]));
    await answer('team', 3, 200, team(44));
    await page.getByText('Priority failure', { exact: true }).waitFor();
    check('first task stage failure does not start second or block other groups', await page.evaluate(() => window.pending.recent.length === 2) && await page.getByText('PR 204', { exact: true }).isVisible() && await page.getByText('Event 304', { exact: true }).isVisible());
    await refresh();
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 5)));
    await answer('priority', 4, 200, list([item(105, 'Priority 105')]));
    await wait('recent', 3);
    await answer('recent', 2, 500, { error: 'Recent failure' });
    await answer('pr', 4, 200, list([pr(205)]));
    await answer('history', 4, 200, list([event(305)]));
    await answer('team', 4, 200, team(45));
    await page.getByText('Recent failure', { exact: true }).waitFor();
    check('second task stage failure does not block other groups', await page.getByText('PR 205', { exact: true }).isVisible() && await page.getByText('Event 305', { exact: true }).isVisible());
    await refresh();
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 6)));
    await answer('priority', 5, 200, list([item(106, 'Priority 106')]));
    await wait('recent', 4);
    await refresh();
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 7)));
    await answer('priority', 6, 200, list([item(107, 'Priority 107')]));
    await wait('recent', 5);
    await answer('recent', 4, 200, list([item(108, 'Recent 108')]));
    await answer('pr', 6, 200, list([pr(207)]));
    await answer('history', 6, 200, list([event(307)]));
    await answer('team', 6, 200, team(47));
    await page.getByText('Recent 108', { exact: true }).waitFor();
    await answer('recent', 3, 200, list([item(999, 'Stale recent')]));
    await answer('pr', 5, 200, list([pr(999)]));
    await answer('history', 5, 500, { error: 'Stale history failure' });
    await answer('team', 5, 500, { error: 'Stale team failure' });
    await page.waitForTimeout(150);
    check('late second task stage and parallel errors cannot replace latest data', await page.getByText('Recent 108', { exact: true }).isVisible() && await page.getByText('Priority 107', { exact: true }).isVisible() && await page.getByText('PR 207', { exact: true }).isVisible() && await page.getByText('Event 307', { exact: true }).isVisible() && await page.getByTestId('dash-team-activity-card').getByText('47', { exact: true }).isVisible());

    await page.getByTestId('sync-now').click();
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 8)));
    await page.waitForTimeout(200);
    check('refreshToken starts exactly one request per group', await page.evaluate(() => ['priority', 'pr', 'history', 'team'].every(k => window.pending[k].length === 8)));
    await answer('priority', 7, 200, list([item(109, 'Priority 109')]));
    await wait('recent', 6);
    await answer('recent', 5, 200, list([item(110, 'Recent 110')]));
    await answer('pr', 7, 200, list([pr(208)]));
    await answer('history', 7, 200, list([event(308)]));
    await answer('team', 7, 200, team(48));
    await page.getByText('Recent 110', { exact: true }).waitFor();
    const projectSelect = page.getByTestId('header').locator('select').first();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="header"] select option')].some(option => option.value !== 'all'));
    const project = await projectSelect.locator('option').evaluateAll(options => options.find(option => option.value !== 'all')?.value);
    await projectSelect.selectOption(project);
    await Promise.all(['priority', 'pr', 'history', 'team'].map(k => wait(k, 9)));
    check('project change hides previous scope while new data is pending', await page.getByText('Priority 109', { exact: true }).count() === 0 && await page.getByText('Recent 110', { exact: true }).count() === 0 && await page.getByText('PR 208', { exact: true }).count() === 0 && await page.getByText('Event 308', { exact: true }).count() === 0);
    await page.getByTestId('nav-explorer').click();
    await page.waitForURL(url => url.pathname === '/tasks');
    await page.waitForFunction(() => ['priority', 'pr', 'history', 'team'].every(k => window.pending[k][8].signal.aborted), null, { timeout: 10000 });
    check('unmount aborts all dashboard groups', true);
    await answer('priority', 8, 200, list([item(999, 'Unmounted')]));
    await answer('pr', 8, 500, { error: 'Unmounted failure' });
    await answer('history', 8, 200, list([event(999)]));
    await answer('team', 8, 200, team(999));
    await page.waitForTimeout(150);
    check('unmounted responses do not start another task stage or raise errors', await page.evaluate(() => window.pending.recent.length === 6) && errors.length === 0);
  } catch (error) {
    console.error(error);
    total++;
  } finally {
    await page.close();
  }
}

async function noUser() {
  const { page } = await makePage();
  try {
    await page.goto(`${process.env.WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.pending.me.length > 0);
    await page.evaluate(() => window.answer('me', 0, 200, { displayName: '', source: 'fixture' }));
    await page.waitForFunction(() => window.pending.pr.length > 0);
    await page.waitForTimeout(200);
    const priorityPanel = page.getByRole('heading', { name: 'Öncelikli Görevlerim' }).locator('xpath=../../..');
    check('missing user starts no task requests and does not leave task loading indefinitely', await page.evaluate(() => window.pending.priority.length === 0 && window.pending.recent.length === 0) && await priorityPanel.locator('.animate-spin').count() === 0);
    check('missing user shows an unknown task state', await priorityPanel.getByText('—', { exact: true }).isVisible());
    check('missing user keeps personal task count unknown', (await page.getByTestId('dash-card-my-tasks').innerText()).includes('—'));
  } catch (error) {
    console.error(error);
    total++;
  } finally {
    await page.close();
  }
}

try { await exercise(); await noUser(); } finally { await browser.close(); }
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
