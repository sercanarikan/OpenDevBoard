// Synthetic fixture regression: a delayed refresh must not replace a newer inspector selection.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let passed = 0;
let total = 0;
const check = (name, ok) => { total++; if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
async function checkWorkItemSummaries() {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const warnings = [];
  p.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  try {
    await p.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.workSummaries = [];
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname !== '/api/work-items/summary') return originalFetch(input, init);
        // Deliberately ignore abort: old responses can still resolve after scope changes.
        return new Promise(resolve => window.workSummaries.push({ resolve, signal: init?.signal, project: url.searchParams.get('project') || 'all' }));
      };
      window.answerWorkSummary = (index, count, status = 200) => {
        const project = window.workSummaries[index].project;
        const body = status === 200 ? {
          scope: { project, total: count, myTasks: count, unassigned: 0, blocked: 0, blocking: 0, bugs: 0 },
          facets: { types: {}, states: {}, priorities: {} },
          projects: [{ name: 'Alpha', total: 20 }, { name: 'Beta', total: 30 }], completed: 0, dataVersion: 'fixture'
        } : { error: 'Synthetic summary failure' };
        window.workSummaries[index].resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
      };
    });
    await p.goto(`${process.env.WEB_URL}/tasks`, { waitUntil: 'domcontentloaded' });
    const waitRequest = (project, count) => p.waitForFunction(({ project, count }) => window.workSummaries.filter(r => r.project === project).length >= count, { project, count });
    const indexOf = (project, occurrence) => p.evaluate(({ project, occurrence }) => window.workSummaries.map((r, i) => ({ ...r, i })).filter(r => r.project === project)[occurrence].i, { project, occurrence });
    const answer = (index, count, status = 200) => p.evaluate(({ index, count, status }) => window.answerWorkSummary(index, count, status), { index, count, status });
    const counter = p.getByTestId('nav-explorer');
    await waitRequest('all', 1);
    await answer(await indexOf('all', 0), 101);
    await counter.getByText('101', { exact: true }).waitFor();
    const select = p.getByTestId('header').locator('select').first();
    await select.selectOption('Alpha');
    await waitRequest('Alpha', 1);
    check('project switch does not show the previous scope counters', await counter.getByText('101', { exact: true }).count() === 0);
    await answer(await indexOf('Alpha', 0), 201);
    await counter.getByText('201', { exact: true }).waitFor();
    await p.getByTestId('sync-now').click();
    await waitRequest('Alpha', 2);
    const old = await indexOf('Alpha', 1);
    check('refresh keeps the last successful counters for the same project', await counter.getByText('201', { exact: true }).count() === 1);
    await select.selectOption('Beta');
    await waitRequest('Beta', 1);
    check('switching projects hides the old project counters while loading', await counter.getByText('201', { exact: true }).count() === 0);
    check('superseded work-item summary receives an abort signal', await p.evaluate(index => window.workSummaries[index].signal.aborted, old));
    await answer(await indexOf('Beta', 0), 301);
    await counter.getByText('301', { exact: true }).waitFor();
    await answer(old, 999);
    await p.waitForTimeout(200);
    check('late aborted work-item summary cannot replace the new project counters', await counter.getByText('301', { exact: true }).count() === 1 && await counter.getByText('999', { exact: true }).count() === 0);
    await p.getByTestId('sync-now').click();
    await waitRequest('Beta', 2);
    await answer(await indexOf('Beta', 1), 0, 500);
    await p.waitForTimeout(200);
    check('summary failure retains the successful counters and reports the error', await counter.getByText('301', { exact: true }).count() === 1 && warnings.some(w => w.includes('summary failed:')));
  } finally {
    await p.close();
  }
}

async function checkScopedSummaries() {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await p.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.scopedRequests = [];
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const kind = ({ '/api/pull-requests/summary': 'pr', '/api/pipelines/summary': 'pipeline', '/api/deployments/summary': 'deployment' })[url.pathname];
        if (!kind) return originalFetch(input, init);
        return new Promise(resolve => window.scopedRequests.push({ kind, project: url.searchParams.get('project') || 'all', signal: init?.signal, resolve }));
      };
      window.answerScoped = (kind, project, occurrence, number, status = 200) => {
        const req = window.scopedRequests.filter(r => r.kind === kind && r.project === project)[occurrence];
        const bodies = {
          pr: { needsMyReview: number, createdByMe: number, involved: 0, totalActive: number },
          pipeline: { periodDays: 30, totalPipelines: 1, totalRuns: number, succeeded: number, failed: number, partiallySucceeded: 0, inProgress: 0, canceled: 0, successRate: number, failedRuns: [], dailyStats: [] },
          deployment: { periodDays: 30, totalDeployments: number, succeeded: number, failed: 0, inProgress: 0, successRate: number, environments: [], dailyStats: [] }
        };
        req.resolve(new Response(JSON.stringify(status === 200 ? bodies[kind] : { error: 'Synthetic summary failure' }), { status, headers: { 'Content-Type': 'application/json' } }));
      };
    });
    await p.goto(`${process.env.WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    const kinds = ['pr', 'pipeline', 'deployment'];
    const waitScope = (project, count) => p.waitForFunction(({ project, count }) => ['pr', 'pipeline', 'deployment'].every(kind => window.scopedRequests.filter(r => r.kind === kind && r.project === project).length >= count), { project, count });
    const answer = (kind, project, occurrence, number, status = 200) => p.evaluate(args => window.answerScoped(...args), [kind, project, occurrence, number, status]);
    const answerAll = async (project, occurrence, number, status = 200) => { for (const kind of kinds) await answer(kind, project, occurrence, number, status); };
    const prNav = p.getByTestId('nav-pull-requests');
    const pipeline = p.getByTestId('dash-pipeline-card');
    const deployment = p.getByTestId('dash-deployment-card');
    const select = p.getByTestId('header').locator('select').first();
    await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="header"] select option')].some(o => o.value === 'Alpha') && [...document.querySelectorAll('[data-testid="header"] select option')].some(o => o.value === 'Beta'));
    await select.selectOption('Alpha');
    await waitScope('Alpha', 1);
    await answerAll('Alpha', 0, 11);
    await prNav.getByText('11', { exact: true }).waitFor();
    await pipeline.getByText('%11', { exact: true }).waitFor();
    await deployment.getByText('%11', { exact: true }).waitFor();
    check('all three Alpha summaries are visible', true);
    await p.getByTestId('sync-now').click();
    await waitScope('Alpha', 2);
    check('same-project refresh retains all three summaries', await prNav.getByText('11', { exact: true }).count() === 1 && await pipeline.getByText('%11', { exact: true }).count() === 1 && await deployment.getByText('%11', { exact: true }).count() === 1);
    await select.selectOption('Beta');
    await waitScope('Beta', 1);
    check('project change hides all three previous summaries', await prNav.getByText('11', { exact: true }).count() === 0 && await pipeline.getByText('%11', { exact: true }).count() === 0 && await deployment.getByText('%11', { exact: true }).count() === 0);
    check('all superseded summary requests are aborted', await p.evaluate(() => ['pr', 'pipeline', 'deployment'].every(kind => window.scopedRequests.filter(r => r.kind === kind && r.project === 'Alpha')[1].signal.aborted)));
    await answerAll('Beta', 0, 22);
    await prNav.getByText('22', { exact: true }).waitFor();
    await pipeline.getByText('%22', { exact: true }).waitFor();
    await deployment.getByText('%22', { exact: true }).waitFor();
    check('all three Beta summaries appear', true);
    await answerAll('Alpha', 1, 99);
    await p.waitForTimeout(200);
    check('late aborted responses cannot overwrite Beta summaries', await prNav.getByText('22', { exact: true }).count() === 1 && await pipeline.getByText('%22', { exact: true }).count() === 1 && await deployment.getByText('%22', { exact: true }).count() === 1);
    await p.getByTestId('sync-now').click();
    await waitScope('Beta', 2);
    await answerAll('Beta', 1, 0, 500);
    await p.waitForTimeout(200);
    check('same-project errors preserve prior summary data', await prNav.getByText('22', { exact: true }).count() === 1 && await pipeline.getByText('%22', { exact: true }).count() === 1 && await deployment.getByText('%22', { exact: true }).count() === 1);
    check('all three summary errors remain visible', await p.getByTestId('dash-pr-summary-error').count() > 0 && await pipeline.getByText('Synthetic summary failure', { exact: true }).count() === 1 && await deployment.getByText('Synthetic summary failure', { exact: true }).count() === 1);
    await p.getByTestId('sync-now').click();
    await waitScope('Beta', 3);
    check('retry keeps prior data while requests are pending', await prNav.getByText('22', { exact: true }).count() === 1 && await pipeline.getByText('%22', { exact: true }).count() === 1 && await deployment.getByText('%22', { exact: true }).count() === 1);
    await answerAll('Beta', 2, 33);
    await prNav.getByText('33', { exact: true }).waitFor();
    await pipeline.getByText('%33', { exact: true }).waitFor();
    await deployment.getByText('%33', { exact: true }).waitFor();
    check('retry publishes all three new summaries', true);
    await select.selectOption('Alpha');
    await waitScope('Alpha', 3);
    await answerAll('Alpha', 2, 0, 500);
    await p.waitForTimeout(200);
    check('first error in a new scope never reveals the previous scope data', await prNav.getByText('33', { exact: true }).count() === 0 && await pipeline.getByText('%33', { exact: true }).count() === 0 && await deployment.getByText('%33', { exact: true }).count() === 0);

  } finally { await p.close(); }
}

try {
  await checkScopedSummaries();
  await checkWorkItemSummaries();
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.pendingSummaries = [];
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== '/api/pull-requests/summary') return originalFetch(input, init);
      return new Promise(resolve => window.pendingSummaries.push({ resolve, signal: init?.signal }));
    };
    window.answerSummary = (index, count) => window.pendingSummaries[index].resolve(new Response(JSON.stringify({
      needsMyReview: count, createdByMe: 0, involved: 0, totalActive: count
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });
  await page.goto(`${process.env.WEB_URL}/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.pendingSummaries.length >= 1);
  const projectSelect = page.getByTestId('header').locator('select').first();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="header"] select option')].some(o => o.value !== 'all'));
  const project = await projectSelect.locator('option').evaluateAll(options => options.find(o => o.value !== 'all').value);
  await projectSelect.selectOption(project);
  await page.waitForFunction(() => window.pendingSummaries.length >= 2);
  check('project change aborts the previous global summary request', await page.evaluate(() => window.pendingSummaries[0].signal.aborted));
  await page.evaluate(() => window.answerSummary(1, 22));
  await page.getByTestId('nav-pull-requests').getByText('22', { exact: true }).waitFor();
  await page.evaluate(() => window.answerSummary(0, 11));
  await page.waitForTimeout(200);
  check('late global summary does not replace the new project summary', await page.getByTestId('nav-pull-requests').getByText('22', { exact: true }).count() === 1);
  const rows = page.getByTestId('explorer-row');
  await rows.nth(1).waitFor({ timeout: 30000 });
  const first = await rows.nth(0).getAttribute('data-id');
  const second = await rows.nth(1).getAttribute('data-id');
  await rows.nth(0).click();
  await page.getByTestId('inspector').waitFor();
  let release;
  let seen;
  const pending = new Promise(resolve => { seen = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/work-items/${first}`, async route => {
    const response = await route.fetch();
    seen();
    await blocked;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByTestId('sync-now').click();
  let timeout;
  try {
    await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('refresh request did not start')), 30000); })]);
  } finally { clearTimeout(timeout); }
  await page.locator(`[data-testid="explorer-row"][data-id="${second}"]`).click();
  await page.waitForFunction(id => document.querySelector('[data-testid="inspector"]')?.getAttribute('data-id') === id, second);
  release();
  await page.waitForTimeout(500);
  check('late refresh preserves the newer selected item', await page.getByTestId('inspector').getAttribute('data-id') === second);

  let poolRequests = 0;
  await page.route('**/api/work-items-pool**', async route => {
    poolRequests++;
    if (poolRequests === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture pool failure' }) });
    else await route.continue();
  });
  await page.getByTestId('nav-hierarchy').click();
  await page.getByTestId('hierarchy-error').waitFor({ timeout: 30000 });
  check('pool failure is visible and offers retry', await page.getByTestId('hierarchy-retry').isVisible());
  await page.getByTestId('hierarchy-retry').click();
  await page.getByTestId('hierarchy-row').first().waitFor({ timeout: 30000 });
  check('pool retry loads the hierarchy after a failed request', poolRequests >= 2);

} catch (error) {
  console.error(error);
  total++;
} finally {
  await browser.close();
}
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
