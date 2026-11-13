export type IntegrationState = 'loading' | 'live' | 'empty' | 'cached' | 'partial' | 'failed' | 'unreachable';

export interface IntegrationCacheStatus {
  outcome: string;
  complete: boolean;
  stale: boolean;
  lastSyncedAt?: string | null;
}

export function getIntegrationState(input: {
  loading: boolean;
  hasData: boolean;
  backendReachable: boolean;
  requestError?: boolean;
  status?: IntegrationCacheStatus;
}): IntegrationState {
  if (!input.backendReachable) return 'unreachable';
  if (input.loading) return 'loading';
  if (input.status?.outcome === 'partial') return 'partial';
  if (input.requestError || input.status?.outcome === 'failed') {
    return input.hasData && !!input.status?.lastSyncedAt ? 'cached' : 'failed';
  }
  if (input.status?.stale) return 'cached';
  return input.hasData ? 'live' : 'empty';
}
