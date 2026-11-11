import { describe, it, expect } from 'vitest';
import { deriveSyncIndicator } from './syncState';
import type { SyncReportResponse } from '../types/paging';

const report = (over: Partial<SyncReportResponse> = {}): SyncReportResponse => ({
  status: 'idle',
  totalOrgActive: 10,
  totalCached: 12,
  lastSuccessAt: '2026-11-05T10:00:00',
  ...over
});

describe('deriveSyncIndicator', () => {
  it('shows healthy cached data with the last successful sync', () => {
    const r = deriveSyncIndicator({ source: 'live', report: report(), isSyncing: false });
    expect(r.kind).toBe('cached');
    expect(r.lastSuccessAt).toBe('2026-11-05T10:00:00');
  });

  it('shows sync in progress from the backend status or the local trigger', () => {
    expect(deriveSyncIndicator({ source: 'live', report: report({ status: 'syncing' }), isSyncing: false }).kind).toBe('syncing');
    expect(deriveSyncIndicator({ source: 'live', report: report(), isSyncing: true }).kind).toBe('syncing');
  });

  it('shows failure and keeps the last good sync time', () => {
    const r = deriveSyncIndicator({ source: 'live', report: report({ status: 'error', lastError: 'HTTP 503' }), isSyncing: false });
    expect(r.kind).toBe('failed');
    expect(r.error).toBe('HTTP 503');
    expect(r.partial).toBe(false);
    expect(r.lastSuccessAt).toBe('2026-11-05T10:00:00');
  });

  it('treats a partial sync as failed, never as healthy', () => {
    const r = deriveSyncIndicator({ source: 'live', report: report({ status: 'partial', lastError: 'mass_delete_blocked' }), isSyncing: false });
    expect(r.kind).toBe('failed');
    expect(r.partial).toBe(true);
  });

  it('never presents demo data as live or cached', () => {
    const r = deriveSyncIndicator({ source: 'demo', report: report(), isSyncing: false });
    expect(r.kind).toBe('demo');
    expect(r.lastSuccessAt).toBeNull();
  });

  it('keeps a lost backend distinct from demo mode', () => {
    expect(deriveSyncIndicator({ source: 'lost', report: report(), isSyncing: false }).kind).toBe('unreachable');
  });

  it('marks fixture data explicitly', () => {
    expect(deriveSyncIndicator({ source: 'fixture', report: report(), isSyncing: false }).kind).toBe('fixture');
  });

  it('copes with a missing report', () => {
    expect(deriveSyncIndicator({ source: 'live', report: null, isSyncing: false }).kind).toBe('cached');
  });
});
