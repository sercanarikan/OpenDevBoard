import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Page number that belongs to one date range. When the global range changes the page is 1 again without any
 * effect-driven state sync, so the first request for a new range never asks for a page of the old one.
 */
export function useRangeScopedPage(rangeKey: string): [number, Dispatch<SetStateAction<number>>] {
  const [state, setState] = useState({ key: rangeKey, page: 1 });
  const page = state.key === rangeKey ? state.page : 1;
  const setPage = useCallback<Dispatch<SetStateAction<number>>>(
    update => setState(previous => {
      const current = previous.key === rangeKey ? previous.page : 1;
      return { key: rangeKey, page: typeof update === 'function' ? update(current) : update };
    }),
    [rangeKey],
  );
  return [page, setPage];
}

/** Runs the callback when the range changes after mount (not on the first render). */
export function useOnRangeChange(rangeKey: string, callback: () => void): void {
  const previous = useRef(rangeKey);
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    if (previous.current === rangeKey) return;
    previous.current = rangeKey;
    latest.current();
  }, [rangeKey]);
}
