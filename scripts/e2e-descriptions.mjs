// Synthetic fixture checks: full PR description, Bug/Task descriptions, empty vs. failed-to-load.
import { chromium } from 'playwright';

const web = process.env.WEB_URL;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let passed = 0, total = 0;
function check(name, ok) { total++; if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }

async function openWorkItem(id) {
  await page.getByTestId('explorer-row').first().waitFor();
  const row = page.locator(`[data-testid="explorer-row"][data-id="${id}"]`);
  if (await row.count()) await row.click();
  else {
    await page.getByTestId('explorer-open-id').fill(String(id));
    await page.getByTestId('explorer-open-id').press('Enter');
  }
  await page.locator(`[data-testid="inspector"][data-id="${id}"]`).waitFor();
}

try {
  const items = (await (await page.request.get(`${web}/api/work-items?page_size=100`)).json()).items;
  const bug = items.find(i => i.type === 'Bug');
  const task = items.find(i => i.type === 'Task');
  check('fixture offers a Bug and a Task', !!bug && !!task);

  await page.goto(`${web}/tasks`, { waitUntil: 'domcontentloaded' });
  await openWorkItem(task.id);
  const taskDesc = page.getByTestId('work-item-description');
  await taskDesc.getByTestId('description').waitFor();
  check('Task description is rendered as HTML, not raw markup', (await taskDesc.innerText()).includes('Fixture task in') && !(await taskDesc.innerText()).includes('<p>'));

  await openWorkItem(bug.id);
  const bugDesc = page.getByTestId('work-item-description');
  await bugDesc.getByTestId('description').waitFor();
  check('Bug repro steps are shown as a list', await bugDesc.locator('ol li').count() === 2);
  check('Bug shows its repro steps label and expected text', (await bugDesc.innerText()).includes('Expected: it saves'));

  // Empty is not the same as failed to load.
  await page.route(`**/api/work-items/${bug.id}`, route => route.fulfill({ json: { ...bug, description: '', reproSteps: '', descriptionStatus: 'empty' } }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openWorkItem(bug.id);
  await page.getByTestId('description-empty').waitFor();
  check('confirmed empty description says so', await page.getByTestId('description-error').count() === 0);
  await page.unroute(`**/api/work-items/${bug.id}`);
  // Request 1 is the open-by-id lookup; request 2 is the inspector's own detail load, which fails here.
  let fail = true;
  let requests = 0;
  await page.route(`**/api/work-items/${bug.id}`, route => (fail && ++requests === 2)
    ? route.fulfill({ status: 503, json: { error: 'synthetic' } }) : route.continue());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openWorkItem(bug.id);
  await page.getByTestId('description-error').waitFor();
  check('load failure is an error, not "empty"', await page.getByTestId('description-empty').count() === 0);
  fail = false;
  await page.getByTestId('description-retry').click();
  await page.getByTestId('work-item-description').locator('ol li').first().waitFor();
  check('retry loads the description', true);
  await page.unroute(`**/api/work-items/${bug.id}`);

  // Long PR description, rendered safely and read in full.
  await page.goto(`${web}/pull-requests`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('pr-filter-all').click();
  await page.locator('[data-testid="pr-row"][data-id="101"]').click();
  const pr = page.getByTestId('pr-inspector');
  await pr.getByTestId('description').waitFor();
  await pr.getByTestId('description-toggle').click();
  const text = await pr.getByTestId('description').innerText();
  check('long PR description is complete', text.includes('Synthetic change 24') && text.includes('See the design note'));
  check('PR Markdown is rendered (heading, list, code)', await pr.locator('.rich-text h2').count() >= 2 && await pr.locator('.rich-text li').count() >= 24 && await pr.locator('.rich-text pre').count() === 1);
  check('script in a description is blocked', await pr.locator('script').count() === 0 && !text.includes("alert('blocked')"));
  check('description links open safely', (await pr.locator('.rich-text a').first().getAttribute('rel')) === 'noopener noreferrer');
} catch (error) { console.error(error); total++; } finally { await browser.close(); }
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
