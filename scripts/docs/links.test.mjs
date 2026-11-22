import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFiles } from './links.mjs';

test('checks relative files, encoded paths, references, anchors and duplicate headings offline', () => {
  const artifacts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.local/documentation-governance/tests');
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(path.join(artifacts, 'docs-check-'));
  try {
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'docs', 'file name.md'), '# Hello world\n\n## Repeat\n\n## Repeat\n');
    const file = path.join(root, 'index.md');
    writeFileSync(file, '# Home\n\n[ok](docs/file%20name.md#repeat-1) [ref][target]\n\n[target]: docs/file%20name.md#hello-world\n\n```md\n[ignore](missing.md)\n```\n');
    assert.deepEqual(checkFiles([file], root), []);
    writeFileSync(file, '# Home\n\n[bad](docs/file%20name.md#missing) [file](missing.md) [unknown][nope]\n');
    const errors = checkFiles([file], root).join('\n');
    assert.match(errors, /missing/);
    assert.match(errors, /nope/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
