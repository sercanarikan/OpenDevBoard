import { createContext, useContext } from 'react';
import type { DateRangeQuery, DateRangeSelection } from '../services/dateRange';

export interface DateRangeValue {
  /** The applied selection. Drafts live in the picker and never reach this context. */
  range: DateRangeSelection;
  /** Request parameters for the analytics API (`days` or calendar bounds). */
  query: DateRangeQuery;
  /** Stable identity for memoization and "did the range change" checks. */
  selectionKey: string;
  /** Calendar bounds; rolling selections resolve against the UTC day of the last change. */
  bounds: { startDate: string; endDate: string };
}

export interface DateRangeActions {
  setRange: (range: DateRangeSelection) => void;
}

export const DateRangeValueContext = createContext<DateRangeValue | null>(null);
export const DateRangeActionsContext = createContext<DateRangeActions | null>(null);

export function useDateRange(): DateRangeValue {
  const value = useContext(DateRangeValueContext);
  if (!value) throw new Error('useDateRange must be used within a DateRangeProvider');
  return value;
}

export function useDateRangeActions(): DateRangeActions {
  const actions = useContext(DateRangeActionsContext);
  if (!actions) throw new Error('useDateRangeActions must be used within a DateRangeProvider');
  return actions;
}
