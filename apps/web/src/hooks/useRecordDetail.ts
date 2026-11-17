import { useCallback, useEffect, useState } from 'react';

export type RecordDetailState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error' };

/**
 * Loads the full record behind a list row (descriptions are not part of list payloads). Each id starts in
 * `loading`, a failed or missing record is an explicit `error`, and a late response for a previous id is ignored.
 */
export function useRecordDetail<T>(
  id: number,
  load: (id: number, signal: AbortSignal) => Promise<T | null>
): { state: RecordDetailState<T>; retry: () => void } {
  const [result, setResult] = useState<{ key: string; state: RecordDetailState<T> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${id}:${attempt}`;

  useEffect(() => {
    const ctrl = new AbortController();
    load(id, ctrl.signal)
      .then(data => {
        if (!ctrl.signal.aborted) setResult({ key, state: data ? { status: 'ready', data } : { status: 'error' } });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setResult({ key, state: { status: 'error' } });
      });
    return () => ctrl.abort();
  }, [id, key, load]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);
  return { state: result?.key === key ? result.state : { status: 'loading' }, retry };
}
