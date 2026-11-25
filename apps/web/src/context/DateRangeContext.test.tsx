// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateRangeProvider } from './DateRangeContext';
import { useDateRange, useDateRangeActions } from './useDateRange';
import { DATE_RANGE_STORAGE_KEY, parseStoredRange, serializeRange } from '../services/dateRangeStorage';
import { customSelection, periodSelection, presetSelection, type DateRangeSelection } from '../services/dateRange';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = '2026-11-25';

describe('parseStoredRange', () => {
  it('falls back to the last 30 days when nothing is stored', () => {
    expect(parseStoredRange(null, TODAY)).toEqual(presetSelection('last30', TODAY));
  });

  it('round-trips rolling, custom and period selections', () => {
    const selections: DateRangeSelection[] = [
      presetSelection('last7', TODAY),
      customSelection('2026-10-01', '2026-10-20'),
      periodSelection('month', { year: 2026, month: 9 }, TODAY),
    ];
    for (const selection of selections) {
      expect(parseStoredRange(serializeRange(selection), TODAY)).toEqual(selection);
    }
  });

  it('recomputes relative calendar presets from today instead of trusting stale dates', () => {
    const stored = serializeRange(presetSelection('thisMonth', '2026-10-15'));
    expect(parseStoredRange(stored, TODAY)).toEqual(presetSelection('thisMonth', TODAY));
  });

  it.each([
    ['corrupt json', '{nope'],
    ['not an object', '42'],
    ['wrong version', JSON.stringify({ v: 2, range: { kind: 'rolling', preset: 'last7', days: 7 } })],
    ['unknown rolling preset', JSON.stringify({ v: 1, range: { kind: 'rolling', preset: 'last5', days: 5 } })],
    ['rolling days that disagree with the preset', JSON.stringify({ v: 1, range: { kind: 'rolling', preset: 'last7', days: 700 } })],
    ['future end date', JSON.stringify({ v: 1, range: { kind: 'calendar', preset: 'custom', startDate: '2026-11-01', endDate: '2026-12-31' } })],
    ['span above the limit', JSON.stringify({ v: 1, range: { kind: 'calendar', preset: 'custom', startDate: '2020-01-01', endDate: '2026-11-01' } })],
    ['older than the retention age', JSON.stringify({ v: 1, range: { kind: 'calendar', preset: 'custom', startDate: '2010-01-01', endDate: '2010-01-05' } })],
    ['invalid date', JSON.stringify({ v: 1, range: { kind: 'calendar', preset: 'custom', startDate: '2026-02-31', endDate: '2026-03-01' } })],
    ['end before start', JSON.stringify({ v: 1, range: { kind: 'calendar', preset: 'custom', startDate: '2026-11-10', endDate: '2026-11-01' } })],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(parseStoredRange(raw, TODAY)).toEqual(presetSelection('last30', TODAY));
  });
});

describe('DateRangeProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchSpy = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  let latest: { range: DateRangeSelection; key: string } | null = null;
  let actions: ReturnType<typeof useDateRangeActions> | null = null;
  const Probe = () => {
    const { range, selectionKey } = useDateRange();
    latest = { range, key: selectionKey };
    actions = useDateRangeActions();
    return <span data-testid="probe">{selectionKey}</span>;
  };

  const mount = async () => {
    await act(async () => {
      root.render(
        <DateRangeProvider>
          <Probe />
        </DateRangeProvider>,
      );
    });
  };

  it('starts with the last 30 days and exposes calendar bounds from UTC today', async () => {
    await mount();
    expect(latest?.range).toEqual(presetSelection('last30', new Date().toISOString().slice(0, 10)));
  });

  it('persists the applied selection under a versioned key', async () => {
    await mount();
    const next = customSelection('2026-10-01', '2026-10-20');
    await act(async () => actions!.setRange(next));
    expect(latest?.range).toEqual(next);
    expect(DATE_RANGE_STORAGE_KEY).toMatch(/\.v1$/);
    expect(JSON.parse(window.localStorage.getItem(DATE_RANGE_STORAGE_KEY)!)).toEqual({ v: 1, range: next });
  });

  it('restores a stored selection on mount and ignores corrupt storage', async () => {
    window.localStorage.setItem(DATE_RANGE_STORAGE_KEY, serializeRange(presetSelection('last90', TODAY)));
    await mount();
    expect(latest?.range).toEqual(presetSelection('last90', TODAY));
    await act(async () => root.unmount());
    root = createRoot(container);
    window.localStorage.setItem(DATE_RANGE_STORAGE_KEY, '{broken');
    await mount();
    expect(latest?.range.kind).toBe('rolling');
    expect(latest?.range).toMatchObject({ preset: 'last30' });
  });

  it('keeps working when storage throws on read and write', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await mount();
    await act(async () => actions!.setRange(presetSelection('last14', TODAY)));
    expect(latest?.range).toEqual(presetSelection('last14', TODAY));
  });

  it('changing the global range only updates the context and starts no request', async () => {
    await mount();
    await act(async () => actions!.setRange(presetSelection('last90', TODAY)));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps actions referentially stable so action consumers do not re-render on range changes', async () => {
    let renders = 0;
    const ActionsOnly = () => {
      const a = useDateRangeActions();
      const seen = useRef(a);
      renders += 1;
      actions = a;
      expect(seen.current).toBe(a);
      return null;
    };
    await act(async () => {
      root.render(
        <DateRangeProvider>
          <ActionsOnly />
        </DateRangeProvider>,
      );
    });
    const before = renders;
    await act(async () => actions!.setRange(presetSelection('last7', TODAY)));
    expect(renders).toBe(before);
  });
});
