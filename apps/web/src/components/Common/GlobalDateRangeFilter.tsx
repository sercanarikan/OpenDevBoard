import { useLocation } from 'react-router-dom';
import { useDateRange, useDateRangeActions } from '../../context/useDateRange';
import { activityMetricsForPath } from '../../services/activityDaily';
import { DateRangeFilter } from './DateRangeFilter';

/** The one date range control of the app. It lives in the header and reads and writes the global range. */
export function GlobalDateRangeFilter({ disabled }: { disabled?: boolean }) {
  const { range } = useDateRange();
  const { setRange } = useDateRangeActions();
  const { pathname } = useLocation();
  return <DateRangeFilter value={range} onApply={setRange} disabled={disabled} metrics={activityMetricsForPath(pathname)} />;
}
