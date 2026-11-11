import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const suiteArg = argv.indexOf('--suite');
const selected = suiteArg >= 0 ? argv[suiteArg + 1] : null;
const separator = argv.indexOf('--');
const forwardedArgs = separator >= 0 ? argv.slice(separator + 1) : [];
const preservedLogDir = process.env.E2E_LOG_DIR ? path.resolve(process.env.E2E_LOG_DIR) : null;
const runDir = preservedLogDir || fs.mkdtempSync(path.join(os.tmpdir(), 'devopsflow-e2e-'));
if (preservedLogDir) fs.mkdirSync(runDir, { recursive: true });
const defaultSuites = [{ name: 'fixture', script: 'e2e-fixture.mjs', edition: 'public' }];
const liveSuites = [
  'e2e-stack.mjs', 'e2e-routing.mjs', 'e2e-smoke.mjs', 'e2e-dashboard-pr.mjs',
  'e2e-pipelines-deployments.mjs', 'e2e-team-history.mjs', 'e2e-quality-fixes.mjs',
  'e2e-phase5-nav-density.mjs', 'e2e-dep-deep.mjs'
].map(script => ({ name: path.basename(script, '.mjs').replace(/^e2e-/, ''), script }));
const testSuites = process.env.E2E_TEST_SUITES
  ? JSON.parse(process.env.E2E_TEST_SUITES)
  : live ? liveSuites : defaultSuites;
if (process.env.E2E_TEST_SUITES) {
  for (const suite of testSuites) if (path.isAbsolute(suite.script)) suite.script = `file:${suite.script}`;
}
if (process.env.E2E_INCLUDE_LEGACY === '1' && !live) {
  testSuites.push({ name: 'fixture-legacy', script: 'e2e-fixture-legacy.mjs', edition: 'legacy' });
}
const captureScreenshots = process.env.E2E_CAPTURE_SCREENSHOTS === '1';
const captureVideo = process.env.E2E_CAPTURE_VIDEO === '1';
const captureTrace = process.env.E2E_CAPTURE_TRACE === '1';
const childTimeoutMs = Number.parseInt(process.env.E2E_TIMEOUT_MS || '0', 10) || 0;
const started = Date.now();
const results = [];
const fixtureProject = 'opendevboard-e2e';
const fixtureCompose = path.join(ROOT, 'e2e-fixture.compose.yml');
const fixtureComposeArgs = ['compose', '--project-name', fixtureProject, '--file', fixtureCompose];
const managedFixture = process.env.E2E_TEST_MODE !== 'fixture';
let fixtureStarted = false;

function compose(args) {
  const result = spawnSync('docker', [...fixtureComposeArgs, ...args], { cwd: ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || 'docker compose failed').trim());
  }
  return (result.stdout || '').trim();
}

if (managedFixture) {
  try {
    console.log('Starting isolated synthetic fixture stack…');
    fixtureStarted = true;
    compose(['up', '--build', '--detach', '--wait']);
    const publishedPort = compose(['port', 'web', '80']).split(':').at(-1);
    const apiContainer = compose(['ps', '--quiet', 'api']);
    if (!/^\d+$/.test(publishedPort || '') || !/^[a-f0-9]+$/i.test(apiContainer)) {
      throw new Error('Fixture Compose did not report a published web port and API container.');
    }
    process.env.WEB_URL = `http://localhost:${publishedPort}`;
    process.env.E2E_API_CONTAINER = apiContainer;
    console.log(`Fixture web: ${process.env.WEB_URL}`);
  } catch (error) {
    console.error(`Fixture stack startup failed: ${error.message}`);
    if (fixtureStarted) {
      try { compose(['down']); } catch (cleanupError) { console.error(`Fixture cleanup failed: ${cleanupError.message}`); }
    }
    process.exit(1);
  }
}

function redact(text) {
  return text
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/ig, '$1[REDACTED]')
    .replace(/((?:PAT|TOKEN|PASSWORD|SECRET|API_KEY|ADO_TOKEN)[A-Z0-9_]*\s*[=:]\s*)[^\s"']+/ig, '$1[REDACTED]')
    .replace(/\b(?:[a-z2-7]{52,}|[a-z0-9_-]{40,})\b/ig, '[REDACTED]');
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseSummary(output) {
  const lines = output.match(/(?:^|\r?\n)SUMMARY\s+(\d+)\s*\/\s*(\d+)(?:\s|$)/g);
  if (lines?.length) {
    const match = lines.at(-1).match(/SUMMARY\s+(\d+)\s*\/\s*(\d+)/);
    return { passed: Number(match[1]), total: Number(match[2]) };
  }
  const match = output.match(/(?:Suite Results|Suite)\s*:?\s*(\d+)\s*\/\s*(\d+)\s*passed\s*\((\d+)\s*failed\)/i);
  if (match) return { passed: Number(match[1]), total: Number(match[2]) };
  return null;
}

if (selected) {
  const found = testSuites.find(s => s.name === selected || s.script === selected || path.basename(s.script, '.mjs') === selected);
  if (!found) {
    console.error(`Unknown suite: ${selected}`);
    process.exit(2);
  }
  testSuites.splice(0, testSuites.length, found);
}

if (!testSuites.length) {
  console.error('No E2E suites selected.');
  process.exit(2);
}

try {
  // Browser suites remain sequential by design (concurrency=1).
  for (const suite of testSuites) {
    const t0 = Date.now();
    const logFile = path.join(runDir, `${suite.name}.log`);
    const scriptPath = suite.script.startsWith('file:') ? suite.script.slice(5)
      : process.env.E2E_TEST_MODE === 'fixture' && suite.name === 'fixture' ? process.env.E2E_TEST_FIXTURE
      : path.resolve(ROOT, suite.script);
    const fixturePorts = suite.name === 'fixture';
    const output = spawnSync(process.execPath, [scriptPath, ...forwardedArgs], {
        cwd: ROOT, encoding: 'utf8', env: {
          ...process.env,
          E2E_CAPTURE_SCREENSHOTS: captureScreenshots ? '1' : '0',
          E2E_CAPTURE_VIDEO: captureVideo ? '1' : '0',
          E2E_CAPTURE_TRACE: captureTrace ? '1' : '0',
          E2E_SKIP_RESTART: '0',
          ...(fixturePorts ? {
            WEB_URL: process.env.WEB_URL || 'http://localhost:6174',
            ...(suite.edition === 'legacy' ? { LEGACY_URL: process.env.LEGACY_URL || 'http://localhost:6173' } : {}),
            E2E_API_CONTAINER: process.env.E2E_API_CONTAINER || 'devopsflow-fx-api'
          } : {})
        },
        timeout: childTimeoutMs || undefined,
        maxBuffer: 16 * 1024 * 1024
      });
    const elapsed = Date.now() - t0;
    const combined = stripAnsi(`${output.stdout || ''}${output.stderr || ''}${output.error ? `\n${output.error.message}` : ''}`);
    fs.writeFileSync(logFile, redact(combined));
    const summary = parseSummary(combined);
    const status = output.status;
    const hasFailureAssertion = /(?:^|\r?\n)FAIL\s/m.test(combined);
    const passed = status === 0 && summary && summary.total > 0 && summary.passed === summary.total && !hasFailureAssertion;
    const resultAssertions = summary?.total ?? (combined.match(/(?:^|\n)PASS\s/g) || []).length + (combined.match(/(?:^|\n)FAIL\s/g) || []).length;
    results.push({ name: suite.name, passed: !!passed, assertions: resultAssertions, elapsed, logFile, output: combined });
    console.log(`${suite.name} ${passed ? 'PASS' : 'FAIL'} ${summary ? `${summary.passed}/${summary.total}` : resultAssertions} ${elapsed}ms`);
    if (!passed) {
      const tail = redact(combined.split(/\r?\n/).slice(-35).join('\n'));
      console.log(`  diagnostic log: ${logFile}`);
      console.log(tail);
    } else {
      if (!preservedLogDir) fs.rmSync(logFile, { force: true });
    }
  }
} finally {
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const assertions = results.reduce((sum, r) => sum + r.assertions, 0);
  console.log(`Total: ${results.length} suites, ${passed} passed, ${failed} failed; ${assertions} assertions; ${Date.now() - started}ms`);
  if (failed === 0 && !preservedLogDir) fs.rmSync(runDir, { recursive: true, force: true });
  if (fixtureStarted) {
    try {
      compose(['down']);
      console.log('Isolated fixture stack stopped; synthetic data volume retained.');
    } catch (error) {
      console.error(`Fixture stack cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
if (results.some(r => !r.passed)) process.exitCode = 1;
