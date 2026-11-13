import { describe, it, expect } from 'vitest';
import i18n from './index';
import pullRequestsTR from './locales/tr/pullRequests.json';
import pullRequestsEN from './locales/en/pullRequests.json';

const sources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

const DEFAULT_NS = 'common';
const KNOWN_NS = ['common', 'kanban', 'dependencies', 'pullRequests', 'dashboard', 'pipelines', 'deployments', 'teamActivity', 'myHistory'];

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const T_CALL = /\b(?:tr|t)\(\s*(['"`])([A-Za-z][\w.]*)\1\s*(?=[,)])(,\s*\{[^()]*?\})?/g;
const NS_OPT = /ns:\s*['"]([a-zA-Z]+)['"]/;

const collectRefs = () => {
  const refs = new Map<string, { ns: string; file: string }>();
  for (const [file, raw] of Object.entries(sources)) {
    if (/\.test\.(ts|tsx)$/.test(file)) continue;
    const src = stripComments(raw);
    const hookNs = src.match(/useTranslation\(\s*\[?\s*['"]([a-zA-Z]+)['"]/);
    const defaultNs = hookNs && KNOWN_NS.includes(hookNs[1]) ? hookNs[1] : DEFAULT_NS;
    for (const m of src.matchAll(T_CALL)) {
      const key = m[2];
      const opts = m[3] ?? '';
      const explicit = opts.match(NS_OPT);
      const ns = explicit ? explicit[1] : defaultNs;
      if (!KNOWN_NS.includes(ns)) continue;
      const id = `${ns}:${key}`;
      if (!refs.has(id)) refs.set(id, { ns, file });
    }
  }
  return refs;
};

describe('every literal t() key resolves in both languages', () => {
  const refs = collectRefs();

  it('finds translation call sites in the source tree', () => {
    expect(refs.size).toBeGreaterThan(100);
  });

  for (const [id, { ns, file }] of refs) {
    const key = id.slice(ns.length + 1);
    for (const lng of ['tr', 'en'] as const) {
      it(`${lng} · ${ns}:${key} (${file})`, () => {
        const fixed = i18n.getFixedT(lng, ns);
        const direct = fixed(key, { defaultValue: '' }) as string;
        const plural = fixed(key, { count: 2, defaultValue: '' }) as string;
        const value = direct || plural;
        expect(value, `missing ${lng} value for ${ns}:${key}`).toBeTruthy();
        expect(value).not.toBe(key);
      });
    }
  }
});

describe('pull request reviewer requirement labels', () => {
  it('provides required and optional labels in both supported languages', () => {
    for (const [language, translations] of [['tr', pullRequestsTR], ['en', pullRequestsEN]] as const) {
      const labels = translations.inspector;
      expect(labels.required, `${language} required label`).toBeTruthy();
      expect(labels.optional, `${language} optional label`).toBeTruthy();
    }
  });
});
