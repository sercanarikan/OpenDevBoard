import type { SyncReportResponse } from '../types/paging';

export type DataSourceKind = 'live' | 'demo' | 'fixture' | 'lost';

/** Which data the user is looking at. Demo and Live are never mixed: the source is decided once per bootstrap. */
export interface DataSourceView {
  kind: DataSourceKind;
}

export type SyncIndicatorKind =
  | 'demo'          // explicit sample data, no backend
  | 'fixture'       // deterministic test fixture served by the backend
  | 'unreachable'   // backend lost after a successful start (data on screen is the last known snapshot)
  | 'syncing'       // a sync is running now
  | 'failed'        // last sync failed or was partial: cached data is served
  | 'cached';       // healthy: cached data, last successful sync known

export interface SyncIndicator {
  kind: SyncIndicatorKind;
  /** Last successful sync (ISO) when known. */
  lastSuccessAt: string | null;
  /** Short machine-readable reason for `failed` (never contains secrets). */
  error: string | null;
  partial: boolean;
}

export function deriveSyncIndicator(input: {
  source: DataSourceKind;
  report: SyncReportResponse | null;
  isSyncing: boolean;
}): SyncIndicator {
  const { source, report, isSyncing } = input;
  const lastSuccessAt = report?.lastSuccessAt || report?.lastSyncedAt || null;

  if (source === 'demo') return { kind: 'demo', lastSuccessAt: null, error: null, partial: false };
  if (source === 'lost') return { kind: 'unreachable', lastSuccessAt, error: null, partial: false };
  if (source === 'fixture') return { kind: 'fixture', lastSuccessAt, error: null, partial: false };

  const status = (report?.status || 'idle').toLowerCase();
  if (isSyncing || status === 'syncing') return { kind: 'syncing', lastSuccessAt, error: null, partial: false };
  if (status === 'error' || status === 'partial') {
    return { kind: 'failed', lastSuccessAt, error: report?.lastError || report?.error || null, partial: status === 'partial' };
  }
  return { kind: 'cached', lastSuccessAt, error: null, partial: false };
}
