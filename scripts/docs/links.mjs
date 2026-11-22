import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import GithubSlugger from 'github-slugger';

function anchors(file) {
  const tokens = marked.lexer(fs.readFileSync(file, 'utf8'));
  const slugger = new GithubSlugger();
  const found = new Set();
  marked.walkTokens(tokens, token => {
    if (token.type === 'heading') found.add(slugger.slug(token.text.replace(/<[^>]+>/g, '').replace(/[`*_~]/g, '')));
    if (token.type === 'html') for (const match of token.raw.matchAll(/\bid=["']([^"']+)["']/g)) found.add(match[1]);
  });
  return found;
}
export function checkFiles(files, root) {
  const errors = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const tokens = marked.lexer(text);
    const visit = href => {
      if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
      try {
        const [rawPath, fragment = ''] = href.split('#', 2);
        const target = rawPath ? path.resolve(path.dirname(file), decodeURIComponent(rawPath.split('?')[0])) : file;
        if (target !== root && !target.startsWith(root + path.sep)) { errors.push(`${file}: outside repository: ${href}`); return; }
        if (!fs.existsSync(target)) { errors.push(`${file}: missing file: ${href}`); return; }
        if (fragment && fs.statSync(target).isFile() && /\.md$/i.test(target) && !anchors(target).has(decodeURIComponent(fragment))) errors.push(`${file}: missing anchor: ${href}`);
      } catch { errors.push(`${file}: invalid link: ${href}`); }
    };
    marked.walkTokens(tokens, token => { if (token.type === 'link' || token.type === 'image') visit(token.href); });
    for (const def of Object.values(tokens.links || {})) visit(def.href);
    // Explicit full and collapsed references that the parser could not resolve.
    const withoutCode = text.replace(/```[^\n]*\n[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
      const key = (match[2] || match[1]).toLowerCase().replace(/\s+/g, ' ');
      if (!tokens.links[key]) errors.push(`${file}: undefined reference: ${key}`);
    }
  }
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const files = process.argv.slice(2).length ? process.argv.slice(2).map(f => path.resolve(f)) : execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).map(f => path.join(root, f));
  const errors = checkFiles(files, root);
  for (const error of errors) console.error(error);
  console.log(`Checked ${files.length} Markdown files; ${errors.length} errors.`);
  if (errors.length) process.exitCode = 1;
}
