import { describe, it, expect, beforeEach } from 'vitest';
import i18n, { changeLanguage } from './index';
import { stateLabel, priorityLabel } from './labels';

describe('display-layer state/priority labels', () => {
  beforeEach(() => changeLanguage('tr'));

  it('translates well-known states in Turkish, including multi-word ones', () => {
    expect(stateLabel(i18n.t, 'In Progress')).toBe('Devam Ediyor');
    expect(stateLabel(i18n.t, 'To Do')).toBe('Yapılacak');
    expect(stateLabel(i18n.t, 'Done')).toBe('Tamamlandı');
    expect(stateLabel(i18n.t, 'Resolved')).toBe('Çözüldü');
  });

  it('keeps English labels in English mode', () => {
    changeLanguage('en');
    expect(stateLabel(i18n.t, 'In Progress')).toBe('In Progress');
  });

  it('never rewrites unknown/custom workflow states', () => {
    expect(stateLabel(i18n.t, 'Waiting For QA')).toBe('Waiting For QA');
    expect(stateLabel(i18n.t, 'Custom.State')).toBe('Custom.State');
    expect(stateLabel(i18n.t, '')).toBe('');
  });

  it('localizes priorities with a safe fallback', () => {
    expect(priorityLabel(i18n.t, 2)).toBe('P2 Yüksek');
    expect(priorityLabel(i18n.t, 9)).toBe('P9');
  });
});
