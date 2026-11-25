# Synthetic activity benchmark

Test-support code that measures `GET /api/activity/daily` (chunked, coverage-tracked fetches) against a fake upstream.
It is not imported by the service and is not part of the product.

## Run

From `services/api`:

```
python -m bench.bench_activity            # full run (all windows, 5 repetitions, 30 warm calls)
python -m bench.bench_activity --quick    # smoke run (windows 7, 90, 1096; 2 repetitions)
```

Output goes to `<repo>/.local/advanced-date-range-picker/bench/results.json` and `summary.md` (`--out DIR` changes it;
`.local/` is ignored by Git). The counters of the harness are unit tested in `services/api/test_bench_harness.py`; the
timings are reported, never asserted.

## What is synthetic

Everything. `fake_upstream.py` replaces every Azure DevOps call (`azure_http.get`, `requests.get`, `requests.post`) and a
guard makes any other network access fail. No PAT, `.env`, production cache or real Azure DevOps data is used.

- Data: 5 projects named `Synthetic-Project-N`; 20 items per project and month (baseline) or 200 (high volume).
- Upstream behaviour: latency per call (default 5 ms), 429 with a `Retry-After` of 0 or 90, 503, timeout.
- State: one temporary SQLite file per repetition, so cold runs start with an empty coverage ledger.
- Windows: calendar windows of 7, 30, 90, 365 and 1096 days that end today (UTC).
- Backoff sleeps of `AzureClient` are recorded, not slept, so wall-clock times exclude them (the summary prints the
  recorded seconds).

## Scope and caveats

- The main scenarios use `workitems-completed` because its fetch reaches `coverage=complete`. The `pipelines` metric is
  measured separately (`pipelines-cold`, `pipelines-warm`): with project-scoped reads its fetch result is never
  `complete`, so its chunks stay `partial` and refresh re-fetches them.
- The runner is the real `ChunkJobRunner` (2 workers, 64 pending) wrapped by `InstrumentedRunner`, which adds counters.
  `coalesced` is counted by checking for an in-flight key just before `submit`, which is accurate enough for a benchmark.
- Numbers describe this machine, the fake upstream and the synthetic load. They are not an Azure DevOps or production
  performance claim.
