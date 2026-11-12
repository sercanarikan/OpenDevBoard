// Run against the isolated fixture stack with deterministic history responses.
import { chromium } from 'playwright';

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
  await page.clock.setFixedTime(new Date('2026-11-11T23:30:00Z'));
  await page.route('**/api/my-history/summary?*', route => route.fulfill({ json: {
    periodDays: 30, totalEvents: 1, totalMatchingEvents: 1, completedWorkItems: 0,
    commitsCount: 1, prsCount: 0, reviewsCount: 0, projectsTouched: [], dailyHeatmap: []
  } }));
  await page.route('**/api/my-history/timeline?*', route => route.fulfill({ json: {
    items: [{ id: 'fixture-event', eventType: 'git.commit', occurredAt: '2026-11-11T23:00:00Z',
      project: 'Fixture', entity: { type: 'commit', id: 'fixture-event', title: 'Fixture event' },
      summary: 'Synthetic event', actor: { displayName: 'Fixture' } }],
    total: 1, limit: 25, offset: 0, hasMore: false
  } }));
  await page.goto(`${process.env.WEB_URL}/my-history`, { waitUntil: 'networkidle' });
  const timeline = page.getByTestId('history-timeline');
  await timeline.waitFor();
  check('initial response groups event under today', await timeline.getByText('Bugün', { exact: true }).count() === 1);
  check('initial response renders the event', await timeline.getByTestId('history-event-card').count() === 1);

  await page.clock.setFixedTime(new Date('2026-11-12T00:30:00Z'));
  check('clock change alone preserves the current snapshot', await timeline.getByText('Bugün', { exact: true }).count() === 1);
  await page.getByTitle('Yenile', { exact: true }).last().click();
  await timeline.getByText('Dün', { exact: true }).waitFor();
  check('refresh groups the new snapshot under yesterday', await timeline.getByText('Dün', { exact: true }).count() === 1);
  check('refresh retains the event', await timeline.getByTestId('history-event-card').count() === 1);
} catch (error) {
  console.error(error);
  total++;
} finally {
  await browser.close();
}
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
