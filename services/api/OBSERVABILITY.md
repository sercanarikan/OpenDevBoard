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

## Optional Prometheus + Grafana stack

The Prometheus and Grafana services are optional and disabled unless the `observability` profile is selected. The normal `docker compose up` service set and the existing API/web settings are unchanged; a Grafana credential is not required for a normal installation.

### Start and access

Set a strong Grafana administrator password in the Docker Compose process environment (or an approved secret manager) before starting the profile. Do not put it in source control or frontend configuration:

```sh
export GRAFANA_ADMIN_PASSWORD="$(openssl rand -hex 32)"
docker compose --profile observability up -d prometheus grafana
```

Grafana is available at `http://127.0.0.1:3000` by default; `GRAFANA_PORT` changes the host loopback port. The default admin username is `admin`; set `GRAFANA_ADMIN_USER` to change it. The password has no default, and a container startup guard refuses to start Grafana when the mounted secret is empty or missing. Compose supplies it to Grafana through a Compose secret and Grafana's `GF_SECURITY_ADMIN_PASSWORD__FILE` setting. Anonymous access and user sign-up are disabled. Grafana is explicitly configured not to send anonymous usage reports or check for automatic Grafana/plugin updates; image/plugin updates are planned by changing the pinned version deliberately.

The secret is read from the environment of the `docker compose` process. Supply it through a secret manager or a protected shell/session; do not save it in `.env`, command history, or a tracked file. Missing and empty values let normal Compose configuration run, but starting Grafana fails closed.

The three provisioned dashboards appear automatically under the **OpenDevBoard** folder:

- **OpenDevBoard Sync Overview**
- **OpenDevBoard Azure DevOps HTTP**
- **OpenDevBoard Performance**

The provisioned Prometheus datasource uses the private `http://prometheus:9090` address. Prometheus does not publish a host port; Grafana is bound to `127.0.0.1`, and the API port remains private. The existing nginx `/metrics` denial remains in place. Prometheus uses a dedicated private Compose bridge shared only with Grafana and also joins the existing API network to scrape `api:5000/metrics`.

### Data retention and alerts

Prometheus persists samples in `prometheus_data`; Grafana persists its local database in the separate `grafana_data` volume. Both are Docker-managed named volumes scoped to the Compose project. The default retention policy is 14 days with a TSDB block-storage cap configured as `2GB`. Set `PROMETHEUS_STORAGE_LIMIT` to a Prometheus size value such as `1GB` or `512MB` to change the cap; retention removes data when either the time or size limit is reached. Prometheus block compaction can temporarily require additional disk space beyond the configured block limit. Stopping/removing the optional containers preserves both volumes; `docker compose down --volumes` removes them and deletes history/dashboard state. Avoid that command when you need to preserve data.

One synthetic offline run reported snapshots of about 42 MiB for Prometheus (0.32% CPU) and 268 MiB for Grafana (0.96% CPU), with API snapshots around 37–38 MiB and web around 8 MiB. These are single-run Docker stats observations, not capacity requirements; usage varies with scrape/sample volume, dashboard activity, host, and retained data.

Grafana's bootstrap admin password is stored in its persistent database after first startup. Changing `GRAFANA_ADMIN_PASSWORD` alone and recreating the container does not rotate the database credential. While signed in, change the admin password through Grafana's user profile UI, then update the secret supplied to Compose to the same value and recreate Grafana so the runtime secret remains current. If locked out, use the documented Grafana CLI admin password reset against the running container, then update the Compose secret before its next recreation. Do not remove `grafana_data` to rotate a password; that would erase Grafana state.

Prometheus evaluates the rules in `observability/prometheus/alert-rules.yml`. Initial thresholds are:

| Alert | Initial threshold | How to tune |
| --- | --- | --- |
| `MetricsTargetUnavailable` | Scrape unavailable for 2 minutes | Edit the expression or `for` duration in the rule file. |
| `NoRecentSuccessfulSync` | Last successful sync is older than 24 hours, sustained for 5 minutes | Change `86400` seconds or `for`; the expression requires a positive persisted timestamp, so an installation with no successful sync history does not fire it. |
| `SyncErrorsIncreasing` | At least one error in 15 minutes, sustained for 5 minutes | Change the `increase` window, threshold, or `for`. |
| `SyncContinuouslyPartial` | Partial gauge remains 1 for 30 minutes | Change `for`. |
| `AzureHttp429Increasing` | At least 3 HTTP 429 results in 5 minutes, sustained for 2 minutes | Change the `increase` window, threshold, or `for`. |
| `HighProcessMemory` | API process RSS exceeds 1.5 GiB for 10 minutes | Change `1610612736` bytes or `for`. |

Edit the version-controlled rule file to tune alert thresholds, then restart Prometheus to load it. Prometheus evaluates rules and exposes their pending/firing state locally; no Alertmanager or external notification receiver is configured, so no email, chat, webhook, or other notification is sent. Adding a notification path requires separately configuring Alertmanager and a receiver.

### Stop and troubleshoot

Stop just the optional services while leaving the regular OpenDevBoard services running:

```sh
docker compose stop grafana prometheus
```

Start them again with `docker compose --profile observability start prometheus grafana`. A normal `docker compose up` does not start either service. Do not remove the named volumes to stop the stack; deleting them discards Prometheus history and Grafana's local state.

To uninstall only the optional containers while preserving data, run:

```sh
docker compose --profile observability stop grafana prometheus
docker compose --profile observability rm -f grafana prometheus
```

To intentionally erase observability data too, first confirm the actual project-scoped volume names with `docker volume ls --filter label=com.docker.compose.project=opendevboard`, then remove only that project's `prometheus_data` and `grafana_data` volumes. The default project name remains `opendevboard`; a custom Compose project name changes the volume prefixes. Do not remove the shared default network or API cache volume.

If Grafana does not start, confirm `GRAFANA_ADMIN_PASSWORD` is non-empty in the Compose process environment. If the Prometheus target is down, check that API metrics are enabled (`OBSERVABILITY_METRICS_ENABLED` defaults to `1`), that the API is healthy on the Compose network, and that `GET /metrics` returns Prometheus text format. If a dashboard is empty, confirm at least one sync has run and widen the dashboard time range; counters and histograms are process-local and reset when the API process restarts. Prometheus may need one scrape interval (15 seconds) to observe newly created series.

For a private configuration check, use `docker compose --profile observability config --quiet`; for service status use `docker compose --profile observability ps`. Prometheus itself is intentionally reachable only from containers on the private monitoring network.

The pinned official images are Prometheus `v3.15.1` and Grafana `13.3.0`. See the [Prometheus release list](https://github.com/prometheus/prometheus/releases) and [Grafana release list](https://github.com/grafana/grafana/releases) when planning an explicit version update.

### Offline integration validation

Run `python3 scripts/observability/offline_integration.py` from the repository root to build and validate the full stack with a synthetic-only in-process API runner. The test generates unique Compose projects, an ephemeral Grafana password, and project-prefixed test volumes; Compose uses an override to remove the repository `.env` service env file. It checks profile-off API/web configuration and startup, normal Compose configuration without a Grafana secret, missing/empty secret startup failure, internal scrape/metric series, datasource/dashboard/rule provisioning, exporter-stopped Prometheus restart persistence, loopback-only bindings, anonymous-access rejection, sensitive-value absence, and nginx 404 responses. It removes only its uniquely named test projects and test volumes when finished. Run Prometheus rule unit tests with `docker run --rm --entrypoint /bin/promtool -v "$PWD/observability/prometheus:/rules:ro" prom/prometheus:v3.15.1 test rules /rules/alert-rules.test.yml`; synthetic cases cover firing/resolution of all six rules and no-history behavior. No real Azure DevOps request or credential is used.
