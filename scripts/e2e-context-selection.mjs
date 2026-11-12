// Synthetic fixture regression: a delayed refresh must not replace a newer inspector selection.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let passed = 0;
let total = 0;
const check = (name, ok) => { total++; if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
try {
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
