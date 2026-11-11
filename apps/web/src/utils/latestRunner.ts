/**
 * Runs async work where only the most recent call may publish its result.
 *
 * Starting a new run aborts the previous one (its fetch is cancelled) and any late response from a superseded run is
 * dropped, so a slow old request can never overwrite newer data (search typed quickly, filter changed while paging).
 */
export interface RunHandlers<T> {
  onStart?: () => void;
  onSuccess: (value: T) => void;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
}

export interface LatestRunner {
  run<T>(task: (signal: AbortSignal) => Promise<T>, handlers: RunHandlers<T>): number;
  cancel(): void;
  /** Id of the latest started run (0 = none). */
  readonly currentId: number;
}

export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; isAbort?: boolean } | null;
  return !!e && (e.isAbort === true || e.name === 'AbortError');
}

export function createLatestRunner(): LatestRunner {
  let latest = 0;
  let controller: AbortController | null = null;

  return {
    get currentId() {
      return latest;
    },

    run<T>(task: (signal: AbortSignal) => Promise<T>, handlers: RunHandlers<T>): number {
      controller?.abort();
      const myController = new AbortController();
      controller = myController;
      const id = ++latest;
      handlers.onStart?.();

      task(myController.signal)
        .then(value => {
          if (id !== latest || myController.signal.aborted) return;
          handlers.onSuccess(value);
        })
        .catch(err => {
          if (id !== latest || isAbortError(err)) return;
          handlers.onError?.(err);
        })
        .finally(() => {
          if (id === latest) handlers.onSettled?.();
        });

      return id;
    },

    cancel() {
      latest++;
      controller?.abort();
      controller = null;
    }
  };
}
