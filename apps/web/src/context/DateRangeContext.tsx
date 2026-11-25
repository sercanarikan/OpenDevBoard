import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { selectionKey, toApiRange, utcTodayKey, type DateRangeSelection } from '../services/dateRange';
import { selectionBounds } from '../services/activityDaily';
import { readStoredRange, writeStoredRange } from '../services/dateRangeStorage';
import { DateRangeActionsContext, DateRangeValueContext, type DateRangeActions, type DateRangeValue } from './useDateRange';

/**
 * Holds the one applied date range of the app. Changing it only updates this context: each mounted screen decides
 * for itself what to fetch, so a global change never starts upstream work for modules that are not on screen.
 */
export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [range, setRangeState] = useState<DateRangeSelection>(readStoredRange);
  const setRange = useCallback((next: DateRangeSelection) => {
    setRangeState(next);
    writeStoredRange(next);
  }, []);
  const actions = useMemo<DateRangeActions>(() => ({ setRange }), [setRange]);
  const value = useMemo<DateRangeValue>(
    () => ({
      range,
      query: toApiRange(range),
      selectionKey: selectionKey(range),
      bounds: selectionBounds(range, utcTodayKey()),
    }),
    [range],
  );
  return (
    <DateRangeActionsContext.Provider value={actions}>
      <DateRangeValueContext.Provider value={value}>{children}</DateRangeValueContext.Provider>
    </DateRangeActionsContext.Provider>
  );
}

