// Synthetic responses deliberately ignore AbortSignal to test stale-response handling.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
let passed = 0;
let total = 0;
function check(name, ok) {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

async function exercise({ path, endpoint, prefix, firstFilter, secondFilter, item }) {
  const page = await browser.newPage();
  try {
    await page.addInitScript(endpointPath => {
      const originalFetch = window.fetch.bind(window);
      window.testRequests = [];
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname !== endpointPath) return originalFetch(input, init);
        return new Promise(resolve => window.testRequests.push({ resolve, signal: init?.signal, refresh: url.searchParams.get('refresh') }));
      };
      window.answerRequest = (index, status, body) => window.testRequests[index].resolve(
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      );
    }, endpoint);
    const waitForRequest = n => page.waitForFunction(count => window.testRequests.length >= count, n);
    const answer = (index, status, body) => page.evaluate(({ index, status, body }) => window.answerRequest(index, status, body), { index, status, body });
    const response = id => ({ items: [item(id)], total: 1, limit: 25, offset: 0, hasMore: false,
      summary: prefix === 'pr' ? { needsMyReview: 1, createdByMe: 0, involved: 0, totalActive: 1 }
        : { periodDays: 30, totalPipelines: 1, totalRuns: 1, succeeded: 1, failed: 0,
          partiallySucceeded: 0, inProgress: 0, canceled: 0, successRate: 100, failedRuns: [], dailyStats: [] }, dataScope: 'fixture' });
    await page.goto(`${process.env.WEB_URL}${path}`, { waitUntil: 'domcontentloaded' });
    await waitForRequest(1);
    check(`${prefix}: initial loading`, await page.getByTestId(`${prefix}-loading`).isVisible());
    await answer(0, 500, { error: 'Synthetic failure' });
    const error = page.getByTestId(`${prefix}-error`);
    await error.waitFor();
    check(`${prefix}: request error displayed`, (await error.innerText()).includes('Synthetic failure'));
    await error.getByRole('button', { name: 'Tekrar Dene' }).click();
    await waitForRequest(2);
    check(`${prefix}: retry returns to loading`, await page.getByTestId(`${prefix}-loading`).isVisible());
    await answer(1, 200, response(1));
    await page.locator(`[data-testid="${prefix}-row"][data-id="1"]`).waitFor();
    check(`${prefix}: retry renders result`, await page.locator(`[data-testid="${prefix}-row"][data-id="1"]`).count() === 1);
    await firstFilter(page);
    await waitForRequest(3);
    check(`${prefix}: existing row stays visible while refreshing`, await page.locator(`[data-testid="${prefix}-row"][data-id="1"]`).isVisible());
    await secondFilter(page);
    await waitForRequest(4);
    check(`${prefix}: superseded request is aborted`, await page.evaluate(() => window.testRequests[2].signal.aborted));
    await answer(3, 200, response(3));
    await page.locator(`[data-testid="${prefix}-row"][data-id="3"]`).waitFor();
    await answer(2, 200, response(2));
    await page.waitForTimeout(150);
    check(`${prefix}: late stale response cannot overwrite newest result`, await page.locator(`[data-testid="${prefix}-row"][data-id="3"]`).count() === 1 && await page.locator(`[data-testid="${prefix}-row"][data-id="2"]`).count() === 0);
    await firstFilter(page);
    await waitForRequest(5);
    await secondFilter(page);
    await waitForRequest(6);
    await answer(5, 200, response(4));
    await page.locator(`[data-testid="${prefix}-row"][data-id="4"]`).waitFor();
    await answer(4, 500, { error: 'Stale failure' });
    await page.waitForTimeout(150);
    check(`${prefix}: stale error cannot hide newest result`, await error.count() === 0 && await page.locator(`[data-testid="${prefix}-row"][data-id="4"]`).count() === 1);
    await firstFilter(page);
    await waitForRequest(7);
    await answer(6, 500, { error: 'Refresh failure' });
    await error.waitFor();
    check(`${prefix}: refresh error is displayed`, (await error.innerText()).includes('Refresh failure'));
    await error.getByRole('button', { name: 'Tekrar Dene' }).click();
    await waitForRequest(8);
    check(`${prefix}: retry retains previous rows while loading`, await page.locator(`[data-testid="${prefix}-row"][data-id="4"]`).isVisible());
    await answer(7, 200, response(5));
    await page.locator(`[data-testid="${prefix}-row"][data-id="5"]`).waitFor();
    check(`${prefix}: retry after refresh error succeeds`, await page.locator(`[data-testid="${prefix}-row"][data-id="5"]`).count() === 1);
    if (prefix === 'pr') {
      await page.getByTitle('Yenile', { exact: true }).last().click();
      await waitForRequest(9);
      check('pr: manual refresh requests an upstream refresh', await page.evaluate(() => window.testRequests[8].refresh === 'true'));
      await secondFilter(page);
      await waitForRequest(10);
      check('pr: superseded manual refresh remains forced', await page.evaluate(() => window.testRequests[8].signal.aborted && window.testRequests[9].refresh === 'true'));
      await answer(9, 200, response(6));
      await page.locator('[data-testid="pr-row"][data-id="6"]').waitFor();
      await firstFilter(page);
      await waitForRequest(11);
      check('pr: completed forced refresh is consumed once', await page.evaluate(() => window.testRequests[10].refresh !== 'true'));
      await answer(10, 200, response(7));
    }
  } catch (error) {
    console.error(error);
    total++;
  } finally {
    await page.close();
  }
}

try {
  await exercise({ path: '/pull-requests', endpoint: '/api/pull-requests', prefix: 'pr',
    firstFilter: page => page.getByTestId('pr-filter-all').click(),
    secondFilter: page => page.getByTestId('pr-filter-created-by-me').click(),
    item: id => ({ id, project: 'Fixture', repository: 'Fixture', title: `PR ${id}`,
      authorName: 'Fixture', sourceBranch: 'source', targetBranch: 'main', status: 'active', reviewers: [] }) });
  await exercise({ path: '/pipelines', endpoint: '/api/pipelines/runs', prefix: 'pipeline',
    firstFilter: page => page.getByRole('button', { name: 'Başarılı', exact: true }).click(),
    secondFilter: page => page.getByRole('button', { name: 'Başarısız', exact: true }).click(),
    item: id => ({ id, project: 'Fixture', pipelineName: `Pipeline ${id}`, pipelineType: 'yaml',
      status: 'completed', result: 'succeeded', sourceBranch: 'main', durationSeconds: 10, requestedBy: 'Fixture' }) });
} finally {
  await browser.close();
}
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
