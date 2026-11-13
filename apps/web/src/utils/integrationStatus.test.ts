import { describe, expect, it } from 'vitest';
import { getIntegrationState } from './integrationStatus';

describe('getIntegrationState', () => {
  it('distinguishes loading and a successful empty result', () => {
    expect(getIntegrationState({ loading: true, hasData: false, backendReachable: true })).toBe('loading');
    expect(getIntegrationState({ loading: false, hasData: false, backendReachable: true, status: { outcome: 'complete', complete: true, stale: false } })).toBe('empty');
  });

  it('marks complete data live and partial data as partial', () => {
    expect(getIntegrationState({ loading: false, hasData: true, backendReachable: true, status: { outcome: 'complete', complete: true, stale: false } })).toBe('live');
    expect(getIntegrationState({ loading: false, hasData: true, backendReachable: true, status: { outcome: 'partial', complete: false, stale: true } })).toBe('partial');
  });

  it('distinguishes a stale snapshot from an error without a successful snapshot', () => {
    expect(getIntegrationState({ loading: false, hasData: true, backendReachable: true, status: { outcome: 'failed', complete: false, stale: true, lastSyncedAt: '2026-11-01T00:00:00Z' } })).toBe('cached');
    expect(getIntegrationState({ loading: false, hasData: false, backendReachable: true, status: { outcome: 'failed', complete: false, stale: true } })).toBe('failed');
  });

  it('retains a previously loaded snapshot after a request error even without a timestamp', () => {
    expect(getIntegrationState({ loading: false, hasData: true, backendReachable: true, requestError: true })).toBe('cached');
  });

  it('keeps backend unreachability distinct and returns to live after recovery', () => {
    expect(getIntegrationState({ loading: false, hasData: true, backendReachable: false })).toBe('unreachable');
    expect(getIntegrationState({ loading: false, hasData: true, backendReachable: true, status: { outcome: 'complete', complete: true, stale: false } })).toBe('live');
  });
});
