import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureVerifiedScreenshot, recordManifestEntry, verifyManifestIntegrity } from './shot-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-orchestrator-'));
const runner = path.join(here, 'e2e.mjs');
const fixture = path.join(tmp, 'fixture.mjs');
const argsPath = path.join(tmp, 'args.json');
const envPath = path.join(tmp, 'env.json');

function run(extraEnv = {}, args = []) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, E2E_TEST_FIXTURE: fixture, E2E_TEST_MODE: 'fixture', E2E_TEST_ARGS: argsPath, E2E_TEST_ENV: envPath, ...extraEnv }
  });
}

try {
  fs.writeFileSync(fixture, `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    fs.writeFileSync(process.env.E2E_TEST_ARGS, JSON.stringify(args));
    fs.writeFileSync(process.env.E2E_TEST_ENV, JSON.stringify({ marker: process.env.FORWARDED_MARKER, capture: process.env.E2E_CAPTURE_SCREENSHOTS, webUrl: process.env.WEB_URL, skipRestart: process.env.E2E_SKIP_RESTART }));
    console.log('PASS fake assertion one');
    console.log('PASS fake assertion two');
    console.log('SUMMARY 2/2');
  `);
  let result = run({ FORWARDED_MARKER: 'kept', E2E_CAPTURE_SCREENSHOTS: '1', E2E_SKIP_RESTART: '1' }, ['--suite', 'fixture', '--', '--custom', 'value']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error?.message || ''}`);
  assert.match(result.stdout, /fixture\s+PASS\s+2\/2/);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsPath)), ['--custom', 'value']);
  assert.deepEqual(JSON.parse(fs.readFileSync(envPath)), { marker: 'kept', capture: '1', webUrl: 'http://localhost:6174', skipRestart: '0' });

  const failing = path.join(tmp, 'failing.mjs');
  fs.writeFileSync(failing, `console.log('PASS one'); console.log('SUMMARY 1/1'); console.error('Authorization: Bearer secret-token'); process.exit(7);`);
  const following = path.join(tmp, 'following.mjs');
  fs.writeFileSync(following, `console.log('PASS two'); console.log('SUMMARY 1/1');`);
  result = run({ E2E_TEST_SUITES: JSON.stringify([{ name: 'broken', script: failing }, { name: 'following', script: following }]) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /broken\s+FAIL\s+1\/1/);
  assert.match(result.stdout, /following\s+PASS\s+1\/1/);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-token/);
  assert.match(result.stdout, /redacted/i);
  assert.match(result.stdout, /Total: 2 suites, 1 passed, 1 failed/);

  const falseGreen = path.join(tmp, 'false-green.mjs');
  fs.writeFileSync(falseGreen, `console.log('FAIL assertion'); console.log('SUMMARY 1/1');`);
  result = run({ E2E_TEST_SUITES: JSON.stringify([{ name: 'false-green', script: falseGreen }]) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /false-green\s+FAIL/);
  const empty = path.join(tmp, 'empty.mjs');
  fs.writeFileSync(empty, `console.log('SUMMARY 0/0');`);
  result = run({ E2E_TEST_SUITES: JSON.stringify([{ name: 'empty', script: empty }]) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /empty\s+FAIL\s+0\/0/);
  fs.writeFileSync(following, `console.log('PASS one'); console.log('PASS two'); console.log('Suite Results: 2/2 passed (0 failed)');`);
  result = run({ E2E_TEST_SUITES: JSON.stringify([{ name: 'legacy-summary', script: following }]) });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /legacy-summary\s+PASS\s+2/, result.stdout);

  const previousCapture = process.env.E2E_CAPTURE_SCREENSHOTS;
  const previousShotsRoot = process.env.SHOTS_ROOT;
  const previousShotDate = process.env.SHOT_DATE;
  const shotsRoot = path.join(tmp, 'screenshots');
  process.env.E2E_CAPTURE_SCREENSHOTS = '0';
  process.env.SHOTS_ROOT = shotsRoot;
  process.env.SHOT_DATE = '2026-11-08';
  assert.equal(verifyManifestIntegrity().success, false, 'manifest integrity remains strict when explicitly invoked');
  assert.equal(fs.existsSync(shotsRoot), false, 'disabled capture must not create screenshot artifacts');
  const artifactDir = path.join(shotsRoot, '2026-11-08', 'v6', 'routing');
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifact = path.join(artifactDir, 'route-ready.png');
  fs.writeFileSync(artifact, 'fixture png placeholder');
  recordManifestEntry(path.join(shotsRoot, '2026-11-08', 'v6', 'manifest.jsonl'), {
    file: artifact,
    module: 'routing',
    state: 'ready'
  });
  assert.equal(verifyManifestIntegrity('2026-11-08').success, true, 'enabled artifact and manifest record must match');
  const verifiedArtifact = path.join(artifactDir, 'route-ready-en-dark.png');
  const fakePage = {
    url: () => 'http://localhost:6174/tasks',
    viewportSize: () => ({ width: 1280, height: 800 }),
    locator: () => ({ first: () => ({ isVisible: async () => true }), count: async () => 0 }),
    screenshot: async ({ path: outputPath }) => fs.writeFileSync(outputPath, 'fixture png placeholder')
  };
  await captureVerifiedScreenshot(fakePage, verifiedArtifact, {
    expectedUrl: '/tasks', expectedSelector: '[data-testid="page-tasks"]', module: 'matrix',
    viewport: { width: 1280, height: 800 }, theme: 'dark', locale: 'en', route: '/tasks', state: 'ready'
  });
  const routeEntry = fs.readFileSync(path.join(shotsRoot, '2026-11-08', 'v6', 'manifest.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.file === verifiedArtifact);
  assert.deepEqual({ viewport: routeEntry.viewport, theme: routeEntry.theme, locale: routeEntry.locale, route: routeEntry.route, state: routeEntry.state }, {
    viewport: { width: 1280, height: 800 }, theme: 'dark', locale: 'en', route: '/tasks', state: 'ready'
  });
  fs.writeFileSync(path.join(artifactDir, 'unrecorded.png'), 'fixture png placeholder');
  assert.equal(verifyManifestIntegrity('2026-11-08').success, false, 'unrecorded screenshot files must fail integrity audit');
  fs.rmSync(path.join(artifactDir, 'unrecorded.png'));
  assert.equal(verifyManifestIntegrity('2026-11-08').success, true, 'canonical manifest includes route, locale, theme and viewport metadata');
  if (previousCapture === undefined) delete process.env.E2E_CAPTURE_SCREENSHOTS;
  else process.env.E2E_CAPTURE_SCREENSHOTS = previousCapture;
  if (previousShotsRoot === undefined) delete process.env.SHOTS_ROOT;
  else process.env.SHOTS_ROOT = previousShotsRoot;
  if (previousShotDate === undefined) delete process.env.SHOT_DATE;
  else process.env.SHOT_DATE = previousShotDate;

  console.log('PASS orchestrator contract: forwarding, summaries, continuation and redaction');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
