import { describe, it, expect } from 'vitest';
import commonTR from './locales/tr/common.json';
import commonEN from './locales/en/common.json';
import kanbanTR from './locales/tr/kanban.json';
import kanbanEN from './locales/en/kanban.json';
import depsTR from './locales/tr/dependencies.json';
import depsEN from './locales/en/dependencies.json';
import { formatDate, formatNumber } from './format';

const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  );

describe('translation key completeness (tr <-> en)', () => {
  const pairs: [string, object, object][] = [
    ['common', commonTR, commonEN],
    ['kanban', kanbanTR, kanbanEN],
    ['dependencies', depsTR, depsEN]
  ];

  for (const [ns, tr, en] of pairs) {
    it(`${ns}: every key exists in both languages`, () => {
      const trKeys = flatten(tr as Record<string, unknown>).sort();
      const enKeys = flatten(en as Record<string, unknown>).sort();
      expect(trKeys.filter(k => !enKeys.includes(k))).toEqual([]);
      expect(enKeys.filter(k => !trKeys.includes(k))).toEqual([]);
    });
  }
});

describe('Intl based formatting', () => {
  it('formats dates with locale-specific month names', () => {
    const d = '2026-11-05T08:00:00Z';
    expect(formatDate(d, 'tr')).toContain('Kas');
    expect(formatDate(d, 'en')).toContain('Nov');
  });

  it('formats numbers with locale-specific separators', () => {
    expect(formatNumber(1147, 'tr')).toBe('1.147');
    expect(formatNumber(1147, 'en')).toBe('1,147');
  });
});
