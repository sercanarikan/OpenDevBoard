import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { captureVerifiedScreenshot, shotDir, verifyManifestIntegrity } from './shot-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.WEB_URL || 'http://localhost:5174').replace(/\/$/, '');
const date = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
const screenshotDir = shotDir(process.env.VISUAL_SCREENSHOT_DIR, 'matrix');
const routeToTitle = {
  '/dashboard': 'dashboard', '/tasks': 'explorer', '/kanban': 'board', '/hierarchy': 'hierarchy',
  '/dependencies': 'dependencies', '/pull-requests': 'pullRequests', '/pipelines': 'pipelines',
  '/deployments': 'deployments', '/team-activity': 'teamActivity', '/my-history': 'myHistory'
};
const routerSource = fs.readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const routes = [...routerSource.matchAll(/<Route\s+path="([^"]+)"\s+element={<([A-Za-z][A-Za-z0-9]*)/g)]
  .filter(([, route, component]) => route !== '/' && route !== '*' && component !== 'Navigate' && component !== 'NotFoundView')
  .map(([, route]) => route);
const unknownRoutes = routes.filter(route => !routeToTitle[route]);
if (!routes.length || unknownRoutes.length) throw new Error(`Router discovery failed: ${unknownRoutes.join(', ') || 'no main routes'}`);

const locales = {
  tr: JSON.parse(fs.readFileSync(path.join(root, 'apps/web/src/i18n/locales/tr/common.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(root, 'apps/web/src/i18n/locales/en/common.json'), 'utf8'))
};
const viewports = [
  { width: 1440, height: 900 }, { width: 1280, height: 800 },
  { width: 768, height: 1024 }, { width: 390, height: 844 }
];
const themes = ['light', 'dark'];
const languages = ['tr', 'en'];
const findings = [];
let screenshotCount = 0;
const browser = await chromium.launch({ headless: true });
const faviconResponse = await fetch(`${baseUrl}/favicon.svg`);
const faviconSvg = faviconResponse.ok ? await faviconResponse.text() : '';
if (!faviconResponse.ok || !faviconSvg.includes('<svg')) findings.push(`Favicon check failed: HTTP ${faviconResponse.status}`);

function safeName(value) { return value.replaceAll('/', '').replaceAll(' ', '-').toLowerCase(); }

async function capture(page, name, { route, locale, theme, viewport, state = 'ready', selector } = {}) {
  const expectedUrl = new URL(page.url()).pathname;
  if (route && expectedUrl !== route) throw new Error(`Refusing wrong-route capture: expected ${route}, found ${expectedUrl}`);
  if (selector && !(await page.locator(selector).first().isVisible().catch(() => false))) {
    throw new Error(`Refusing ${state} capture; expected selector is not visible: ${selector}`);
  }
  const file = path.join(screenshotDir, `${name}.png`);
  await captureVerifiedScreenshot(page, file, {
    expectedUrl: route || expectedUrl,
    expectedSelector: selector || '[data-testid="header-page-title"]',
    module: 'visual-matrix', viewport, theme, locale, route: route || expectedUrl, state
  });
  screenshotCount++;
}

async function open(page, route, locale, theme, viewport) {
  await page.addInitScript(({ locale: lang, theme: mode }) => {
    localStorage.setItem('devopsflow_language', lang);
    localStorage.setItem('devopsflow_theme', mode);
    localStorage.removeItem('devopsflow_sidebar');
  }, { locale, theme });
  const errors = [];
  const failedApi = [];
  const onPageError = error => errors.push(error.message);
  const onConsole = message => { if (message.type() === 'error') errors.push(message.text()); };
  const onRequestFailed = request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) failedApi.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  const expectedTitle = locales[locale].views[routeToTitle[route]];
  const title = page.getByTestId('header-page-title');
  await title.waitFor({ state: 'visible', timeout: 30000 });
  const actualTitle = (await title.innerText()).trim();
  if (actualTitle !== expectedTitle) throw new Error(`${route} ${locale}: expected page title '${expectedTitle}', found '${actualTitle}'`);
  const readiness = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    documentLang: document.documentElement.lang,
    titleWidth: document.querySelector('[data-testid="header-page-title"]')?.clientWidth || 0,
    titleTextWidth: (() => {
      const title = document.querySelector('[data-testid="header-page-title"]');
      if (!title) return 0;
      const range = document.createRange();
      range.selectNodeContents(title);
      return range.getBoundingClientRect().width;
    })(),
    welcomeWidth: document.querySelector('[data-testid="dashboard-welcome-title"]')?.clientWidth || 0,
    welcomeTextWidth: (() => {
      const title = document.querySelector('[data-testid="dashboard-welcome-title"]');
      if (!title) return 0;
      const range = document.createRange();
      range.selectNodeContents(title);
      return range.getBoundingClientRect().width;
    })(),
    projectSelectorVisible: (() => {
      const selector = document.querySelector('header select');
      return Boolean(selector && selector.getBoundingClientRect().width > 0);
    })(),
    loadingText: [...document.querySelectorAll('main [role="status"]')]
      .some(element => /loading|yükleniyor/i.test(element.textContent || '')),
    badImageCount: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).length
  }));
  if (readiness.loadingText) throw new Error(`${route} ${locale}: route stayed in loading state`);
  if (readiness.documentLang !== locale) findings.push(`Document language ${route} ${viewport.width}x${viewport.height} ${locale}: html lang is '${readiness.documentLang}'`);
  if (readiness.documentWidth > readiness.viewportWidth + 1) {
    findings.push(`Horizontal overflow ${route} ${locale}: document ${readiness.documentWidth}px at viewport ${readiness.viewportWidth}px`);
  }
  if (readiness.titleTextWidth > readiness.titleWidth + 1) {
    findings.push(`Truncated route title ${route} ${viewport.width}x${viewport.height} ${locale}: '${actualTitle}' text ${readiness.titleTextWidth}px / box ${readiness.titleWidth}px`);
  }
  if (readiness.welcomeTextWidth > readiness.welcomeWidth + 1) {
    findings.push(`Truncated dashboard welcome ${viewport.width}x${viewport.height} ${locale}: text ${readiness.welcomeTextWidth}px / box ${readiness.welcomeWidth}px`);
  }
  if (readiness.projectSelectorVisible !== (viewport.width >= 480)) {
    findings.push(`Project selector responsive visibility ${route} ${viewport.width}x${viewport.height}: visible=${readiness.projectSelectorVisible}`);
  }
  if (readiness.badImageCount) findings.push(`Broken image ${route} ${locale}: ${readiness.badImageCount}`);
  if (errors.length) findings.push(`Console error ${route} ${locale}: ${errors.join(' | ')}`);
  if (failedApi.length) findings.push(`Failed API request ${route} ${locale}: ${failedApi.join(', ')}`);
  page.off('pageerror', onPageError);
  page.off('console', onConsole);
  page.off('requestfailed', onRequestFailed);
  return { errors, failedApi, readiness };
}

try {
  for (const viewport of viewports) {
    for (const theme of themes) {
      for (const locale of languages) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        for (const route of routes) {
          const result = await open(page, route, locale, theme, viewport);
          await capture(page, `${safeName(route)}-${viewport.width}x${viewport.height}-${theme}-${locale}`, {
            route, locale, theme, viewport
          });
          if (result.errors.length || result.failedApi.length) {
            // Keep capturing the matrix so one transient error does not hide other route evidence.
          }
        }
        await context.close();
      }
    }
  }

  const interactive = await browser.newContext({ viewport: viewports[0] });
  const page = await interactive.newPage();
  const stateLocale = 'en';
  const stateTheme = 'dark';
  const contextConsole = [];
  page.on('pageerror', error => contextConsole.push(error.message));

  await open(page, '/tasks', stateLocale, stateTheme, viewports[0]);
  const expanded = page.getByRole('button', { name: locales.en.sidebar.collapse });
  if (await expanded.isVisible()) {
    await expanded.click();
    await page.getByRole('button', { name: locales.en.sidebar.expand }).waitFor({ state: 'visible' });
    await capture(page, 'state-collapsed-sidebar', { route: '/tasks', locale: stateLocale, theme: stateTheme, viewport: viewports[0], state: 'collapsed-sidebar' });
  } else {
    findings.push('Collapsed sidebar state could not be opened at 1440px.');
  }
  if (!(await page.locator('aside img').first().isVisible().catch(() => false))) findings.push('Brand logo is not visible in the sidebar.');
  await page.getByTestId('nav-board').click();
  await page.getByTestId('header-page-title').filter({ hasText: locales.en.views.board }).waitFor({ state: 'visible' });
  await page.getByTestId('nav-explorer').click();
  await page.getByTestId('header-page-title').filter({ hasText: locales.en.views.explorer }).waitFor({ state: 'visible' });

  await page.keyboard.press('Control+k');
  const paletteInput = page.locator('input[placeholder]').last();
  await paletteInput.waitFor({ state: 'visible', timeout: 5000 });
  await capture(page, 'state-command-palette', {
    route: '/tasks', locale: stateLocale, theme: stateTheme, viewport: viewports[0], state: 'command-palette',
    selector: '[data-testid="command-palette"]'
  });
  await page.keyboard.press('Escape');

  const row = page.getByTestId('explorer-row').first();
  await row.waitFor({ state: 'visible', timeout: 30000 });
  await row.click();
  await page.getByTestId('inspector').waitFor({ state: 'visible', timeout: 10000 });
  await capture(page, 'state-work-item-inspector', {
    route: '/tasks', locale: stateLocale, theme: stateTheme, viewport: viewports[0], state: 'inspector', selector: '[data-testid="inspector"]'
  });
  await page.keyboard.press('Escape');

  const search = page.locator('input[type="text"]').first();
  await search.fill('visual-matrix-no-matches-7539');
  await page.getByTestId('explorer-empty').waitFor({ state: 'visible', timeout: 15000 });
  await capture(page, 'state-empty-results', {
    route: '/tasks', locale: stateLocale, theme: stateTheme, viewport: viewports[0], state: 'empty', selector: '[data-testid="explorer-empty"]'
  });

  await page.unroute('**/api/work-items**').catch(() => {});
  await search.fill('');
  await page.waitForLoadState('networkidle');
  await page.route('**/api/work-items**', route => route.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  const errorState = page.locator('[data-testid="explorer-error-inline"], [data-testid="explorer-error"]').first();
  await errorState.waitFor({ state: 'visible', timeout: 15000 });
  await capture(page, 'state-api-error', {
    route: '/tasks', locale: stateLocale, theme: stateTheme, viewport: viewports[0], state: 'error',
    selector: '[data-testid="explorer-error-inline"], [data-testid="explorer-error"]'
  });

  await page.unroute('**/api/work-items**');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /All Work Items/ }).click();
  await page.getByTestId('explorer-row').first().waitFor({ state: 'visible', timeout: 30000 });
  await capture(page, 'state-api-recovery', {
    route: '/tasks', locale: stateLocale, theme: stateTheme, viewport: viewports[0], state: 'recovery'
  });
  if (contextConsole.length) findings.push(`Interactive state console errors: ${contextConsole.join(' | ')}`);
  await interactive.close();

  const loadingContext = await browser.newContext({ viewport: viewports[0] });
  const loadingPage = await loadingContext.newPage();
  let releaseLoadingRequest;
  let pendingLoadingRoute;
  await loadingPage.addInitScript(() => {
    localStorage.setItem('devopsflow_language', 'en');
    localStorage.setItem('devopsflow_theme', 'dark');
  });
  await loadingPage.route('**/api/work-items**', route => new Promise(resolve => {
    pendingLoadingRoute = route;
    releaseLoadingRequest = resolve;
  }));
  await loadingPage.goto(`${baseUrl}/tasks`, { waitUntil: 'domcontentloaded' });
  await loadingPage.getByTestId('explorer-loading').waitFor({ state: 'visible', timeout: 15000 });
  await capture(loadingPage, 'state-loading', {
    route: '/tasks', locale: stateLocale, theme: stateTheme, viewport: viewports[0], state: 'loading',
    selector: '[data-testid="explorer-loading"]'
  });
  releaseLoadingRequest?.();
  await pendingLoadingRoute?.abort().catch(() => {});
  await loadingContext.close();

  const integrity = verifyManifestIntegrity(date);
  if (!integrity.success) throw new Error(`Screenshot manifest integrity failed: ${integrity.error}`);
  console.log(JSON.stringify({ routes, routeCount: routes.length, viewports, themes, languages, expected: routes.length * viewports.length * themes.length * languages.length, screenshots: screenshotCount, manifest: integrity, findings }, null, 2));
  if (findings.length) process.exitCode = 1;
} finally {
  await browser.close();
}
