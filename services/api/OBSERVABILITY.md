# Backend metrics

The Flask API exposes a Prometheus text-format scrape at `GET /metrics`. The API listens on its configured backend port (5000 in Compose); the current Compose file only exposes that port on the private Docker network. The web nginx returns 404 for `/metrics` and does not proxy the endpoint. `/api/metrics` is not an API route.

The API also rejects scrape requests whose source address is not loopback, private, or link-local. **This is defense in depth, not authentication.** Private-address clients are not necessarily trusted. Keep the API port unpublished, restrict access to the Docker network, and do not add a public reverse-proxy route. The IP check must not be treated as an identity or authorization boundary.

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `OBSERVABILITY_METRICS_ENABLED` | `1` | Set to `0`, `false`, `no`, or `off` to stop metric updates and make `/metrics` return 404. |

Counters and histograms are process-local and reset when the API process restarts. On scrape, the API reloads `last_successful_sync_timestamp_seconds`, `sync_partial`, and `closure_dirty` from the existing sync state. The scheduler loop restores its backoff gauge from persisted retry timing while it waits. Process RSS, process CPU, run counters, and histograms describe the current process lifetime.

## Metrics

All labels use bounded enums. No PAT, organization URL, project, Work Item ID, title, description, or user data is used as a label or metric value.

| Metric | Type | Labels / meaning |
| --- | --- | --- |
| `opendevboard_sync_runs_total` | Counter | `mode=full|incremental`, bounded `status` outcome |
| `opendevboard_sync_duration_seconds` | Histogram | `mode`; wall-clock time around one sync invocation |
| `opendevboard_sync_phase_duration_seconds` | Histogram | `phase=wiql|detail_fetch|context_closure|reconciliation|sqlite_publish` |
| `opendevboard_http_attempts_total` | Counter | `method=GET|POST`; incremented immediately before each Azure HTTP call |
| `opendevboard_http_retries_total` | Counter | Retry attempts after transient responses or network errors |
| `opendevboard_http_results_total` | Counter | `result=2xx|429|503|4xx|5xx|other|network` |
| `opendevboard_wiql_calls_total` | Counter | Logical WIQL calls, including partition queries |
| `opendevboard_work_items_processed_total` | Counter | `kind=fetched|upserted` |
| `opendevboard_context_items_processed_total` | Counter | Context items upserted |
| `opendevboard_last_successful_sync_timestamp_seconds` | Gauge | Unix timestamp persisted as last successful sync |
| `opendevboard_sync_partial` | Gauge | Whether the latest sync outcome is partial (`1`/`0`) |
| `opendevboard_closure_dirty` | Gauge | Persisted context-closure dirty state (`1`/`0`) |
| `opendevboard_scheduler_backoff_seconds` | Gauge | Current scheduler retry delay / remaining initial-full wait |
| `opendevboard_process_rss_bytes` | Gauge | Current resident memory |
| `opendevboard_process_peak_rss_bytes` | Gauge | Process lifetime peak RSS from the OS |
| `opendevboard_sync_peak_rss_bytes` | Gauge | Highest RSS sampled during the latest sync; distinct from process lifetime peak |
| `opendevboard_process_cpu_seconds_total` | Counter | Process CPU time accumulated over its lifetime |
| `opendevboard_sync_cpu_seconds` | Histogram | Process CPU consumed during a sync wall-clock window; includes concurrent work in other threads |

`sync_duration_seconds` is wall time for the sync implementation, including Azure retry/backoff waits and phase work. Phase histograms time logical operations: WIQL collection includes partition fallback; detail fetch records each Azure item-detail read (including retries and streaming batches); context closure and reconciliation measure their broader work and therefore overlap with detail-fetch observations; SQLite publish covers the cache publish transaction and derived-data work. Phase samples are not additive and should not be summed to estimate total duration. Failed phase operations are observed as well.

The per-sync RSS gauge is sampled during the run and includes its start/end readings; short-lived memory spikes between samples may not be captured. The process lifetime peak is reported separately from the OS high-water mark. Metrics collection is best-effort and does not participate in sync/cache transaction outcomes.

The current Flask runtime serves threaded requests in one process. If deployment changes to multiple worker processes, use an explicit Prometheus multiprocess registry/aggregation strategy before scraping; the current registry is process-local.
