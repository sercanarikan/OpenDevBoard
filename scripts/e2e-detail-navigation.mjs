// Synthetic fixture checks: one open detail at a time, closed on page change, dismissible, list state preserved.
import { chromium } from 'playwright';

const web = process.env.WEB_URL;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let passed = 0, total = 0;
function check(name, ok) { total++; if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
const workItemDetail = () => page.getByTestId('inspector');
const prDetail = () => page.getByTestId('pr-inspector');

try {
  await page.goto(`${web}/tasks`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('explorer-row').first().waitFor();

  // Open a work item, move to Pull Requests without closing it, select a PR.
  await page.getByTestId('explorer-row').first().click();
  await workItemDetail().waitFor();
  await page.getByTestId('nav-pull-requests').click();
  await page.getByTestId('pr-filter-all').waitFor();
  check('work item detail closes when moving to Pull Requests', await workItemDetail().count() === 0);
  await page.getByTestId('pr-row').first().click();
  await prDetail().waitFor();
  check('only the selected pull request detail is shown', await prDetail().count() === 1 && await workItemDetail().count() === 0);

  // Coming back must not revive the earlier work item.
  await page.getByTestId('nav-explorer').click();
  await page.getByTestId('explorer-row').first().waitFor();
  check('pull request detail closes when moving to Work Items', await prDetail().count() === 0);
  check('work item detail is not revived on return', await workItemDetail().count() === 0);

  // Switching records in one list replaces the detail.
  const rows = page.getByTestId('explorer-row');
  const firstId = await rows.nth(0).getAttribute('data-id');
  const secondId = await rows.nth(1).getAttribute('data-id');
  await rows.nth(0).click();
  await page.locator(`[data-testid="inspector"][data-id="${firstId}"]`).waitFor();
  await rows.nth(1).click();
  await page.locator(`[data-testid="inspector"][data-id="${secondId}"]`).waitFor();
  check('selecting another record replaces the detail', await workItemDetail().count() === 1);

  // Dismiss with the mouse and with the keyboard; the list keeps its page and its filter.
  await page.getByTestId('explorer-next').click();
  await page.getByTestId('explorer-page').getByText(/2/).first().waitFor();
  const pageLabel = await page.getByTestId('explorer-page').innerText();
  const firstRowId = await page.getByTestId('explorer-row').first().getAttribute('data-id');
  await page.getByTestId('explorer-row').first().click();
  await workItemDetail().waitFor();
  await page.getByTestId('inspector-close').click();
  check('close button dismisses the detail', await workItemDetail().count() === 0);
  check('closing keeps the page', await page.getByTestId('explorer-page').innerText() === pageLabel
    && await page.getByTestId('explorer-row').first().getAttribute('data-id') === firstRowId);
  await page.getByTestId('explorer-row').first().click();
  await workItemDetail().waitFor();
  await page.keyboard.press('Escape');
  check('Escape dismisses the detail', await workItemDetail().count() === 0);

  const search = page.getByPlaceholder(/ara|search/i).first();
  await search.fill('needle');
  await page.getByTestId('explorer-row').first().waitFor();
  const filteredRange = await page.getByTestId('explorer-range').innerText();
  await page.getByTestId('explorer-row').first().click();
  await workItemDetail().waitFor();
  await page.getByTestId('inspector-close').click();
  check('closing keeps the filter and its result range', await search.inputValue() === 'needle'
    && await page.getByTestId('explorer-range').innerText() === filteredRange);

  // Same on the Pull Requests page, including Escape.
  await page.getByTestId('nav-pull-requests').click();
  await page.getByTestId('pr-filter-all').click();
  await page.getByTestId('pr-row').first().click();
  await prDetail().waitFor();
  await page.keyboard.press('Escape');
  check('Escape dismisses the pull request detail', await prDetail().count() === 0);
  await page.getByTestId('pr-row').nth(1).click();
  await page.getByTestId('pr-row').nth(0).click();
  check('switching pull requests keeps a single detail', await prDetail().count() === 1);

  // A work item opened from a pull request replaces the PR detail instead of sitting next to it.
  const linkedButtons = page.getByTestId('pr-linked-work-item');
  if (await linkedButtons.count() === 0) {
    const prCount = await page.getByTestId('pr-row').count();
    for (let i = 0; i < prCount && await linkedButtons.count() === 0; i++) await page.getByTestId('pr-row').nth(i).click();
  }
  if (await linkedButtons.count() > 0) {
    await linkedButtons.first().click();
    await workItemDetail().waitFor();
    check('a linked work item replaces the pull request detail', await prDetail().count() === 0 && await workItemDetail().count() === 1);
  } else {
    check('fixture has a pull request with a linked work item', false);
  }
} catch (error) { console.error(error); total++; } finally { await browser.close(); }
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
