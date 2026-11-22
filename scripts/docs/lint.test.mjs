import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('markdownlint accepts valid text and rejects trailing whitespace', () => {
  const artifacts = path.join(root, '.local/documentation-governance/tests');
  mkdirSync(artifacts, { recursive: true });
  const dir = mkdtempSync(path.join(artifacts, 'docs-lint-'));
  try {
    const file = path.join(dir, 'fixture.md');
    const config = JSON.parse(readFileSync(path.join(root, '.markdownlint-cli2.jsonc'), 'utf8'));
    delete config.ignores;
    const configPath = path.join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    const lint = () => spawnSync(path.join(root, 'scripts/node_modules/.bin/markdownlint-cli2'), ['--config', configPath, 'fixture.md'], { encoding: 'utf8', cwd: dir });
    writeFileSync(file, '# Good\n\nText.\n');
    assert.equal(lint().status, 0);
    writeFileSync(file, '# Bad\n\nTrailing spaces.   \n');
    const result = lint();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /MD009/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
