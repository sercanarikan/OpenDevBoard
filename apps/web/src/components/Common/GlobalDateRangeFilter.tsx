import { useDateRange, useDateRangeActions } from '../../context/useDateRange';
import { DateRangeFilter } from './DateRangeFilter';

/** The one date range control of the app. It lives in the header and reads and writes the global range. */
export function GlobalDateRangeFilter({ disabled }: { disabled?: boolean }) {
  const { range } = useDateRange();
  const { setRange } = useDateRangeActions();
  return <DateRangeFilter value={range} onApply={setRange} disabled={disabled} />;
}
