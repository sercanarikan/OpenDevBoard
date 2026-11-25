import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchActivityDaily, onNetworkEvent } from './liveApi';

const params = { metric: 'pipelines' as const, startDate: '2026-11-01', endDate: '2026-11-02', mode: 'cache' as const };

describe('activity requests and global connection status', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not report a successful activity response as backend traffic', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ days: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const events: unknown[] = [];
    const off = onNetworkEvent(event => events.push(event));
    await fetchActivityDaily(params);
    off();
    expect(events).toEqual([]);
  });

  it('does not report an activity timeout or gateway failure as a backend outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 503 })));
    const events: unknown[] = [];
    const off = onNetworkEvent(event => events.push(event));
    await expect(fetchActivityDaily(params)).rejects.toBeDefined();
    off();
    expect(events).toEqual([]);
  });
});
