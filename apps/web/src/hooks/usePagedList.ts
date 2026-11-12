import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { ListParams, ListResponse } from '../types/paging';
import { createLatestRunner } from '../utils/latestRunner';
import { queryKey } from '../utils/listParams';
import { useDebounced } from './useDebounced';

export const SEARCH_DEBOUNCE_MS = 300;

export interface PagedList {
  data: ListResponse | null;
  items: ListResponse['items'];
  total: number;
  limit: number;
  offset: number;
  page: number;
  totalPages: number;
  loading: boolean;
  /** Search text is typed but its debounced request has not started yet. */
  debouncing: boolean;
  error: Error | null;
  retry: () => void;
  goToPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

/**
 * Server-side pagination for a list query.
 *  - search is debounced (300 ms); every other filter applies immediately
 *  - any filter / sort / page-size change resets to the first page
 *  - superseded requests are aborted and their late responses are ignored (no stale overwrite)
 *  - the previous page stays visible while the next one loads (no flicker)
 *  - reloads when the backend data version changes (sync finished) or when retried
 */
export function usePagedList(params: ListParams, opts: { initialPageSize?: number; enabled?: boolean } = {}): PagedList {
  const { api, refreshToken, booting } = useApp();
  const enabled = (opts.enabled ?? true) && !booting;

  const [pageSize, setPageSizeState] = useState(opts.initialPageSize ?? 50);
  const debouncedSearch = useDebounced(params.search ?? '', SEARCH_DEBOUNCE_MS);
  const effective = useMemo<ListParams>(() => ({ ...params, search: debouncedSearch }), [params, debouncedSearch]);
  const key = queryKey({ ...effective, pageSize });

  const [pageState, setPageState] = useState({ key: '', offset: 0 });
  const offset = pageState.key === key ? pageState.offset : 0;

  const [state, setState] = useState<{ data: ListResponse | null; loading: boolean; error: Error | null }>({
    data: null,
    loading: true,
    error: null
  });
  const [retryNonce, setRetryNonce] = useState(0);

  const runnerRef = useRef(createLatestRunner());
  // Keep the request object stable for equivalent queries without reading a ref
  // during render. A changed query resets the page and starts a new request.
  const [request, setRequest] = useState(() => ({ key, effective }));
  if (request.key !== key) setRequest({ key, effective });

  useEffect(() => {
    if (!enabled) return;
    runnerRef.current.run(
      signal => api.list({ ...request.effective, limit: pageSize, offset }, signal),
      {
        onStart: () => setState(s => ({ ...s, loading: true, error: null })),
        onSuccess: data => {
          // The data shrank under us (e.g. after a sync): jump to the last page that still exists.
          if (data.total > 0 && data.offset >= data.total) {
            const last = Math.floor((data.total - 1) / pageSize) * pageSize;
            setPageState({ key, offset: last });
            return;
          }
          setState({ data, loading: false, error: null });
        },
        onError: err => setState(s => ({ ...s, loading: false, error: err as Error }))
      }
    );
  }, [enabled, api, key, offset, pageSize, refreshToken, retryNonce, request]);

  useEffect(() => {
    const runner = runnerRef.current;
    return () => runner.cancel();
  }, []);

  const total = state.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(totalPages, page));
      setPageState({ key, offset: (clamped - 1) * pageSize });
    },
    [key, pageSize, totalPages]
  );

  const setPageSize = useCallback((size: number) => setPageSizeState(size), []);
  const retry = useCallback(() => setRetryNonce(n => n + 1), []);

  return {
    data: state.data,
    items: state.data?.items ?? [],
    total,
    limit: pageSize,
    offset,
    page: Math.floor(offset / pageSize) + 1,
    totalPages,
    loading: state.loading,
    debouncing: (params.search ?? '') !== debouncedSearch,
    error: state.error,
    retry,
    goToPage,
    setPageSize
  };
}
