// Synthetic fixture regression checks for dependency and deployment explorers.
import { chromium } from 'playwright';

const web = process.env.WEB_URL;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let passed = 0;
let total = 0;
function check(name, value) {
  total++;
  if (value) passed++;
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
}

try {
  const environments = Array.from({ length: 8 }, (_, i) => ({
    name: `Environment ${i + 1}`, total: 8 - i, succeeded: 8 - i,
    failed: 0, inProgress: 0, successRate: 100
  }));
  await page.route('**/api/deployments?*', async route => {
    await route.fulfill({ json: {
      items: [], total: 0, limit: 25, offset: 0, hasMore: false,
      summary: { periodDays: 30, totalDeployments: 0, succeeded: 0, failed: 0,
        inProgress: 0, successRate: 0, environments, dailyStats: [] },
      dataScope: 'fixture'
    } });
  });
  await page.goto(`${web}/deployments`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="env-chip"]');
  check('initial environment list is limited to six', await page.locator('[data-testid="env-chip"]').count() === 6);
  await page.getByText('Tüm Ortamları Göster (8)').click();
  check('expanding shows all environments', await page.locator('[data-testid="env-chip"]').count() === 8);
  await page.getByPlaceholder('Ortam filtrele...').fill('Environment 8');
  check('environment search filters the list', await page.locator('[data-testid="env-chip"]').count() === 1 && await page.getByTestId('env-chip').first().innerText().then(s => s.includes('Environment 8')));
  await page.getByTestId('env-chip').first().click();
  await page.getByPlaceholder('Ortam filtrele...').fill('');
  await page.getByText('Daha Az Göster').click();
  check('selected environment stays visible', await page.getByTestId('env-chip').filter({ hasText: 'Environment 8' }).count() === 1);

  await page.goto(`${web}/dependencies`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="graph-node"][data-focused="true"]', { timeout: 30000 });
  check('dependency data loads with exactly one focused node', await page.locator('[data-testid="graph-node"][data-focused="true"]').count() === 1);
} catch (error) {
  console.error(error);
  total++;
} finally {
  await page.close();
}
// Hold synthetic responses even after abort to exercise stale-response guards.
const controlled = await browser.newPage();
await controlled.addInitScript(() => {
  const fetchOriginal = window.fetch.bind(window);
  window.deploymentRequests = [];
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname !== '/api/deployments') return fetchOriginal(input, init);
    return new Promise(resolve => window.deploymentRequests.push({ resolve, signal: init?.signal, url: url.href }));
  };
  window.answerDeployment = (index, status, body) => window.deploymentRequests[index].resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  );
});
const waitRequest = n => controlled.waitForFunction(n => window.deploymentRequests.length >= n, n);
const answer = (index, status, body) => controlled.evaluate(({ index, status, body }) => window.answerDeployment(index, status, body), { index, status, body });
const response = (name, total = 1) => ({
  items: [{ id: name, releaseName: name, definitionName: name, project: 'Fixture', environmentName: 'Environment 1', status: 'succeeded', durationSeconds: 1, requestedBy: 'Fixture', startedOn: '' }],
  total, limit: 25, offset: 0, hasMore: total > 25,
  summary: { periodDays: 30, totalDeployments: total, succeeded: total, failed: 0, inProgress: 0, successRate: 100,
    environments: [{ name: 'Environment 1', total, succeeded: total, failed: 0, inProgress: 0, successRate: 100 }], dailyStats: [] }, dataScope: 'fixture'
});
try {
  await controlled.goto(`${web}/deployments`, { waitUntil: 'domcontentloaded' });
  await waitRequest(1);
  check('initial request displays loading', await controlled.getByTestId('deployment-loading').isVisible());
  await answer(0, 200, response('Initial', 50));
  await controlled.getByText('Initial', { exact: true }).first().waitFor();
  await controlled.getByTestId('env-chip').filter({ hasText: 'Environment 1' }).click();
  await waitRequest(2);
  check('filter change hides previous scope while loading', await controlled.getByText('Initial', { exact: true }).count() === 0);
  await answer(1, 200, response('Filtered', 50));
  await controlled.getByText('Filtered', { exact: true }).first().waitFor();
  await controlled.getByTestId('deployment-row').first().click();
  await controlled.getByTestId('deployment-inspector').waitFor();
  await controlled.getByTitle('Yenile', { exact: true }).last().click();
  await waitRequest(3);
  check('same-scope refresh retains rows and selected deployment', await controlled.getByTestId('deployment-row').first().isVisible() && await controlled.getByTestId('deployment-inspector').isVisible());
  await controlled.getByTitle('Yenile', { exact: true }).last().click();
  await waitRequest(4);
  await answer(3, 200, response('Newest', 50));
  await controlled.getByText('Newest', { exact: true }).first().waitFor();
  await answer(2, 200, response('Stale'));
  await controlled.waitForTimeout(100);
  check('late success cannot overwrite newer response', await controlled.getByText('Newest', { exact: true }).count() > 0 && await controlled.getByText('Stale', { exact: true }).count() === 0);
  check('selected environment survives refresh', await controlled.getByTestId('env-chip').filter({ hasText: 'Environment 1' }).count() === 1 && await controlled.getByText('Filtreyi Temizle').count() === 1);
  await controlled.getByTitle('Yenile', { exact: true }).last().click();
  await waitRequest(5);
  await controlled.getByTitle('Yenile', { exact: true }).last().click();
  await waitRequest(6);
  await answer(5, 200, response('Latest', 50));
  await controlled.getByText('Latest', { exact: true }).first().waitFor();
  await answer(4, 500, { error: 'Stale error' });
  await controlled.waitForTimeout(100);
  check('late failure cannot replace newer response', await controlled.getByTestId('deployment-error').count() === 0 && await controlled.getByText('Latest', { exact: true }).count() > 0);
  await controlled.getByLabel('Next Page').click();
  await waitRequest(7);
  check('pagination hides previous page while loading', await controlled.getByText('Latest', { exact: true }).count() === 0);
  await answer(6, 500, { error: 'Fixture error' });
  await controlled.getByTestId('deployment-error').waitFor();
  check('request error is visible', await controlled.getByTestId('deployment-error').isVisible());
  await controlled.getByTestId('deployment-error').getByRole('button').click();
  await waitRequest(8);
  await answer(7, 200, response('Retried'));
  await controlled.getByText('Retried', { exact: true }).first().waitFor();
  check('retry recovers', true);
  const projects = controlled.getByTestId('header').locator('select').first();
  await controlled.waitForFunction(() => [...document.querySelectorAll('[data-testid="header"] select option')].some(o => o.value !== 'all'));
  const project = await projects.locator('option').evaluateAll(options => options.find(o => o.value !== 'all').value);
  await projects.selectOption(project);
  await waitRequest(9);
  check('project change hides prior project data', await controlled.getByText('Retried', { exact: true }).count() === 0);
  await controlled.getByTestId('nav-explorer').click();
  await controlled.waitForURL(url => url.pathname === '/tasks');
  await controlled.waitForFunction(() => window.deploymentRequests[8].signal.aborted);
  check('unmount aborts pending request', true);
  await answer(8, 500, { error: 'Unmounted error' });
} catch (error) {
  console.error(error);
  total++;
} finally {
  await controlled.close();
  await browser.close();
}
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
