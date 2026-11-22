import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/markdownlint-cli2/markdownlint-cli2.mjs');
const result = spawnSync(process.execPath, [bin, '--config', path.join(root, '.markdownlint-cli2.jsonc'), ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
