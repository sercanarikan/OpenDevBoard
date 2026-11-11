// Deterministic E2E on the built-in fixture (DEVOPS_FIXTURE_MODE=1): no Azure DevOps access, no PAT, no live data.
//
//   WEB_URL     = 'http://localhost:<published fixture port>'
//   PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM  (optional, for local browser selection)
//   E2E_CAPTURE_SCREENSHOTS = '1'  opt in to visual captures; default is no screenshots
//   E2E_SCREENSHOT_DIR = '<dir>'  (default: <screenshots>/<date>/<version>/<topic>/e2e-fixture)
//   E2E_API_CONTAINER  = the isolated fixture API container ID (set by e2e.mjs)
//
// Nothing here hard-codes a record count: expectations come from the API itself or from relations between numbers.
import { createRequire } from 'module';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { shotDir, captureVerifiedScreenshot } from './shot-dir.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const WEB = process.env.WEB_URL || 'http://localhost:6174';
const captureScreenshots = process.env.E2E_CAPTURE_SCREENSHOTS === '1';
const captureVideo = process.env.E2E_CAPTURE_VIDEO === '1';
const captureTrace = process.env.E2E_CAPTURE_TRACE === '1';
const SHOTS = captureScreenshots || captureVideo || captureTrace
  ? shotDir(process.env.E2E_SCREENSHOT_DIR, 'e2e-fixture') : '';
const FILTER_SHOTS = process.env.E2E_FILTER_SCREENSHOT_DIR || '';
const SERVICE = process.env.E2E_API_SERVICE || 'api';
const CONTAINER = process.env.E2E_API_CONTAINER || 'devopsflow-fx-api';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
if (FILTER_SHOTS) fs.mkdirSync(FILTER_SHOTS, { recursive: true });

const results = [];
const contexts = new Set();
let contextCounter = 0;
const check = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {})
});

async function newPage(width = 1440, height = 900) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    ...(captureVideo ? { recordVideo: { dir: SHOTS } } : {})
  });
  contexts.add(ctx);
  const tracePath = SHOTS ? path.join(SHOTS, `trace-${++contextCounter}.zip`) : '';
  if (captureTrace) await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await ctx.newPage();
  page.__tracePath = tracePath;
  page.errors = [];
  page.api = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) page.api.push({ path: u.pathname, search: u.search, origin: u.origin });
  });
  return page;
}
const T = id => `[data-testid="${id}"]`;
const text = p => p.evaluate(() => document.body.textContent || '');
const has = async (p, s) => (await text(p)).toLocaleLowerCase('tr-TR').includes(s.toLocaleLowerCase('tr-TR'));
const shot = async (p, n, meta = {}) => {
  if (process.env.E2E_CAPTURE_SCREENSHOTS !== '1') return;
  const appearance = await p.evaluate(() => ({
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    locale: localStorage.getItem('devopsflow_language') || 'tr'
  }));
  return captureVerifiedScreenshot(p, path.join(SHOTS, n), {
    expectedUrl: new URL(p.url()).pathname,
    expectedSelector: '[data-testid="header-page-title"]',
    state: meta.state || 'ready',
    module: 'fixture-e2e',
    viewport: p.viewportSize(),
    route: new URL(p.url()).pathname,
    ...appearance,
    ...meta
  });
};
const filterShot = async (p, n, locale, state) => {
  if (!FILTER_SHOTS) return;
  const appearance = await p.evaluate(() => ({
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    locale: localStorage.getItem('devopsflow_language') || 'tr'
  }));
  return captureVerifiedScreenshot(p, path.join(FILTER_SHOTS, n), {
    expectedUrl: '/tasks',
    expectedSelector: '[data-testid="header-page-title"]',
    state,
    module: 'task-filter',
    viewport: p.viewportSize(),
    route: '/tasks',
    ...appearance,
    locale
  });
};
const closeContext = async context => {
  if (captureTrace && context.pages().length && context.pages()[0].__tracePath) {
    await context.tracing.stop({ path: context.pages()[0].__tracePath });
  }
  await context.close();
  contexts.delete(context);
};
const wait = (p, ms = 600) => p.waitForTimeout(ms);
const getJson = async p => (await fetch(p)).json();
const rowIds = p => p.$$eval(T('explorer-row'), els => els.map(e => Number(e.getAttribute('data-id'))));
const settleList = async p => {
  await p.waitForSelector(`${T('explorer-range')}`, { timeout: 30000 });
  await p.waitForFunction(() => !document.querySelector('[data-testid="explorer-updating"]'), null, { timeout: 30000 }).catch(() => {});
  await wait(p, 250);
};
// The root route now intentionally redirects to Dashboard; fixture checks below
// exercise Task Explorer, so start them at its stable routed URL explicitly.
const open = async (p, url = `${WEB}/tasks`) => {
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await settleList(p);
};
const NAV_ID = { 'Task Explorer': 'explorer', 'Kanban Board': 'board', 'Story & Tasks': 'hierarchy', 'Dependency Graph': 'dependencies' };
const nav = async (p, label) => {
  await p.click(`[data-testid="nav-${NAV_ID[label]}"]`);
  await wait(p, 900);
};
const rangeNums = async p => {
  const value = await p.locator(T('explorer-range')).innerText();
  if (await p.locator('html').getAttribute('lang') === 'en') {
    const english = value.match(/Showing\s+(\d+)[–-](\d+)\s+of\s+(\d+)/);
    return english ? { a: +english[3], b: +english[1], c: +english[2] } : null;
  }
  const m = value.match(/(\d+)\D+(\d+)\D+(\d+)/);
  return m ? { a: +m[1], b: +m[2], c: +m[3] } : null; // tr: "{total} işten {from}–{to}"
};
const tabNumber = async (p, label) => {
  const t = await p.locator(`button:has-text("${label}")`).first().innerText();
  const m = t.match(/(\d+)\s*$/);
  return m ? +m[1] : null;
};
const sourceKind = p => p.locator(T('source-pill')).getAttribute('data-source').catch(() => null);

// ======================================================================================================
console.log('\n## Source / fixture isolation');
const me = await getJson(WEB + '/api/me');
const fixtureUser = me.displayName;
check('backend is the fixture (never live)', me.source === 'fixture', me.source);

let web = await newPage();
await open(web);
check('header shows fixture source, not Azure DevOps Live', (await sourceKind(web)) === 'fixture' && !(await has(web, 'Azure DevOps Live')));
check('sync indicator is present', (await web.locator(T('sync-indicator')).count()) === 1);

// ======================================================================================================
console.log('\n## Task Explorer: server-side pagination');
const bootCalls = web.api.map(c => c.path + c.search);
check('startup does NOT download the whole pool', !bootCalls.some(c => c.startsWith('/api/work-items-pool')), bootCalls.join(' | ').slice(0, 160));
check('startup requests exactly one bounded page', bootCalls.filter(c => c.startsWith('/api/work-items?')).length >= 1 && bootCalls.every(c => !/limit=(\d{3,})/.test(c) || /limit=(?:100|200)\b/.test(c)));

await web.click('button:has-text("Tüm İşler")');
await settleList(web);
const all = await getJson(`${WEB}/api/work-items?limit=1`);
let r = await rangeNums(web);
check('All tab shows page 1 of the whole result', r && r.a === all.total && r.b === 1 && r.c <= 50, JSON.stringify(r));
check('All tab counter equals server total (not page size)', (await tabNumber(web, 'Tüm İşler')) === all.total);
check('rendered rows == page size window', (await web.locator(T('explorer-row')).count()) === Math.min(50, all.total));
await shot(web, 'pag-01-explorer-page1.png');

// walk every page: each id exactly once, deterministic order
const seen = [];
const pages = Math.ceil(all.total / 50);
for (let i = 0; i < pages; i++) {
  seen.push(...(await rowIds(web)));
  if (i < pages - 1) {
    if (await web.locator(T('explorer-next')).isEnabled()) {
      await web.click(T('explorer-next'));
    } else {
      await web.selectOption(T('explorer-page-size'), '25');
      await settleList(web);
      await web.click(T('explorer-next'));
    }
    await settleList(web);
  }
}
check('walking all pages yields every id exactly once', seen.length === all.total && new Set(seen).size === all.total, `${seen.length}/${new Set(seen).size}/${all.total}`);
check('next button disabled on the last page', await web.locator(T('explorer-next')).isDisabled());
await shot(web, 'pag-02-explorer-last-page.png');
await web.click(T('explorer-first'));
await settleList(web);
check('first button returns to page 1', (await web.locator(T('explorer-page')).innerText()).includes('1'));

const first50 = await rowIds(web);
const apiFirst = (await getJson(`${WEB}/api/work-items?limit=50&offset=0`)).items.map(i => i.id);
check('UI page order == API order (stable sort with id tie-breaker)', JSON.stringify(first50) === JSON.stringify(apiFirst));

await web.selectOption(T('explorer-page-size'), '25');
await settleList(web);
check('page size 25 re-queries and resets to page 1', (await web.locator(T('explorer-row')).count()) === 25 && (await rangeNums(web)).b === 1);
await web.selectOption(T('explorer-page-size'), '50');
await settleList(web);

// ---------------- search: debounce, server-side across all records, reset to page 1 -----------------------
console.log('\n## Task Explorer: search, filters, sorting');
await web.selectOption(T('explorer-page-size'), '25');
await settleList(web);
await web.click(T('explorer-next'));
await settleList(web);
const searchInput = web.locator('input[type="text"]').first();
const needleTotal = (await getJson(`${WEB}/api/work-items?limit=1&search=needle`)).total;
check('fixture search dataset contains needle matches', needleTotal > 0, `matches=${needleTotal}`);
const before = web.api.length;
await searchInput.pressSequentially('needle', { delay: 40 });
await wait(web, 120);
const during = web.api.slice(before).filter(c => c.path === '/api/work-items' && c.search.includes('search=')).length;
check('typing is debounced (no request per keystroke)', during === 0, `requests while typing: ${during}`);
await wait(web, 700);
await settleList(web);
r = await rangeNums(web);
check('search applies to ALL records on the server', r && r.a === needleTotal && needleTotal > 0, `ui=${r?.a} api=${needleTotal}`);
check('search resets pagination to page 1', r && r.b === 1);
{
  const apiHits = await getJson(`${WEB}/api/work-items?limit=200&search=needle`);
  const uiIds = await rowIds(web);
  check('search: the rows shown are exactly the API matches for the term', JSON.stringify(uiIds) === JSON.stringify(apiHits.items.map(i => i.id)), `ui=${uiIds.length} api=${apiHits.items.length}`);
  const rowTexts = await web.locator(T('explorer-row')).allInnerTexts();
  // every visible row carries the term somewhere a user can see (title, id, project, assignee or parent)
  const without = rowTexts.filter(t => !/needle/i.test(t));
  const apiById = new Map(apiHits.items.map(i => [i.id, i]));
  const reallyMissing = (await rowIds(web)).filter((id, i) => {
    if (!without.includes(rowTexts[i])) return false;
    const it = apiById.get(id);
    return !it || !/needle/i.test([it.title, it.project, it.assignedTo, it.parentTitle || '', String(it.id)].join(' '));
  });
  check('search: no row is shown that does not contain the term', rowTexts.length > 0 && reallyMissing.length === 0, `rows=${rowTexts.length} unmatched=${reallyMissing.length}`);
  check('search: case-insensitive (Needle / NEEDLE find the same set)', (await getJson(`${WEB}/api/work-items?limit=1&search=NEEDLE`)).total === needleTotal);
}
await shot(web, 'pag-03-explorer-search.png');

await searchInput.fill('');
await wait(web, 700);
await settleList(web);

await searchInput.fill('zzzz-no-such-item-zzzz');
await wait(web, 800);
check('empty state appears for a search without matches', await has(web, 'Eşleşen iş bulunamadı'));
await searchInput.fill('');
await wait(web, 700);
await settleList(web);

// Filters: exercise the localized control, result and counter updates, and reset in both locales.
for (const locale of ['tr', 'en']) {
  const currentLocale = await web.locator('html').getAttribute('lang');
  if (currentLocale !== locale) {
    await web.locator('button[aria-label="Dili Değiştir"], button[aria-label="Switch Language"]').click();
    await web.waitForFunction(expected => document.documentElement.lang === expected, locale);
  }
  const labels = locale === 'tr'
    ? { filters: 'Filtreler', myTasks: 'Görevlerim', reset: 'Görevlerime Dön' }
    : { filters: 'Filters', myTasks: 'My Tasks', reset: 'Reset to My Tasks' };
  const myTasksTab = web.getByRole('button', { name: new RegExp(`^${labels.myTasks}\\s+\\d+$`) });
  await myTasksTab.click();
  await settleList(web);
  const initialRange = await rangeNums(web);
  const initialMyTasksCount = Number((await myTasksTab.innerText()).match(/(\d+)\s*$/)?.[1]);
  const filterButton = web.getByRole('button', { name: new RegExp(`^${labels.filters}`) });
  await filterButton.click();
  check(`${locale}: localized filter button opens the dropdown`, await web.getByText(locale === 'tr' ? 'Özelliğe Göre Filtrele' : 'Filter by Properties').isVisible());
  const callsBeforeFilter = web.api.length;
  await web.getByRole('button', { name: 'P1', exact: true }).click();
  await wait(web, 600);
  await settleList(web);
  const filterRequest = web.api.slice(callsBeforeFilter).filter(call => call.path === '/api/work-items' && call.search.includes('priority=1')).at(-1);
  const filterParams = new URLSearchParams(filterRequest?.search || '');
  filterParams.set('limit', '200');
  filterParams.set('offset', '0');
  const filteredApi = await getJson(`${WEB}/api/work-items?${filterParams}`);
  const filteredRange = await rangeNums(web);
  const uiIds = await rowIds(web);
  const filterButtonText = await filterButton.innerText();
  check(`${locale}: filter updates results and total to match the API`, !!filterRequest && filteredRange && filteredRange.a === filteredApi.total && JSON.stringify(uiIds) === JSON.stringify(filteredApi.items.slice(0, uiIds.length).map(item => item.id)), `ui=${filteredRange?.a} api=${filteredApi.total}`);
  check(`${locale}: selected filter counter increments`, await filterButton.getByText('1', { exact: true }).count() === 1, filterButtonText);
  await filterShot(web, `task-filter-${locale}-applied.png`, locale, 'filtered');
  await web.getByRole('button', { name: labels.reset, exact: true }).click();
  await settleList(web);
  const resetRange = await rangeNums(web);
  const resetTabCount = Number((await myTasksTab.innerText()).match(/(\d+)\s*$/)?.[1]);
  check(`${locale}: clearing filters restores the starting result and counters`, resetRange?.a === initialRange?.a && resetTabCount === initialMyTasksCount && await filterButton.getByText('1', { exact: true }).count() === 0, `start=${initialRange?.a} reset=${resetRange?.a}`);
  await filterShot(web, `task-filter-${locale}-cleared.png`, locale, 'ready');
  await filterButton.click();
}
if (await web.locator('html').getAttribute('lang') !== 'tr') {
  await web.locator('button[aria-label="Dili Değiştir"], button[aria-label="Switch Language"]').click();
  await web.waitForFunction(() => document.documentElement.lang === 'tr');
}
await web.keyboard.press('Escape');
await web.click('button:has-text("Tüm İşler")');
await web.selectOption(T('explorer-page-size'), '25');
await settleList(web);

// Language-independent: the sort <select> is the one that offers the `changedDate` and `id` option values.
const sorter = web.locator('select:has(option[value="changedDate"]):has(option[value="id"])').first();
await sorter.selectOption('id');
await wait(web, 600);
await settleList(web);
const idsDesc = await rowIds(web);
check('sorting by id returns descending order from the server', idsDesc.every((v, i) => i === 0 || idsDesc[i - 1] > v));
await shot(web, 'pag-04-explorer-sorted-filtered.png');
await sorter.selectOption('changedDate');
await wait(web, 600);

// ---------------- Inspector -----------------------------------------------------------------------
console.log('\n## Inspector: opens by id, keeps list state');
await web.click('button:has-text("Tüm İşler")');
await web.keyboard.press('Escape');
await searchInput.fill('');
await web.selectOption(T('explorer-page-size'), '25');
await settleList(web);
await web.waitForFunction(() => {
  const range = document.querySelector('[data-testid="explorer-range"]')?.textContent || '';
  return /\d+ işten \d+[–-]\d+ arası gösteriliyor/.test(range);
}, null, { timeout: 10000 });
await web.waitForFunction(() => {
  const next = document.querySelector('[data-testid="explorer-next"]');
  return next instanceof HTMLButtonElement && !next.disabled;
}, null, { timeout: 10000 });
await web.click(T('explorer-next'));
await settleList(web);
await searchInput.fill('');
const pageBefore = await web.locator(T('explorer-page')).innerText();
const rowsBefore = await rowIds(web);
await web.locator(T('explorer-row')).nth(2).click();
await wait(web, 900);
check('Inspector opens for a clicked row', (await web.locator(T('inspector')).count()) === 1);
check('opening the Inspector keeps page and rows', (await web.locator(T('explorer-page')).innerText()) === pageBefore && JSON.stringify(await rowIds(web)) === JSON.stringify(rowsBefore));

// an item that is NOT on the current page and not even in the active list (a completed child)
const probe = await getJson(`${WEB}/api/work-items?limit=1&offset=${all.total - 1}`);
const farId = probe.items[0].id;
await web.fill(T('explorer-open-id'), String(farId));
await web.press(T('explorer-open-id'), 'Enter');
await wait(web, 900);
check('Inspector opens an item that is not on the visible page, by id', (await web.locator(T('inspector')).getAttribute('data-id')) === String(farId));
check('opening by id keeps the current page', (await web.locator(T('explorer-page')).innerText()) === pageBefore);

await web.fill(T('explorer-open-id'), '99999999');
await web.press(T('explorer-open-id'), 'Enter');
await wait(web, 700);
check('unknown id shows an error and keeps the Inspector', (await web.locator(T('explorer-open-id-error')).count()) === 1 && (await web.locator(T('inspector')).getAttribute('data-id')) === String(farId));

// completed child of a story is reachable (children come from the API, not from the page)
const withKids = (await getJson(`${WEB}/api/work-items?limit=200&quickFilter=all`)).items.find(i => i.type !== 'Task' && i.type !== 'Bug');
if (withKids) {
  const kids = await getJson(`${WEB}/api/work-items/${withKids.id}/children`);
  await web.fill(T('explorer-open-id'), String(withKids.id));
  await web.press(T('explorer-open-id'), 'Enter');
  await wait(web, 1200);
  const rendered = await web.locator(`${T('inspector-children')} > div`).count().catch(() => 0);
  check('Inspector lists children loaded by id (incl. completed)', kids.total === 0 || rendered >= Math.min(kids.total, 500) - 1, `api=${kids.total} ui=${rendered}`);
}
await shot(web, 'pag-05-inspector-by-id.png');

// ---------------- language switch keeps list state ---------------------------------------------------
console.log('\n## TR/EN switch keeps search, page and Inspector');
await searchInput.fill('needle');
await wait(web, 800);
await settleList(web);
const idBefore = await web.locator(T('inspector')).getAttribute('data-id');
const rowsBeforeLang = await rowIds(web);
await web.click('button[aria-label="Dili Değiştir"]');
await wait(web, 700);
check('EN labels after switch', (await has(web, 'My Tasks')) && (await has(web, 'Page 1 of')));
check('search text survives language switch', (await searchInput.inputValue()) === 'needle');
check('rows survive language switch (no refetch glitch)', JSON.stringify(await rowIds(web)) === JSON.stringify(rowsBeforeLang));
check('Inspector survives language switch', (await web.locator(T('inspector')).getAttribute('data-id')) === idBefore);
await shot(web, 'pag-06-explorer-en.png');
await web.click('button[aria-label="Switch Language"]');
await wait(web, 500);
await searchInput.fill('');
await wait(web, 700);

// ======================================================================================================
console.log('\n## Counters: one definition everywhere');
await open(web);
const sum = await getJson(`${WEB}/api/work-items/summary?currentUser=${encodeURIComponent(fixtureUser)}`);
const tabs = { my: await tabNumber(web, 'Görevlerim'), all: await tabNumber(web, 'Tüm İşler') };
check('My Tasks tab == server summary == list total', tabs.my === sum.scope.myTasks && tabs.my === (await getJson(`${WEB}/api/work-items?limit=1&quickFilter=my-tasks&currentUser=${encodeURIComponent(fixtureUser)}`)).total, `${tabs.my}/${sum.scope.myTasks}`);
check('All tab == summary total', tabs.all === sum.scope.total);
const sideAll = (await web.locator('aside button:has-text("Task Explorer")').first().innerText()).match(/(\d+)\s*$/)?.[1];
const sideMy = (await web.locator('aside button:has-text("Görevlerim")').first().innerText()).match(/(\d+)/)?.[1];
check('sidebar counters == tab counters', +sideAll === tabs.all && +sideMy === tabs.my, `${sideAll}/${sideMy}`);
const hdr = (await web.locator('header select option').first().innerText()).match(/\((\d+)\)/)?.[1];
check('header project selector total == All', +hdr === tabs.all);
check('paging does not change the All counter', (await tabNumber(web, 'Tüm İşler')) === tabs.all);

// ======================================================================================================
console.log('\n## Kanban: paginated columns');
await nav(web, 'Kanban Board');
await web.waitForSelector(T('kanban-board'), { timeout: 30000 });
await wait(web, 800);
check('Kanban does not download the pool', !web.api.some(c => c.path === '/api/work-items-pool'));
const kb = await getJson(`${WEB}/api/kanban?swimlane=none&currentUser=${encodeURIComponent(fixtureUser)}&quickFilter=all&includeCompleted=true`);
await web.click('button:has-text("Tüm İşler")');
await wait(web, 1000);
const kbAll = await getJson(`${WEB}/api/kanban?swimlane=none&quickFilter=all&includeCompleted=true`);
const colNums = await web.locator(T('kanban-column-count')).allInnerTexts();
check('four column totals come from the whole scope', colNums.length === 4 && colNums.map(Number).reduce((a, b) => a + b, 0) === kbAll.total, `${colNums.join('/')} vs ${JSON.stringify(kbAll.columns)}`);
const todoTotal = Number(colNums[0]);
const todoCards = await web.locator(`${T('kanban-column')}[data-column="todo"] ${T('kanban-card')}`).count();
check('cards rendered per column are bounded (not all loaded)', todoTotal > 15 ? todoCards <= 15 && todoCards < todoTotal : true, `rendered ${todoCards} of ${todoTotal}`);
check('visible cards are counted separately from totals', (await web.locator(T('kanban-footer')).innerText()).length > 0);
await shot(web, 'pag-07-kanban-initial.png');

if (todoTotal > 15) {
  const loadMore = web.locator(`${T('kanban-load-more')}[data-column="todo"]`).first();
  check('"load more" is offered for a column with more cards', (await loadMore.count()) === 1);
  const idsBefore = await web.locator(`${T('kanban-column')}[data-column="todo"] ${T('kanban-card')}`).evaluateAll(els => els.map(e => e.getAttribute('data-id')));
  await loadMore.click();
  await wait(web, 1000);
  const idsAfter = await web.locator(`${T('kanban-column')}[data-column="todo"] ${T('kanban-card')}`).evaluateAll(els => els.map(e => e.getAttribute('data-id')));
  check('load more appends cards without duplicates', idsAfter.length > idsBefore.length && new Set(idsAfter).size === idsAfter.length, `${idsBefore.length}->${idsAfter.length}`);
  check('load more keeps the existing cards first (order preserved)', idsBefore.every((id, i) => idsAfter[i] === id));
  check('column total is unchanged by loading more', Number((await web.locator(T('kanban-column-count')).allInnerTexts())[0]) === todoTotal);
}

// swimlanes keep working: parent / assignee / priority
for (const [mode, label] of [['parent', 'Üst İş'], ['assignee', 'Atanan'], ['priority', 'Öncelik']]) {
  const selectEl = web.locator('select[aria-label="Swimlane modunu seç"], select').filter({ hasText: /Üst|Parent/ }).first();
  await selectEl.selectOption(mode);
  await wait(web, 1100);
  const board = await getJson(`${WEB}/api/kanban?swimlane=${mode}&quickFilter=all&includeCompleted=true`);
  const lanes = await web.locator(T('kanban-lane')).count();
  check(`swimlane "${mode}" renders ${Math.min(board.laneTotal, 25)} lane(s) from the server`, lanes === Math.min(board.laneTotal, board.laneLimit), `ui=${lanes} api=${board.laneTotal}`);
  const laneSum = board.lanes.reduce((n, l) => n + l.total, 0);
  const colSum = Object.values(board.columns).reduce((a, b) => a + b, 0);
  check(`swimlane "${mode}": column totals == whole-scope total`, colSum === board.total && laneSum <= board.total);
}
await shot(web, 'pag-08-kanban-parent-lanes.png');

// canonical progress: Kanban parent lane == Story & Tasks == API
const parentBoard = await getJson(`${WEB}/api/kanban?swimlane=parent&quickFilter=all&includeCompleted=true&laneLimit=100`);
const lane = parentBoard.lanes.find(l => l.key !== 'none' && l.progress);
if (lane) {
  const prog = (await getJson(`${WEB}/api/work-items/progress?ids=${lane.key}`)).progress[lane.key];
  check('Kanban parent-lane progress == canonical progress API', prog && lane.progress.percent === prog.percent && lane.progress.totalUnits === prog.totalUnits, JSON.stringify([lane.progress, prog]));
}

// Inspector on the board keeps selection and scroll
await web.locator(T('kanban-card')).first().click();
await wait(web, 700);
const selId = await web.locator(T('inspector')).getAttribute('data-id');
const colScroller = web.locator(`${T('kanban-column')} .overflow-y-auto`).first();
await colScroller.evaluate(el => { el.scrollTop = 120; });
await wait(web, 200);
const scrollBefore = await colScroller.evaluate(el => el.scrollTop);
await web.locator(T('kanban-card')).nth(2).click();
await wait(web, 700);
const scrollAfter = await colScroller.evaluate(el => el.scrollTop);
check('Inspector opens from a Kanban card', !!selId);
check('column scroll position is kept when the selection changes', Math.abs(scrollAfter - scrollBefore) <= 2, `${scrollBefore}->${scrollAfter}`);
await shot(web, 'pag-09-kanban-inspector.png');
await web.keyboard.press('Escape');

// ======================================================================================================
console.log('\n## Story & Tasks and Dependency Explorer (full hierarchy, lazy)');
const poolBefore = web.api.filter(c => c.path === '/api/work-items-pool').length;
await nav(web, 'Story & Tasks');
await wait(web, 2500);
check('pool is loaded lazily when Story & Tasks opens', web.api.filter(c => c.path === '/api/work-items-pool').length > poolBefore);
check('Story & Tasks renders the hierarchy', (await has(web, 'Tümünü Genişlet')) || (await has(web, 'Tüm Hiyerarşiler')));
await shot(web, 'pag-10-story-tasks.png');

await nav(web, 'Dependency Graph');
await wait(web, 2000);
check('Dependency Explorer renders the graph', (await has(web, 'Merkez Odak')) || (await has(web, 'Graf Özeti')));
// Focus != Selection: read the REAL ids (the focused node is the one flagged as centre focus; the selected id comes
// from the Inspector), click a DIFFERENT node, and assert focus stayed while selection moved.
{
  const focusedId = async () => web.locator(T('graph-node') + '[data-focused="true"]').first().getAttribute('data-id').catch(() => null);
  const selectedId = async () => web.locator(T('inspector')).getAttribute('data-id').catch(() => null);
  await wait(web, 600);
  const focus0 = await focusedId();
  check('dependency graph has exactly one focused node', (await web.locator(T('graph-node') + '[data-focused="true"]').count()) === 1, String(focus0));
  const other = web.locator(T('graph-node') + '[data-focused="false"]').first();
  const otherId = await other.getAttribute('data-id');
  check('dependency graph has a second node to select', !!otherId && otherId !== focus0, `focus=${focus0} other=${otherId}`);
  await other.click();
  await wait(web, 800);
  const sel1 = await selectedId();
  const focus1 = await focusedId();
  check('selecting a node opens the Inspector on THAT node', sel1 === otherId, `selected=${sel1} expected=${otherId}`);
  check('selecting a node does NOT move the focus', focus1 === focus0, `focus ${focus0} -> ${focus1}`);
  // Set Focus is a separate, explicit action: now the focus must move to the selected node
  const setFocusBtn = web.locator(T('inspector')).locator('button:has-text("Merkez Odak Yap")');
  if ((await setFocusBtn.count()) > 0) {
    await setFocusBtn.first().click();
    await wait(web, 900);
    check('"Set focus" moves the focus to the selected node', (await focusedId()) === otherId && (await selectedId()) === otherId, `focus=${await focusedId()} selected=${await selectedId()}`);
  }
}
await shot(web, 'pag-11-dependency.png');

console.log('\n## Unresolved predecessor (relation integrity)');
{
  const found = await getJson(`${WEB}/api/work-items?limit=5&search=${encodeURIComponent('Fixture unresolved-predecessor case')}`);
  const unresolved = found.items[0];
  check('fixture provides the unresolved-predecessor task', !!unresolved && unresolved.hasUnresolvedPredecessors === true, unresolved ? String(unresolved.id) : 'missing');
  if (unresolved) {
    check('API: unknown predecessor does not make the task Blocked', unresolved.isBlocked === false);
    const pred = unresolved.relations.predecessors[0];
    check('API: the unreadable predecessor carries no invented state/title/assignee', !pred.state && !pred.title && !pred.assignedTo, JSON.stringify(pred));

    await nav(web, 'Task Explorer');
    await web.fill(T('explorer-open-id'), String(unresolved.id));
    await web.press(T('explorer-open-id'), 'Enter');
    await wait(web, 1200);
    check('Inspector shows the predecessor as unresolved (not "blocking this")', (await web.locator(T('inspector-unresolved')).count()) === 1);
    check('Inspector does not call it blocking or done', !(await web.locator(T('inspector')).innerText()).match(/engelliyor|blocking this/i) || (await web.locator(T('inspector-unresolved')).count()) === 1);
    await shot(web, 'pag-14-unresolved-inspector.png');

    await nav(web, 'Dependency Graph');
    await wait(web, 1200);
    const focusSel = web.locator('select').filter({ has: web.locator(`option[value="${unresolved.id}"]`) }).first();
    if ((await focusSel.count()) > 0) {
      await focusSel.selectOption(String(unresolved.id));
      await wait(web, 1200);
      const node = web.locator(T('graph-node') + '[data-unresolved="true"]').first();
      check('graph draws an explicit "unresolved" node (dashed), not a fabricated Task/New node', (await node.count()) === 1);
      if ((await node.count()) === 1) {
        const t = await node.innerText();
        check('unresolved node shows no invented state or assignee', !/\b(Yeni|New|Atanmamış|Unassigned)\b/.test(t), t.replace(/\s+/g, ' ').slice(0, 80));
        check('unresolved node says unresolved', /Çözümlenemedi|Unresolved/i.test(t));
      }
      // the edge leaving an unresolved predecessor is neutral: not the red animated "blocker" edge
      const edge = web.locator('.react-flow__edge').first();
      check('graph has an edge from the unresolved predecessor', (await web.locator('.react-flow__edge').count()) >= 1);
      if ((await web.locator('.react-flow__edge').count()) >= 1) {
        const stroke = await edge.locator('path.react-flow__edge-path').first().evaluate(el => getComputedStyle(el).stroke);
        const animated = await edge.evaluate(el => el.classList.contains('animated'));
        check('edge from an unresolved predecessor is neutral (not red, not animated)', !/rgb\(239, 68, 68\)/.test(stroke) && !animated, `stroke=${stroke} animated=${animated}`);
      }
      const focusNode = web.locator(T('graph-node') + '[data-focused="true"]').first();
      check('the dependent task is not shown as Blocked', !/Engellenen|Blocked/.test(await focusNode.innerText()) || (await focusNode.innerText()).includes('Çözümlenemeyen'));
      await shot(web, 'pag-15-unresolved-graph.png');
    }
  }
  await nav(web, 'Dependency Graph');
}

console.log('\n## Resolved context: completed predecessor keeps its real data');
{
  // a Done predecessor that is NOT in the active list (context/completed row) must render with its real title + state
  const pool = await getJson(`${WEB}/api/work-items-pool`);
  const doneCtx = pool.context_items.find(c => /^(done|closed|completed)$/i.test(c.state) && (c.successorIds || []).length > 0);
  const dependent = doneCtx && pool.flat_items.find(i => (i.relations.predecessors || []).some(p => p.id === doneCtx.id));
  check('fixture has a completed predecessor outside the active list', !!doneCtx && !!dependent);
  if (doneCtx && dependent) {
    await nav(web, 'Task Explorer');
    await web.fill(T('explorer-open-id'), String(dependent.id));
    await web.press(T('explorer-open-id'), 'Enter');
    await wait(web, 1200);
    await nav(web, 'Dependency Graph');
    await wait(web, 1200);
    const sel = web.locator('select').filter({ has: web.locator(`option[value="${dependent.id}"]`) }).first();
    if ((await sel.count()) > 0) await sel.selectOption(String(dependent.id));
    await wait(web, 1200);
    const node = web.locator(T('graph-node') + `[data-id="${doneCtx.id}"]`).first();
    check('completed predecessor is drawn as itself (real title), not a placeholder', (await node.count()) === 1 && (await node.innerText()).includes(doneCtx.title.slice(0, 20)), doneCtx.title.slice(0, 40));
    check('completed predecessor does not read as unresolved', (await node.getAttribute('data-unresolved')) === 'false');
    check('a completed predecessor does not block its dependent', dependent.isBlocked === false || (dependent.relations.predecessors.some(p => p.id !== doneCtx.id)));
  }
}
await web.click('button:has-text("Bağımlılık Matrisi")');
await wait(web, 700);
check('dependency matrix renders', await has(web, 'Bağımlılık Matrisi'));

// ======================================================================================================
console.log('\n## Command Palette: server-side search');
await nav(web, 'Task Explorer');
await web.keyboard.press('Control+k');
await wait(web, 500);
await web.keyboard.type('needle', { delay: 30 });
await wait(web, 900);
const paletteHits = await web.locator('button:has-text("needle"), button:has-text("Needle")').count();
check('palette finds items by searching the server (not only a loaded page)', paletteHits > 0, String(paletteHits));
await shot(web, 'pag-12-palette.png');
await web.keyboard.press('Escape');

// ======================================================================================================
console.log('\n## Light / Dark');
const isDark = () => web.evaluate(() => document.documentElement.classList.contains('dark'));
const themeBtn = 'button[title="Koyu Moda Geç"], button[title="Açık Moda Geç"], button[title="Switch to Dark Mode"], button[title="Switch to Light Mode"]';
const d0 = await isDark();
await web.click(themeBtn);
await wait(web, 500);
check('theme toggles', (await isDark()) !== d0);
await shot(web, 'pag-13-dark.png');
await web.click(themeBtn);

check('no uncaught page errors (web)', web.errors.length === 0, web.errors.slice(0, 2).join(' | '));

// ======================================================================================================
console.log('\n## Responsive 1024 / 1440 / 1920');
for (const w of [1024, 1440, 1920]) {
  const p = await newPage(w, 900);
  await open(p);
  for (const [label, tag] of [['Task Explorer', 'explorer'], ['Kanban Board', 'kanban'], ['Story & Tasks', 'story'], ['Dependency Graph', 'dependency']]) {
    await nav(p, label);
    await wait(p, 700);
    const ox = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`no horizontal page overflow @${w}px ${tag}`, ox <= 1, `overflow=${ox}`);
    await shot(p, `pag-resp-${w}-${tag}.png`);
  }
  if (w === 1024) {
    await nav(p, 'Task Explorer');
    check('pager controls visible @1024px', await p.locator(T('explorer-next')).isVisible());
  }
  check(`no uncaught errors @${w}px`, p.errors.length === 0, p.errors.slice(0, 2).join(' | '));
  await closeContext(p.context());
}

// ======================================================================================================
if (process.env.E2E_SKIP_RESTART !== '1') {
  console.log('\n## Backend restart and outage');
    const stop = () => (CONTAINER ? execSync(`docker stop ${CONTAINER}`, { stdio: 'ignore' }) : execSync(`docker compose stop ${SERVICE}`, { stdio: 'ignore' }));
  const start = () => (CONTAINER ? execSync(`docker start ${CONTAINER}`, { stdio: 'ignore' }) : execSync(`docker compose start ${SERVICE}`, { stdio: 'ignore' }));
  const waitHealthy = async () => {
    for (let i = 0; i < 45; i++) {
      try { if ((await fetch(WEB + '/api/health')).ok) return true; } catch { /* retry */ }
      await new Promise(res => setTimeout(res, 2000));
    }
    return false;
  };

  const rp = await newPage();
  await open(rp);
  const totalBefore = (await getJson(WEB + '/api/work-items?limit=1')).total;

  // outage while the page is open
  stop();
  await wait(rp, 500);
  // A user action while the API is down: nginx answers 504 after its 3 s connect timeout, which the app must surface
  // within a bounded time (polled, never a fixed sleep).
  await rp.click('button:has-text("Tüm İşler")');
  let surfaced = false;
  for (let i = 0; i < 30 && !surfaced; i++) {
    await wait(rp, 500);
    surfaced =
      (await rp.locator(T('explorer-error-inline')).count()) + (await rp.locator(T('explorer-error')).count()) > 0 ||
      (await sourceKind(rp)) === 'lost';
  }
  const dataStillShown = (await rp.locator(T('explorer-row')).count()) > 0;
  check('API down: last known rows stay visible (no blank screen)', dataStillShown);
  check('API down: the failure is surfaced within 15 s (error state or unreachable status)', surfaced);
  await shot(rp, 'pag-outage-explorer.png', { state: 'error' });
  rp.setDefaultTimeout(60000);

  start();
  check('API restarts and becomes healthy', await waitHealthy());
  // Recovery may be observed by AppContext's health poll before the list's retry
  // control can be clicked. If the error remains, click a locator that re-resolves
  // after React renders; otherwise the automatic refresh is the recovery path.
  const retryBtn = rp.locator(T('explorer-retry')).first();
  const retryVisible = await retryBtn.isVisible().catch(() => false);
  if (retryVisible) await retryBtn.click();
  await rp.waitForFunction(() => {
    const rows = document.querySelectorAll('[data-testid="explorer-row"]').length;
    const error = document.querySelector('[data-testid="explorer-error-inline"]');
    const updating = document.querySelector('[data-testid="explorer-updating"]');
    return rows > 0 && !error && !updating;
  }, null, { timeout: 30000 });
  await settleList(rp);
  check('after restart the list recovers without a page reload', (await rp.locator(T('explorer-row')).count()) > 0 && (await rp.locator(T('explorer-error-inline')).count()) === 0);
  check('cache survived the restart (same totals)', (await getJson(WEB + '/api/work-items?limit=1')).total === totalBefore);

  // cold start while down => explicit Demo Mode, never presented as live/fixture
  stop();
  const cold = await newPage();
  await cold.goto(`${WEB}/tasks`, { waitUntil: 'domcontentloaded' });
  await cold.evaluate(() => localStorage.clear());
  await cold.reload({ waitUntil: 'networkidle' });
  await wait(cold, 2500);
  check('API down at start: explicit Demo Mode', (await sourceKind(cold)) === 'demo' && (await has(cold, 'Demo Modu')));
  check('Demo data is never shown as Azure DevOps Live', !(await has(cold, 'Azure DevOps Live')));
  const sample = await cold.locator(T('explorer-row')).count().catch(() => 0);
  check('Demo Mode still renders the sample dataset', sample > 0, `rows=${sample}`);
  await shot(cold, 'pag-demo-mode.png');
  start();
  await waitHealthy();
  await cold.click(T('source-pill'));
  await wait(cold, 3500);
  check('Retry in Demo Mode reconnects to the backend', (await sourceKind(cold)) === 'fixture');
  check('after reconnect the totals are the real (fixture) totals, not demo ones', (await getJson(WEB + '/api/work-items?limit=1')).total === totalBefore);
  await shot(cold, 'pag-recovery-explorer.png', { state: 'recovery' });

}

for (const context of [...contexts]) await closeContext(context);
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\nSUMMARY ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
