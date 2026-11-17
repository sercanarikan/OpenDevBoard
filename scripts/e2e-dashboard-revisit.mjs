// Synthetic fixture checks: coming back to the dashboard must not show empty loading spinners again.
import { chromium } from 'playwright';

const web = process.env.WEB_URL;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let passed = 0, total = 0;
function check(name, ok) { total++; if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
const spinners = () => page.getByTestId('dash-feed-loading').count();

try {
  await page.goto(`${web}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByTestId('dash-card-pending-prs').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dash-feed-loading"]').length === 0);
  check('first visit finishes loading all feed cards', await spinners() === 0);

  await page.getByTestId('nav-explorer').click();
  await page.getByTestId('explorer-row').first().waitFor();

  // Slow every feed the dashboard refreshes on return, so a spinner would be easy to see.
  let delayed = 0;
  for (const pattern of ['**/api/pull-requests?*', '**/api/my-history/timeline*', '**/api/team-activity/summary*', '**/api/work-items?*']) {
    await page.route(pattern, async route => { delayed++; await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
  }
  const bodyBefore = await page.evaluate(() => document.body.innerText.length);
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('dash-card-pending-prs').waitFor();
  await page.waitForTimeout(400);
  check('returning shows no empty loading spinner while feeds refresh', await spinners() === 0);
  check('the previous content is visible at once', (await page.locator('main').innerText()).length > 500 && bodyBefore > 0);
  await page.waitForTimeout(2200);
  check('feeds were refreshed in the background', delayed >= 3);
  check('still no spinner after the refresh', await spinners() === 0);

  // A cold load (no earlier result) still shows its loading state.
  await page.route('**/api/team-activity/summary*', async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
  await page.goto(`${web}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('dash-card-pending-prs').waitFor();
  check('a cold load still shows the loading state', await spinners() > 0);
} catch (error) { console.error(error); total++; } finally { await browser.close(); }
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
