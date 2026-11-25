// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { CacheJobNotice } from './CacheJobNotice';
import type { CacheCoverage, CacheJob } from '../../hooks/useCacheJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const job = (state: CacheJob['state'], extra: Partial<CacheJob> = {}): CacheJob => ({ state, pending: 0, completed: 0, partial: 0, failed: 0, deferred: 0, busy: 0, retryAfterSeconds: 0, ...extra });
const cov = (complete: number, partial: number, missing: number): CacheCoverage => ({ complete, partial, missing });

describe('CacheJobNotice', () => {
  let root: Root;
  let container: HTMLDivElement;
  const show = async (j: CacheJob | null, c: CacheCoverage | null) => {
    await act(async () => { root.render(<CacheJobNotice job={j} coverage={c} />); });
    return container.textContent ?? '';
  };
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); await i18n.changeLanguage('en'); });

  it('renders nothing when complete', async () => {
    expect(await show(job('done'), cov(3, 0, 0))).toBe('');
    expect(await show(null, null)).toBe('');
  });

  it.each([
    ['en', 'Collecting data', 'Partially collected', 'Not collected yet'],
    ['tr', 'veri toplanıyor', 'kısmen toplandı', 'henüz toplanmadı'],
  ])('shows text per state in %s', async (lng, running, partial, missing) => {
    await i18n.changeLanguage(lng);
    expect(await show(job('running', { pending: 2 }), cov(1, 0, 2))).toContain(running);
    expect(await show(job('done'), cov(1, 1, 0))).toContain(partial);
    expect(await show(job('idle'), cov(1, 0, 2))).toContain(missing);
  });

  it('does not show missing text while running', async () => {
    expect(await show(job('running', { pending: 1 }), cov(1, 0, 2))).not.toContain('Not collected yet');
  });

  it('shows the upstream wait for deferred without an alert role', async () => {
    await i18n.changeLanguage('tr');
    expect(await show(job('deferred', { deferred: 1, retryAfterSeconds: 42 }), cov(0, 0, 2))).toContain('upstream bekleme süresi: 42 sn');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await i18n.changeLanguage('en');
    expect(await show(job('deferred', { deferred: 1, retryAfterSeconds: 42 }), cov(0, 0, 2))).toContain('Upstream wait: 42 s');
  });

  it.each([['en', 'queue is full'], ['tr', 'kuyruğu dolu']])('shows busy notice in %s', async (lng, text) => {
    await i18n.changeLanguage(lng);
    expect(await show(job('done', { busy: 2 }), cov(3, 0, 0))).toContain(text);
  });
});
