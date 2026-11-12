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
  await browser.close();
}
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
