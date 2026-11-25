// @vitest-environment jsdom
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../../i18n';
import type { ActivityDay } from '../../../services/activityDaily';
import { ActivityHeatmap } from './ActivityHeatmap';
import { ActivityTimeline } from './ActivityTimeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const DAYS: ActivityDay[] = [
  { date: '2026-11-01', count: 0, state: 'covered_zero', stale: false },
  { date: '2026-11-02', count: 5, state: 'covered_active', stale: false },
  { date: '2026-11-03', count: null, state: 'partial', stale: false },
  { date: '2026-11-04', count: null, state: 'not_collected', stale: false },
  { date: '2026-11-05', count: 2, state: 'covered_active', stale: true },
  { date: '2026-11-06', count: null, state: 'unavailable_retention', stale: false },
  { date: '2026-11-07', count: 0, state: 'covered_zero', stale: false },
];

describe('ActivityHeatmap', () => {
  let html = '';
  beforeAll(() => {
    html = renderToStaticMarkup(
      <ActivityHeatmap days={DAYS} draftStart="2026-11-02" draftEnd="2026-11-05" metric="pipelines" locale="en" />,
    );
  });

  it('describes each state in the cell label, never as a bare number', () => {
    expect(html).toContain('2026');
    expect(html).toContain('no activity (scanned)');
    expect(html).toContain('partly collected');
    expect(html).toContain('not collected yet');
    expect(html).toContain('outside the retention period');
    expect(html).toContain('5 runs');
  });

  it('marks stale covered days with a refresh-pending suffix', () => {
    expect(html).toContain('refresh pending');
    expect(html).toContain('data-stale="true"');
  });

  it('marks the selected range with aria-pressed and distinct ring styling', () => {
    expect(html).toMatch(/data-date="2026-11-02"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-date="2026-11-01"[^>]*aria-pressed="false"/);
    expect(html).toContain('ring-amber-500');
  });

  it('shows a legend covering every state', () => {
    for (const label of ['Scanned, no activity', 'Activity', 'Partly collected', 'Not collected', 'Outside retention', 'Selected range']) {
      expect(html).toContain(label);
    }
  });

  it('is available in Turkish with the same states', async () => {
    await i18n.changeLanguage('tr');
    try {
      const tr = renderToStaticMarkup(
        <ActivityHeatmap days={DAYS} draftStart="2026-11-02" draftEnd="2026-11-05" metric="commits" locale="tr" />,
      );
      expect(tr).toContain('aktivite yok (tarandı)');
      expect(tr).toContain('henüz toplanmadı');
      expect(tr).toContain('commit');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('ActivityTimeline', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onDraftChange = vi.fn();
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    onDraftChange.mockReset();
    fetchSpy.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    Element.prototype.hasPointerCapture = () => true;
    Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 64, width: 300, height: 64, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const mount = async () => {
    await act(async () => {
      root.render(<ActivityTimeline days={DAYS} draftStart="2026-11-02" draftEnd="2026-11-05" onDraftChange={onDraftChange} locale="en" />);
    });
  };

  it('exposes both handles as sliders with readable value text', async () => {
    await mount();
    const handles = container.querySelectorAll<HTMLElement>('[role="slider"]');
    expect(handles).toHaveLength(2);
    expect(handles[0].getAttribute('aria-valuetext')).toBe('Nov 2, 2026');
    expect(handles[1].getAttribute('aria-valuetext')).toBe('Nov 5, 2026');
  });

  it('moves the end handle one day with the arrow key and never touches the network', async () => {
    await mount();
    const end = container.querySelector<HTMLElement>('[data-handle="end"]')!;
    await act(async () => {
      end.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onDraftChange).toHaveBeenLastCalledWith('2026-11-02', '2026-11-06');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the start handle from passing the end handle', async () => {
    await mount();
    const start = container.querySelector<HTMLElement>('[data-handle="start"]')!;
    await act(async () => {
      start.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(onDraftChange).toHaveBeenLastCalledWith('2026-11-05', '2026-11-05');
  });

  it('updates only the draft while dragging and makes no request', async () => {
    await mount();
    const end = container.querySelector<HTMLElement>('[data-handle="end"]')!;
    await act(async () => {
      end.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 150, pointerId: 1 }));
      end.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 210, pointerId: 1 }));
      end.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 250, pointerId: 1 }));
    });
    expect(onDraftChange).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('provides one-day nudge buttons as a drag alternative', async () => {
    await mount();
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const laterEnd = buttons.find(b => b.getAttribute('aria-label') === 'End one day later')!;
    await act(async () => laterEnd.click());
    expect(onDraftChange).toHaveBeenLastCalledWith('2026-11-02', '2026-11-06');
  });
});
