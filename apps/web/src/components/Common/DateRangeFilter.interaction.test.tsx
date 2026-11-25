// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { DateRangeFilter } from './DateRangeFilter';
import { GlobalDateRangeFilter } from './GlobalDateRangeFilter';
import { MemoryRouter } from 'react-router-dom';
import { DateRangeProvider } from '../../context/DateRangeContext';
import { useDateRange } from '../../context/useDateRange';
import { addDaysToKey, customSelection, periodSelection, presetSelection, utcTodayKey, type DateRangeSelection } from '../../services/dateRange';

const mockApp = vi.hoisted(() => ({ isDemo: false, filters: { selectedProject: 'all' } }));
const fetchActivityDaily = vi.hoisted(() => vi.fn());

vi.mock('../../context/useApp', () => ({ useApp: () => mockApp }));
vi.mock('../../services/liveApi', () => ({ fetchActivityDaily, isTimeoutError: () => false }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Params = { metric: string; startDate: string; endDate: string; mode: string };

const response = (params: Params) => {
  const days = [];
  for (let date = params.startDate; date <= params.endDate; date = addDaysToKey(date, 1)) {
    const n = Number(date.slice(8, 10));
    days.push(n === 3 ? { date, count: null, state: 'partial', stale: false } : n === 4 ? { date, count: null, state: 'not_collected', stale: false } : { date, count: n % 7, state: n % 7 === 0 ? 'covered_zero' : 'covered_active', stale: n === 5 });
  }
  return {
    metric: params.metric,
    window: { kind: 'calendar', startDate: params.startDate, endDate: params.endDate, days: days.length, timezone: 'UTC' },
    days,
    job: { state: 'idle', pending: 0, completed: 0, partial: 0, failed: 0 },
    cacheStatus: { complete: true, partialDays: 0, notCollectedDays: 0 },
  };
};

const setNative = (element: HTMLInputElement | HTMLSelectElement, value: string, eventName: 'input' | 'change') => {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
};

describe('DateRangeFilter (Rev 2)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onApply: ReturnType<typeof vi.fn<(selection: DateRangeSelection) => void>>;
  const today = utcTodayKey();

  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    mockApp.isDemo = false;
    window.localStorage.clear();
    fetchActivityDaily.mockReset();
    fetchActivityDaily.mockImplementation(async (params: Params) => response(params));
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

  const render = async (value: DateRangeSelection) => {
    await act(async () => {
      root.render(<DateRangeFilter value={value} onApply={onApply} />);
    });
  };
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="date-range-trigger"]')!;
  const open = async () => act(async () => trigger().click());
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const click = async (selector: string) => act(async () => find<HTMLButtonElement>(selector)!.click());
  const startInput = () => find<HTMLInputElement>('[data-testid="date-range-start"]')!;
  const endInput = () => find<HTMLInputElement>('[data-testid="date-range-end"]')!;
  const apply = () => find<HTMLButtonElement>('[data-testid="date-range-apply"]')!;
  const enabledDays = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-date]:not([aria-disabled="true"])'));
  const pointer = (type: string, pointerType: string) => {
    const event = new PointerEvent(type, { bubbles: true, pointerType });
    return event;
  };

  it('opens a dialog from the trigger and closes on Escape without applying', async () => {
    await render(presetSelection('last30', today));
    await open();
    expect(find('[data-testid="date-range-panel"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(find('[data-testid="date-range-panel"]')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('opens with the applied range as the draft and shows the most used presets as a vertical list', async () => {
    await render(presetSelection('last30', today));
    await open();
    expect(startInput().value).toBe(addDaysToKey(today, -29));
    expect(endInput().value).toBe(today);
    expect(find('[data-preset="last30"]')!.getAttribute('aria-pressed')).toBe('true');
    for (const preset of ['last7', 'last14', 'last90', 'today', 'thisMonth', 'lastMonth', 'thisYear']) {
      expect(find(`nav [data-preset="${preset}"]`), preset).not.toBeNull();
    }
    const more = find<HTMLDetailsElement>('[data-testid="date-range-more"]')!;
    expect(more.open).toBe(false);
    expect(more.querySelector('[data-preset="lastYear"]')).not.toBeNull();
    expect(more.textContent).toContain('More periods');
  });

  it('a preset changes the draft only and nothing is applied or fetched upstream until Apply', async () => {
    await render(presetSelection('last30', today));
    await open();
    const calls = fetchActivityDaily.mock.calls.length;
    await click('[data-preset="last7"]');
    expect(startInput().value).toBe(addDaysToKey(today, -6));
    expect(onApply).not.toHaveBeenCalled();
    expect(fetchActivityDaily.mock.calls.length).toBe(calls);
    await click('[data-testid="date-range-apply"]');
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(presetSelection('last7', today));
    expect(find('[data-testid="date-range-panel"]')).toBeNull();
  });

  it('Cancel restores the applied range and never applies', async () => {
    await render(presetSelection('last30', today));
    await open();
    await click('[data-preset="last7"]');
    await click('[data-testid="date-range-cancel"]');
    expect(onApply).not.toHaveBeenCalled();
    expect(find('[data-testid="date-range-panel"]')).toBeNull();
    await open();
    expect(startInput().value).toBe(addDaysToKey(today, -29));
  });

  it('presets are a single select on small screens (not chips) and drive the same draft', async () => {
    await render(presetSelection('last30', today));
    await open();
    const select = find<HTMLSelectElement>('[data-testid="date-range-preset-select"]')!;
    expect(select).not.toBeNull();
    expect(Array.from(select.options).map(o => o.value)).toEqual(expect.arrayContaining(['last7', 'last30', 'thisMonth', 'lastYear']));
    expect(select.querySelectorAll('option').length).toBeGreaterThanOrEqual(15);
    await act(async () => setNative(select, 'last7', 'change'));
    expect(startInput().value).toBe(addDaysToKey(today, -6));
  });

  it('keeps the month, quarter and year selector hidden until the calendar title is clicked', async () => {
    await render(presetSelection('last30', today));
    await open();
    const title = find<HTMLButtonElement>('[data-testid="date-range-title"]')!;
    expect(title.getAttribute('aria-expanded')).toBe('false');
    expect(find('[data-testid="date-range-period"]')).toBeNull();
    await act(async () => title.click());
    expect(title.getAttribute('aria-expanded')).toBe('true');
    const selector = find('[data-testid="date-range-period"]')!;
    expect(selector).not.toBeNull();
    for (const view of ['month', 'quarter', 'year']) expect(selector.querySelector(`[data-view="${view}"]`)).not.toBeNull();
    await act(async () => title.click());
    expect(find('[data-testid="date-range-period"]')).toBeNull();
  });

  it('selects a whole past month directly and applies it as a month period', async () => {
    await render(presetSelection('last30', today));
    await open();
    await click('[data-testid="date-range-title"]');
    await click('[data-view="month"]');
    await click('[data-testid="date-range-period-prev"]');
    const year = Number(today.slice(0, 4)) - 1;
    await click('[data-month="3"]');
    expect(startInput().value).toBe(`${year}-03-01`);
    expect(endInput().value).toBe(`${year}-03-31`);
    expect(find('[data-testid="date-range-period"]')).toBeNull();
    await click('[data-testid="date-range-apply"]');
    expect(onApply).toHaveBeenCalledWith(periodSelection('month', { year, month: 3 }, today));
  });

  it('selects a whole past quarter directly', async () => {
    await render(presetSelection('last30', today));
    await open();
    await click('[data-testid="date-range-title"]');
    await click('[data-view="quarter"]');
    await click('[data-testid="date-range-period-prev"]');
    const year = Number(today.slice(0, 4)) - 1;
    await click('[data-quarter="2"]');
    expect(startInput().value).toBe(`${year}-04-01`);
    expect(endInput().value).toBe(`${year}-06-30`);
    await click('[data-testid="date-range-apply"]');
    expect(onApply).toHaveBeenCalledWith(periodSelection('quarter', { year, quarter: 2 }, today));
  });

  it('selects a whole past year and clips the year in progress at today', async () => {
    await render(presetSelection('last30', today));
    await open();
    await click('[data-testid="date-range-title"]');
    await click('[data-view="year"]');
    const current = Number(today.slice(0, 4));
    await click(`[data-year="${current}"]`);
    expect(startInput().value).toBe(`${current}-01-01`);
    expect(endInput().value).toBe(today);
    await click('[data-testid="date-range-title"]');
    await click('[data-view="year"]');
    await click(`[data-year="${current - 1}"]`);
    await click('[data-testid="date-range-apply"]');
    expect(onApply).toHaveBeenCalledWith(periodSelection('year', { year: current - 1 }, today));
  });

  it('does not limit year navigation to a fixed list and never goes past this year', async () => {
    await render(presetSelection('last30', today));
    await open();
    await click('[data-testid="date-range-title"]');
    await click('[data-view="year"]');
    const current = Number(today.slice(0, 4));
    expect(find<HTMLButtonElement>('[data-testid="date-range-period-next"]')!.disabled).toBe(true);
    for (let i = 0; i < 5; i += 1) await click('[data-testid="date-range-period-prev"]');
    expect(find(`[data-year="${current - 60}"]`)).not.toBeNull();
    expect(find('[data-testid="date-range-period-next"]') as HTMLButtonElement).toHaveProperty('disabled', false);
    // Years older than the retention age stay navigable but cannot be chosen.
    expect(find<HTMLButtonElement>(`[data-year="${current - 60}"]`)!.disabled).toBe(true);
  });

  it('selects a range with two calendar clicks and Apply applies it atomically as custom', async () => {
    await render(presetSelection('last30', today));
    await open();
    const cells = enabledDays();
    const first = cells[0].dataset.date!;
    const last = cells[cells.length - 1].dataset.date!;
    await act(async () => cells[0].click());
    await act(async () => cells[cells.length - 1].click());
    expect(startInput().value).toBe(first);
    expect(endInput().value).toBe(last);
    expect(onApply).not.toHaveBeenCalled();
    await click('[data-testid="date-range-apply"]');
    expect(onApply).toHaveBeenCalledWith(customSelection(first, last));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('validates manual start and end input and disables Apply while invalid', async () => {
    await render(presetSelection('last30', today));
    await open();
    await act(async () => setNative(endInput(), addDaysToKey(today, 5), 'input'));
    expect(apply().disabled).toBe(true);
    expect(find('[data-testid="date-range-error"]')?.textContent).toContain('Future dates are not available');
    await act(async () => setNative(endInput(), 'nonsense', 'input'));
    expect(apply().disabled).toBe(true);
    expect(find('[data-testid="date-range-error"]')?.textContent).toContain('valid date');
    await act(async () => setNative(endInput(), today, 'input'));
    await act(async () => setNative(startInput(), addDaysToKey(today, -3), 'input'));
    expect(apply().disabled).toBe(false);
    expect(find('[data-testid="date-range-error"]')?.textContent ?? '').toBe('');
    await click('[data-testid="date-range-apply"]');
    expect(onApply).toHaveBeenCalledWith(customSelection(addDaysToKey(today, -3), today));
  });

  it('metric select changes only the heatmap source', async () => {
    await render(presetSelection('last30', today));
    await open();
    const select = find<HTMLSelectElement>('[data-testid="date-range-metric"]')!;
    expect(Array.from(select.options).map(o => o.textContent)).toEqual(['Pipeline runs', 'Deployments', 'Commits']);
    await act(async () => setNative(select, 'commits', 'change'));
    expect(fetchActivityDaily.mock.calls.at(-1)![0].metric).toBe('commits');
    expect(fetchActivityDaily.mock.calls.every(([params]) => params.mode === 'cache')).toBe(true);
    expect(startInput().value).toBe(addDaysToKey(today, -29));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('renders calendar cells as the activity heatmap with the full state set', async () => {
    await render(customSelection(`${today.slice(0, 8)}01`, today));
    await open();
    await act(async () => undefined);
    const cells = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-date]'));
    expect(cells.length).toBeGreaterThan(27);
    const states = new Set(cells.map(c => c.dataset.state));
    expect(states.has('covered_active')).toBe(true);
    const active = cells.find(c => c.dataset.state === 'covered_active')!;
    expect(Number(active.dataset.level)).toBeGreaterThanOrEqual(1);
    expect(Number(active.dataset.level)).toBeLessThanOrEqual(6);
    const legend = find('[data-testid="date-range-legend"]')!.textContent!;
    for (const label of ['Scanned, no activity', 'Activity', 'Partly collected', 'Not collected', 'Outside retention', 'Refresh pending']) expect(legend).toContain(label);
    expect(cells.every(c => (c.getAttribute('aria-label') ?? '').length > 0)).toBe(true);
  });

  it('shows the tooltip for mouse hover and keyboard focus only, and day info in the footer for touch', async () => {
    await render(customSelection(`${today.slice(0, 8)}01`, today));
    await open();
    await act(async () => undefined);
    const cell = enabledDays()[0];
    await act(async () => cell.dispatchEvent(pointer('pointerover', 'touch')));
    expect(find('[data-testid="date-range-tooltip"]')).toBeNull();
    await act(async () => cell.dispatchEvent(pointer('pointerdown', 'touch')));
    expect(find('[data-testid="date-range-info"]')!.textContent).toContain(cell.getAttribute('aria-label')!.split(':')[0]);
    expect(find('[data-testid="date-range-tooltip"]')).toBeNull();
    await act(async () => cell.dispatchEvent(pointer('pointerover', 'mouse')));
    expect(find('[data-testid="date-range-tooltip"]')).not.toBeNull();
    await act(async () => cell.dispatchEvent(pointer('pointerout', 'mouse')));
    expect(find('[data-testid="date-range-tooltip"]')).toBeNull();
  });

  it('moves calendar focus with the arrow keys', async () => {
    await render(customSelection(`${today.slice(0, 8)}01`, today));
    await open();
    const cells = enabledDays();
    if (cells.length < 2) return; // first day of the month: nothing to step to
    await act(async () => cells[0].focus());
    await act(async () => cells[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await act(async () => undefined);
    expect((document.activeElement as HTMLElement).dataset.date).toBe(cells[1].dataset.date);
  });

  it('shows the timeline and does not request again while dragging or applying nothing', async () => {
    await render(presetSelection('thisMonth', today));
    await open();
    expect(find('[data-testid="activity-timeline"]')).not.toBeNull();
    const afterOpen = fetchActivityDaily.mock.calls.length;
    expect(afterOpen).toBeGreaterThan(0);
    const end = document.querySelector<HTMLElement>('[data-handle="end"]')!;
    await act(async () => {
      end.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, pointerId: 1 }));
      end.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 40, pointerId: 1 }));
    });
    expect(fetchActivityDaily.mock.calls.length).toBe(afterOpen);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('marks the fixture when running in demo mode and makes no network request', async () => {
    mockApp.isDemo = true;
    await render(presetSelection('thisMonth', today));
    await open();
    expect(fetchActivityDaily).not.toHaveBeenCalled();
    expect(find('[data-testid="date-range-fixture"]')?.textContent).toContain('Fixture data, not live');
  });

  it('renders Turkish labels including the metric options', async () => {
    await i18n.changeLanguage('tr');
    try {
      await render(presetSelection('last30', today));
      await open();
      const select = find<HTMLSelectElement>('[data-testid="date-range-metric"]')!;
      expect(Array.from(select.options).map(o => o.textContent)).toEqual(['Pipeline çalıştırmaları', "Deployment'lar", "Commit'ler"]);
      expect(find('[data-testid="date-range-apply"]')!.textContent).toContain('Uygula');
      expect(find('[data-testid="date-range-more"]')!.textContent).toContain('Diğer dönemler');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('GlobalDateRangeFilter', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });
  beforeEach(() => {
    window.localStorage.clear();
    fetchActivityDaily.mockReset();
    fetchActivityDaily.mockImplementation(async (params: Params) => response(params));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  it('applies to the global context so every consumer sees the same range', async () => {
    let seen: DateRangeSelection | null = null;
    const Consumer = () => {
      seen = useDateRange().range;
      return null;
    };
    await act(async () => {
      root.render(
        <MemoryRouter>
          <DateRangeProvider>
            <GlobalDateRangeFilter />
            <Consumer />
          </DateRangeProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="date-range-trigger"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-preset="last7"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="date-range-apply"]')!.click());
    expect(seen).toEqual(presetSelection('last7', utcTodayKey()));
    expect(document.querySelector('[data-testid="date-range-trigger"]')!.textContent).toContain('Last 7 days');
  });
});
