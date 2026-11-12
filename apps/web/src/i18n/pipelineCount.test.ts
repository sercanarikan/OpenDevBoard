import { describe, expect, it } from 'vitest';
import i18n from './index';

describe('pipeline run count', () => {
  it('formats the loaded total in the selected language', () => {
    expect(i18n.t('runCount', { ns: 'pipelines', lng: 'en', count: 20 })).toBe('20 pipeline runs shown');
    expect(i18n.t('runCount', { ns: 'pipelines', lng: 'tr', count: 20 })).toBe('20 pipeline koşumu gösteriliyor');
  });
});
