// Dashboard Pipeline / Deployment / Team Activity cards against the isolated synthetic fixture stack.
// Card summaries are answered by synthetic routes so each card's latency and outcome is controlled independently.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const WEB = process.env.WEB_URL;
const CONTAINER = process.env.E2E_API_CONTAINER;
const browser = await chromium.launch({ headless: true });
let total = 0;
let passed = 0;
function check(name, value) {
  total++;
  if (value) passed++;
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
}

const pipelineBody = (over = {}) => ({ periodDays: 30, totalPipelines: 1, totalRuns: 2, succeeded: 2, failed: 0, partiallySucceeded: 0, inProgress: 0, canceled: 0, successRate: 100, failedRuns: [], dailyStats: [], cacheStatus: { outcome: 'partial', complete: false, stale: false }, ...over });
const deploymentBody = (over = {}) => ({ periodDays: 30, totalDeployments: 1, succeeded: 1, failed: 0, inProgress: 0, successRate: 100, environments: [], dailyStats: [], cacheStatus: { outcome: 'complete', complete: true, stale: false }, ...over });
const teamBody = (commits, over = {}) => ({ periodDays: 7, totalCommits: commits, totalPRs: 0, activeContributors: 0, contributors: [], repositories: [], dailyStats: [], cacheStatus: { outcome: 'complete', complete: true, stale: false }, ...over });

/** Answers a summary route immediately ('auto') or keeps the requests pending ('hold') until they are released. */
function controlled(page, pattern, body) {
  const c = { mode: 'auto', body, status: 200, held: [], hits: 0 };
  page.route(pattern, route => {
    c.hits++;
    if (c.mode === 'hold') c.held.push(route);
    else route.fulfill({ status: c.status, json: c.body });
  });
  c.release = async (index, json = c.body, status = 200) => { try { await c.held[index].fulfill({ status, json }); } catch { /* request was superseded */ } };
  return c;
}

async function open(options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (options.clock) await page.clock.install();
  const c = {
    pipeline: controlled(page, '**/api/pipelines/summary?*', pipelineBody()),
    deployment: controlled(page, '**/api/deployments/summary?*', deploymentBody()),
    team: controlled(page, '**/api/team-activity/summary?*', teamBody(42))
  };
  return { context, page, errors, c };
}

const cards = page => ({
  pipeline: page.getByTestId('dash-pipeline-card'),
  deployment: page.getByTestId('dash-deployment-card'),
  team: page.getByTestId('dash-team-activity-card')
});
const banner = page => page.getByTestId('connection-banner');
const refresh = page => page.getByTitle('Yenile', { exact: true }).last().click();
const spinning = card => card.locator('.animate-spin').count().then(n => n > 0);
const waitHits = (page, controller, n) => page.waitForFunction(() => true).then(async () => {
  for (let i = 0; i < 100 && controller.hits < n; i++) await page.waitForTimeout(50);
});

async function independentCards() {
  for (const slow of ['pipeline', 'deployment', 'team']) {
    const { context, page, c } = await open();
    try {
      c[slow].mode = 'hold';
      await page.goto(`${WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
      const k = cards(page);
      const fast = ['pipeline', 'deployment', 'team'].filter(n => n !== slow);
      const showsData = {
        pipeline: () => k.pipeline.getByText('%100', { exact: true }).waitFor(),
        deployment: () => k.deployment.getByText('%100', { exact: true }).waitFor(),
        team: () => k.team.getByText('42', { exact: true }).waitFor()
      };
      await Promise.all(fast.map(n => showsData[n]()));
      await waitHits(page, c[slow], 1);
      await page.waitForTimeout(300);
      check(`slow ${slow} card keeps its own loading state while the other two cards show data`, await spinning(k[slow]));
      check(`slow ${slow} card does not make the other cards look like they are loading`, (await Promise.all(fast.map(n => spinning(k[n])))).every(s => !s));
      check(`slow ${slow} card does not raise the global connection warning`, await banner(page).count() === 0);
      check(`${slow} summary is requested exactly once on the initial load`, c.pipeline.hits === 1 && c.deployment.hits === 1 && c.team.hits === 1);
      await c[slow].release(0);
      await showsData[slow]();
      await page.waitForTimeout(200);
      check(`${slow} card leaves its loading state when its own request settles`, !(await spinning(k[slow])));
    } catch (error) {
      console.error(error);
      total++;
    } finally {
      await context.close();
    }
  }
}

async function refreshKeepsDataAndFreshness() {
  const { context, page, c } = await open();
  try {
    c.deployment.body = deploymentBody({ lastSyncedAt: '2026-01-01T00:00:00Z', cacheStatus: { outcome: 'complete', complete: true, stale: true, lastSyncedAt: '2026-01-01T00:00:00Z', errors: [{ kind: 'timeout' }] } });
    c.team.body = teamBody(42, { cacheStatus: { outcome: 'partial', complete: false, stale: true } });
    await page.goto(`${WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
    const k = cards(page);
    await k.pipeline.getByText('%100', { exact: true }).waitFor();
    await k.deployment.getByText('Son başarılı güncelleme', { exact: false }).waitFor();
    await k.team.getByText('42', { exact: true }).waitFor();
    check('initial load shows the pipeline partial, deployment stale and team partial notices', await k.pipeline.getByText('Pipeline verisi kısmi', { exact: false }).isVisible() && await k.deployment.getByText('Son başarılı güncelleme', { exact: false }).isVisible() && await k.team.getByTestId('dash-team-partial').isVisible());

    for (const card of Object.values(c)) { card.mode = 'hold'; card.held = []; }
    const before = { p: c.pipeline.hits, d: c.deployment.hits, t: c.team.hits };
    await refresh(page);
    await Promise.all([waitHits(page, c.pipeline, before.p + 1), waitHits(page, c.deployment, before.d + 1), waitHits(page, c.team, before.t + 1)]);
    check('manual refresh re-requests all three cards exactly once', c.pipeline.hits === before.p + 1 && c.deployment.hits === before.d + 1 && c.team.hits === before.t + 1);
    await page.waitForTimeout(250);
    check('pipeline counts and partial notice stay visible while refreshing', await k.pipeline.getByText('%100', { exact: true }).isVisible() && await k.pipeline.getByText('Pipeline verisi kısmi', { exact: false }).isVisible());
    check('pipeline shows a small refresh indicator instead of replacing the card with a loading row', await k.pipeline.getByTestId('dash-pipeline-loading').getByText('Güncelleniyor').isVisible());
    check('deployment counts and stale time stay visible while refreshing', await k.deployment.getByText('%100', { exact: true }).isVisible() && await k.deployment.getByText('Son başarılı güncelleme', { exact: false }).isVisible() && await k.deployment.getByTestId('dash-deployment-loading').getByText('Güncelleniyor').isVisible());
    check('team data and partial notice stay visible while refreshing', await k.team.getByText('42', { exact: true }).isVisible() && await k.team.getByTestId('dash-team-partial').isVisible() && await k.team.getByTestId('dash-team-refreshing').isVisible());

    await c.pipeline.release(0, pipelineBody({ successRate: 80, succeeded: 4, failed: 1, totalRuns: 5, cacheStatus: { outcome: 'complete', complete: true, stale: false } }));
    await c.deployment.release(0, deploymentBody({ successRate: 75 }));
    await c.team.release(0, teamBody(43));
    await k.pipeline.getByText('%80', { exact: true }).waitFor();
    await k.deployment.getByText('%75', { exact: true }).waitFor();
    await k.team.getByText('43', { exact: true }).waitFor();
    await page.waitForTimeout(200);
    check('refreshed values replace the cached ones and the stale/partial notices disappear', await k.pipeline.getByText('Pipeline verisi kısmi', { exact: false }).count() === 0 && await k.deployment.getByText('Son başarılı güncelleme', { exact: false }).count() === 0 && await k.team.getByTestId('dash-team-partial').count() === 0);
    check('refresh indicators disappear once every request settles', !(await spinning(k.pipeline)) && !(await spinning(k.deployment)) && !(await spinning(k.team)));
  } catch (error) {
    console.error(error);
    total++;
  } finally {
    await context.close();
  }
}

async function oneCardFails() {
  const { context, page, c } = await open();
  try {
    c.team.status = 500;
    c.team.body = { error: 'synthetic team failure' };
    c.pipeline.status = 504;
    c.pipeline.body = { error: 'synthetic gateway timeout' };
    await page.goto(`${WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
    const k = cards(page);
    await k.deployment.getByText('%100', { exact: true }).waitFor();
    await k.team.getByTestId('dash-team-error').waitFor();
    await waitHits(page, c.pipeline, 1);
    await page.waitForTimeout(1500); // the reachability probe runs asynchronously after a gateway error
    check('team failure is announced as an error, not as an empty result', await k.team.getByTestId('dash-team-error').isVisible() && await k.team.getByText('Ekip aktivitesi alınamadı.', { exact: true }).isVisible());
    check('team failure keeps the existing empty-state line for compatibility', await k.team.getByText('Henüz ekip aktivitesi bulunmuyor.').isVisible());
    check('failed pipeline card shows no healthy percentage', await k.pipeline.getByText('%100', { exact: true }).count() === 0);
    check('a failed card does not stop the other card from loading', await k.deployment.getByText('%100', { exact: true }).isVisible());
    check('single-card failures with a reachable backend do not raise the global connection warning', await banner(page).count() === 0);

    for (const card of [c.team, c.pipeline]) { card.status = 200; }
    c.team.body = teamBody(44);
    c.pipeline.body = pipelineBody({ cacheStatus: { outcome: 'complete', complete: true, stale: false } });
    await refresh(page);
    await k.team.getByText('44', { exact: true }).waitFor();
    await k.pipeline.getByText('%100', { exact: true }).waitFor();
    check('a failed card recovers on refresh without a page reload', await k.team.getByTestId('dash-team-error').count() === 0);

    c.team.status = 500;
    c.team.body = { error: 'synthetic team failure' };
    await refresh(page);
    await k.team.getByTestId('dash-team-error').waitFor();
    check('a failed refresh keeps the previous team data visible and says so', await k.team.getByText('44', { exact: true }).isVisible() && await k.team.getByText('Ekip aktivitesi güncellenemedi', { exact: false }).isVisible());
  } catch (error) {
    console.error(error);
    total++;
  } finally {
    await context.close();
  }
}

async function emptyIsNotAnError() {
  const { context, page, c } = await open();
  try {
    c.team.body = teamBody(0);
    c.pipeline.body = pipelineBody({ totalRuns: 0, succeeded: 0, successRate: 100, cacheStatus: { outcome: 'complete', complete: true, stale: false } });
    await page.goto(`${WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
    const k = cards(page);
    await k.pipeline.getByText('Pipeline koşumu bulunmuyor', { exact: false }).waitFor();
    await k.team.getByText('0', { exact: true }).first().waitFor();
    check('a genuinely empty team result shows neither an error nor a partial/stale notice', await k.team.getByTestId('dash-team-error').count() === 0 && await k.team.getByTestId('dash-team-partial').count() === 0);
    check('a genuinely empty pipeline result is not reported as a failure', await k.pipeline.getByText('Pipeline verisi alınamadı', { exact: false }).count() === 0 && await k.pipeline.getByText('Pipeline verisi kısmi', { exact: false }).count() === 0);
  } catch (error) {
    console.error(error);
    total++;
  } finally {
    await context.close();
  }
}

async function cardTimeoutIsNotAnOutage() {
  const { context, page, c } = await open({ clock: true });
  try {
    c.team.mode = 'hold';
    // The browser queues the reachability probe behind slow requests; hold it to model that queueing.
    await page.route('**/api/health', () => { /* never answered */ });
    await page.goto(`${WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
    const k = cards(page);
    await k.pipeline.getByText('%100', { exact: true }).waitFor();
    await k.deployment.getByText('%100', { exact: true }).waitFor();
    await waitHits(page, c.team, 1);
    const poll = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sync-status');
    await page.clock.fastForward(49000); // the 20 s sync poll fires and the backend demonstrably answers
    await poll;
    await page.waitForTimeout(300);
    await page.clock.fastForward(8000); // the team request exceeds its 50 s client timeout
    await k.team.getByTestId('dash-team-error').waitFor();
    await page.clock.fastForward(6000); // longer than the 5 s probe budget
    await page.waitForTimeout(500);
    check('a client-side timeout of one card is reported on that card', await k.team.getByTestId('dash-team-error').isVisible());
    check('a card timeout while other requests are being answered does not raise the global connection warning', await banner(page).count() === 0);
    check('the other cards are unaffected by the timed-out card', await k.pipeline.getByText('%100', { exact: true }).isVisible() && await k.deployment.getByText('%100', { exact: true }).isVisible());
  } catch (error) {
    console.error(error);
    total++;
  } finally {
    await context.close();
  }
}

async function backendOutageAndRecovery() {
  if (!CONTAINER) { console.log('SKIP backend outage: E2E_API_CONTAINER is not set'); return; }
  const context = await browser.newContext();
  const page = await context.newPage();
  const stop = () => execSync(`docker stop ${CONTAINER}`, { stdio: 'ignore' });
  const start = () => execSync(`docker start ${CONTAINER}`, { stdio: 'ignore' });
  let stopped = false;
  try {
    await page.goto(`${WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
    const k = cards(page);
    await k.pipeline.getByText(/^%[\d.]+$/).first().waitFor({ timeout: 30000 });
    await k.deployment.getByText(/^%[\d.]+$/).first().waitFor({ timeout: 30000 });
    check('fixture backend serves all three dashboard cards before the outage', true);
    stop();
    stopped = true;
    await refresh(page);
    await banner(page).waitFor({ timeout: 40000 });
    check('a real backend outage raises the global connection warning', await banner(page).isVisible());
    check('last known card data stays visible during the outage', await k.pipeline.getByText(/^%[\d.]+$/).first().isVisible() && await k.deployment.getByText(/^%[\d.]+$/).first().isVisible());
    start();
    stopped = false;
    await banner(page).waitFor({ state: 'hidden', timeout: 90000 });
    check('the warning clears after the backend returns, without a page reload', await banner(page).count() === 0);
    await page.waitForFunction(() => !document.querySelector('[data-testid=dash-pipeline-loading]') && !document.querySelector('[data-testid=dash-deployment-loading]') && !document.querySelector('[data-testid=dash-team-refreshing]'), null, { timeout: 60000 });
    check('cards reload after recovery and none stays stuck loading', await k.pipeline.getByText(/^%[\d.]+$/).first().isVisible() && await k.deployment.getByText(/^%[\d.]+$/).first().isVisible() && await k.team.getByTestId('dash-team-error').count() === 0);
  } catch (error) {
    console.error(error);
    total++;
  } finally {
    if (stopped) { try { start(); } catch { /* best effort */ } }
    await context.close();
  }
}

try {
  await independentCards();
  await refreshKeepsDataAndFreshness();
  await oneCardFails();
  await emptyIsNotAnError();
  await cardTimeoutIsNotAnOutage();
  await backendOutageAndRecovery();
} finally {
  await browser.close();
}
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
