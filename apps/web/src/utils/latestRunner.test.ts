import { describe, it, expect, vi } from 'vitest';
import { createLatestRunner } from './latestRunner';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('createLatestRunner', () => {
  it('drops a slow, superseded response so it cannot overwrite newer data', async () => {
    const runner = createLatestRunner();
    const first = deferred<string>();
    const second = deferred<string>();
    const results: string[] = [];

    runner.run(() => first.promise, { onSuccess: v => results.push(v) });
    runner.run(() => second.promise, { onSuccess: v => results.push(v) });

    second.resolve('new');
    await tick();
    first.resolve('old'); // arrives AFTER the newer one
    await tick();

    expect(results).toEqual(['new']);
  });

  it('aborts the previous request signal when a new run starts', async () => {
    const runner = createLatestRunner();
    const signals: AbortSignal[] = [];
    runner.run(async s => { signals.push(s); return 1; }, { onSuccess: () => {} });
    runner.run(async s => { signals.push(s); return 2; }, { onSuccess: () => {} });
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('does not report aborted requests as errors', async () => {
    const runner = createLatestRunner();
    const onError = vi.fn();
    const slow = deferred<number>();
    runner.run(() => slow.promise, { onSuccess: () => {}, onError });
    runner.run(async () => 2, { onSuccess: () => {}, onError });
    slow.reject({ name: 'AbortError' });
    await tick();
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores errors of superseded runs but reports the latest one', async () => {
    const runner = createLatestRunner();
    const onError = vi.fn();
    const first = deferred<number>();
    const second = deferred<number>();
    runner.run(() => first.promise, { onSuccess: () => {}, onError });
    runner.run(() => second.promise, { onSuccess: () => {}, onError });
    first.reject(new Error('old failure'));
    second.reject(new Error('current failure'));
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('current failure');
  });

  it('calls onSettled only for the latest run', async () => {
    const runner = createLatestRunner();
    const settled = vi.fn();
    const a = deferred<number>();
    const b = deferred<number>();
    runner.run(() => a.promise, { onSuccess: () => {}, onSettled: settled });
    runner.run(() => b.promise, { onSuccess: () => {}, onSettled: settled });
    a.resolve(1);
    await tick();
    expect(settled).not.toHaveBeenCalled();
    b.resolve(2);
    await tick();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('cancel() discards the pending result', async () => {
    const runner = createLatestRunner();
    const onSuccess = vi.fn();
    const d = deferred<number>();
    runner.run(() => d.promise, { onSuccess });
    runner.cancel();
    d.resolve(1);
    await tick();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
