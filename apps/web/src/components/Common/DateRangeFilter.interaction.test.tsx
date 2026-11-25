// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { DateRangeFilter } from './DateRangeFilter';
import { customSelection, periodSelection, presetSelection, utcTodayKey, type DateRangeSelection } from '../../services/dateRange';

const mockApp = vi.hoisted(() => ({ isDemo: false }));
const fetchActivityDaily = vi.hoisted(() => vi.fn());

vi.mock('../../context/useApp', () => ({ useApp: () => mockApp }));
vi.mock('../../services/liveApi', () => ({ fetchActivityDaily, isTimeoutError: () => false }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyResponse = (startDate: string, endDate: string) => ({
  metric: 'pipelines',
  window: { kind: 'calendar', startDate, endDate, days: 1, timezone: 'UTC' },
  days: [{ date: startDate, count: 0, state: 'covered_zero', stale: false }],
  job: { state: 'idle', pending: 0, completed: 0, partial: 0, failed: 0 },
  cacheStatus: { complete: true, partialDays: 0, notCollectedDays: 0 },
});

describe('DateRangeFilter interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onApply: ReturnType<typeof vi.fn<(selection: DateRangeSelection) => void>>;

  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    mockApp.isDemo = false;
    fetchActivityDaily.mockReset();
    fetchActivityDaily.mockImplementation(async (params: { startDate: string; endDate: string }) => emptyResponse(params.startDate, params.endDate));
    onApply = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    Element.prototype.hasPointerCapture = () => true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  const render = async (value: DateRangeSelection, activityMetric?: 'pipelines') => {
    await act(async () => {
      root.render(<DateRangeFilter value={value} onApply={onApply} activityMetric={activityMetric} />);
    });
  };
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="date-range-trigger"]')!;
  const open = async () => act(async () => trigger().click());
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const findButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  const tab = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(b => b.textContent?.trim() === label)!;

  it('opens a dialog from the trigger and closes on Escape without applying', async () => {
    await render(presetSelection('last30', utcTodayKey()));
    await open();
    expect(find('[data-testid="date-range-panel"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(find('[data-testid="date-range-panel"]')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies a rolling preset immediately and closes the panel', async () => {
    await render(presetSelection('last30', utcTodayKey()));
    await open();
    const button = find('[data-preset="last7"]') as HTMLButtonElement;
    await act(async () => button.click());
    expect(onApply).toHaveBeenCalledWith(presetSelection('last7', utcTodayKey()));
    expect(find('[data-testid="date-range-panel"]')).toBeNull();
  });

  it('exposes the period hierarchy as tabs and keeps the calendar tab selected by default for custom ranges', async () => {
    await render(customSelection('2026-11-01', '2026-11-05'));
    await open();
    expect(tab('Custom').getAttribute('aria-selected')).toBe('true');
    expect(tab('Day').getAttribute('aria-selected')).toBe('false');
  });

  it('applies a whole year selection through the year tab', async () => {
    await render(presetSelection('last30', utcTodayKey()));
    await open();
    await act(async () => tab('Year').click());
    const year = Number(utcTodayKey().slice(0, 4));
    await act(async () => findButton(String(year))!.click());
    await act(async () => find<HTMLButtonElement>('[data-testid="date-range-apply"]')!.click());
    // The current year is in progress, so it is applied up to today rather than into the future.
    expect(onApply).toHaveBeenCalledWith(customSelection(`${year}-01-01`, utcTodayKey()));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('applies a complete past year as a year period', async () => {
    await render(presetSelection('last30', utcTodayKey()));
    await open();
    await act(async () => tab('Year').click());
    const year = Number(utcTodayKey().slice(0, 4)) - 1;
    await act(async () => findButton('Previous year')!.click());
    await act(async () => findButton(String(year))!.click());
    await act(async () => find<HTMLButtonElement>('[data-testid="date-range-apply"]')!.click());
    expect(onApply).toHaveBeenCalledWith(periodSelection('year', { year }, utcTodayKey()));
  });

  it('applies a quarter selection through the quarter tab', async () => {
    await render(presetSelection('last30', utcTodayKey()));
    await open();
    await act(async () => tab('Quarter').click());
    const year = Number(utcTodayKey().slice(0, 4));
    await act(async () => findButton('Q1')!.click());
    await act(async () => find<HTMLButtonElement>('[data-testid="date-range-apply"]')!.click());
    expect(onApply).toHaveBeenCalledWith(periodSelection('quarter', { year, quarter: 1 }, utcTodayKey()));
  });

  it('keeps Apply disabled until a draft exists and cancel never applies', async () => {
    await render(presetSelection('last30', utcTodayKey()));
    await open();
    await act(async () => tab('Custom').click());
    expect(find<HTMLButtonElement>('[data-testid="date-range-apply"]')!.disabled).toBe(true);
    await act(async () => findButton('Cancel')!.click());
    expect(onApply).not.toHaveBeenCalled();
  });

  it('shows the activity timeline and heatmap for the metric and does not request again while dragging', async () => {
    const today = utcTodayKey();
    const start = presetSelection('thisMonth', today);
    await render(start, 'pipelines');
    await open();
    expect(find('[data-testid="date-range-activity"]')).not.toBeNull();
    const requestsAfterOpen = fetchActivityDaily.mock.calls.length;
    expect(requestsAfterOpen).toBeGreaterThan(0);
    expect(fetchActivityDaily.mock.calls.every(([params]) => params.mode === 'cache')).toBe(true);

    const end = document.querySelector<HTMLElement>('[data-handle="end"]')!;
    await act(async () => {
      end.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, pointerId: 1 }));
      end.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 40, pointerId: 1 }));
      end.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 80, pointerId: 1 }));
    });
    expect(fetchActivityDaily.mock.calls.length).toBe(requestsAfterOpen);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('disables presets longer than the screen limit and explains the limit', async () => {
    await render(presetSelection('last30', utcTodayKey()));
    await act(async () => root.render(<DateRangeFilter value={presetSelection('last30', utcTodayKey())} onApply={onApply} maxSpanDays={90} />));
    await open();
    expect((find('[data-preset="last6m"]') as HTMLButtonElement).disabled).toBe(true);
    expect((find('[data-preset="last90"]') as HTMLButtonElement).disabled).toBe(false);
    expect(find('[data-testid="date-range-panel"]')?.textContent).toContain('This screen shows up to 90 days');
  });

  it('marks the fixture when running in demo mode', async () => {
    mockApp.isDemo = true;
    await render(presetSelection('thisMonth', utcTodayKey()), 'pipelines');
    await open();
    expect(fetchActivityDaily).not.toHaveBeenCalled();
    expect(find('[data-testid="date-range-activity"]')?.textContent).toContain('Fixture data, not live');
  });
});
