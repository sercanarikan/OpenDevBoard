import { useEffect, useState } from 'react';
import { useApp } from '../../../context/useApp';
import { demoActivityDaily, isValidActivityRange, type ActivityDailyResponse, type ActivityMetric, type ActivityMode } from '../../../services/activityDaily';
import { fetchActivityDaily, isTimeoutError } from '../../../services/liveApi';

export const ACTIVITY_POLL_MS = 2000;

export interface UseActivityDailyOptions {
  metric: ActivityMetric;
  startDate: string;
  endDate: string;
  mode: ActivityMode;
  enabled: boolean;
}

export interface UseActivityDailyResult {
  data: ActivityDailyResponse | null;
  error: 'timeout' | 'failed' | null;
  loading: boolean;
}

interface Snapshot {
  key: string;
  data: ActivityDailyResponse | null;
  error: 'timeout' | 'failed' | null;
  loading: boolean;
}

/**
 * Loads activity counts for a range. Only the response for the latest request key is returned, so a slow
 * earlier response can never overwrite a newer selection. While the backend reports a running job, the same
 * request is polled. Demo mode uses the deterministic fixture and makes no network request.
 */
export function useActivityDaily({ metric, startDate, endDate, mode, enabled }: UseActivityDailyOptions): UseActivityDailyResult {
  const { isDemo } = useApp();
  const requestKey = `${isDemo ? 'demo' : 'live'}|${metric}|${mode}|${startDate}|${endDate}`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!enabled || !isValidActivityRange(startDate, endDate)) return undefined;
    const params = { metric, startDate, endDate, mode };
    if (isDemo) {
      setSnapshot({ key: requestKey, data: demoActivityDaily(params), error: null, loading: false });
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = () => {
      fetchActivityDaily(params, controller.signal)
        .then(data => {
          if (cancelled) return;
          setSnapshot({ key: requestKey, data, error: null, loading: false });
          if (data.job.state === 'running') timer = setTimeout(load, ACTIVITY_POLL_MS);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setSnapshot({ key: requestKey, data: null, error: isTimeoutError(error) ? 'timeout' : 'failed', loading: false });
        });
    };

    setSnapshot(previous => ({ key: requestKey, data: previous?.key === requestKey ? previous.data : null, error: null, loading: true }));
    load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // requestKey already encodes every input the effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled]);

  const current = snapshot && snapshot.key === requestKey ? snapshot : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: enabled && (current ? current.loading : true),
  };
}

