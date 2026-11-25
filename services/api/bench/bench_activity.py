"""Synthetic benchmark of GET /api/activity/daily. Run from services/api:

    python -m bench.bench_activity [--quick] [--out DIR]

Everything is synthetic: a fake upstream (bench/fake_upstream.py) replaces every Azure DevOps call, data is generated,
and each repetition uses a temporary SQLite file. No PAT, no network, no production cache. Results are written to
``<repo>/.local/advanced-date-range-picker/bench/results.json`` and ``summary.md`` by default. Timings describe this
machine and this synthetic load only; they are not a statement about Azure DevOps or production behaviour.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import testsupport  # noqa: F401  (isolates the cache database; must precede the project imports)
import activity_chunks
import activity_service
import azure_client
import coverage_ledger
import date_window
import persistence
import pipeline_service
from bench.fake_upstream import FakeUpstream, default_projects
from bench.harness import InstrumentedRunner, percentile

api_app = testsupport.app
ORG = "https://dev.example.invalid/org"
WINDOWS = (7, 30, 90, 365, 1096)
PROJECTS = default_projects(5)
BASE_RUNS = 20          # synthetic pipeline runs per project and month, baseline
HIGH_RUNS = 200         # high-volume scenario
BASE_LATENCY = 0.005    # seconds per fake upstream call
SYNTHETIC = "synthetic"
MAIN_METRIC = "workitems-completed"   # reaches coverage=complete (AzureClient path); pipelines never does, see README


def utc_today():
    return datetime.now(timezone.utc).date()


def query(metric, days, mode="refresh"):
    today = utc_today()
    return (f"/api/activity/daily?metric={metric}&startDate={(today - timedelta(days=days - 1)).isoformat()}"
            f"&endDate={today.isoformat()}&mode={mode}")


def window_for(days):
    today = utc_today()
    return date_window.calendar_window(today - timedelta(days=days - 1), today, today=today)


def ms(seconds):
    return round(seconds * 1000.0, 3)


def summarize(samples_ms):
    return {"n": len(samples_ms), "p50": round(percentile(samples_ms, 50), 3) if samples_ms else None,
            "p95": round(percentile(samples_ms, 95), 3) if samples_ms else None,
            "max": round(max(samples_ms), 3) if samples_ms else None}


class Env:
    """One isolated benchmark environment: temp SQLite file, instrumented runner, fake upstream, patched app."""

    def __init__(self, upstream: FakeUpstream, max_pending=64, workers=2, sleep_log=None):
        self.upstream = upstream
        self.tmp = tempfile.TemporaryDirectory(prefix="odb-bench-")
        self.db_path = os.path.join(self.tmp.name, "bench.db")
        self.max_pending, self.workers = max_pending, workers
        self.sleep_log = sleep_log if sleep_log is not None else []
        self.stack = ExitStack()
        self.runner = None

    def __enter__(self):
        s = self.stack
        s.enter_context(mock.patch.object(persistence, "DB_PATH", self.db_path))
        s.enter_context(mock.patch.object(api_app.sync_service, "is_fixture_mode", return_value=False))
        s.enter_context(mock.patch("feature_context.is_fixture_mode", return_value=False))
        s.enter_context(mock.patch.object(api_app, "get_projects_data", return_value=[{"name": p} for p in PROJECTS]))
        s.enter_context(mock.patch.object(api_app, "get_devops_org_url", return_value=ORG))
        s.enter_context(mock.patch.object(api_app, "get_devops_org_name", return_value="org"))
        s.enter_context(mock.patch.object(api_app, "get_devops_pat", return_value="SYNTHETIC-NOT-A-REAL-PAT"))
        # Hard network guard: any request that is not served by the fake upstream fails loudly.
        def blocked(*_a, **_k):
            raise RuntimeError("network access is blocked in the synthetic benchmark")
        s.enter_context(mock.patch("requests.sessions.Session.request", blocked))
        s.enter_context(mock.patch("azure_http.get", self.upstream.get))
        log = self.sleep_log

        class BenchClient(azure_client.AzureClient):
            def __init__(self, org_url, pat, **kw):
                kw["sleep"] = lambda seconds: log.append(seconds)  # backoff is recorded, never slept
                super().__init__(org_url, pat, **kw)
                BenchClient.instances.append(self)
        BenchClient.instances = []
        self.client_cls = BenchClient
        s.enter_context(mock.patch.object(azure_client, "AzureClient", BenchClient))
        s.enter_context(mock.patch("requests.get", self.upstream.items_get))
        s.enter_context(mock.patch("requests.post", self.upstream.wiql_post))
        pipeline_service.init_pipeline_db()
        self.new_runner()
        return self

    def new_runner(self):
        if self.runner is not None:
            self.runner.shutdown(wait=True)
        self.runner = InstrumentedRunner(db_path=self.db_path, max_workers=self.workers, max_pending=self.max_pending)
        api_app._activity_runner = self.runner
        return self.runner

    def __exit__(self, *exc):
        if self.runner is not None:
            self.runner.shutdown(wait=True)
        api_app._activity_runner = None
        self.stack.close()
        self.tmp.cleanup()

    def conn(self):
        return persistence.get_db_connection(self.db_path)

    def scope(self):
        return coverage_ledger.scope_key(ORG, sorted(PROJECTS))

    def ledger(self, metric, days):
        keys = [activity_chunks.chunk_key(c) for c in activity_chunks.plan_month_chunks(window_for(days))]
        conn = self.conn()
        try:
            return keys, coverage_ledger.read_coverage(conn, self.scope(), metric, keys)
        finally:
            conn.close()

    def hits_misses(self, metric, days):
        keys, cov = self.ledger(metric, days)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        hits = sum(1 for k in keys if k in cov and cov[k]["coverage"] == "complete"
                   and coverage_ledger.freshness(cov[k]["fetchedAt"], cov[k]["chunkEnd"], now=now) == coverage_ledger.FRESH)
        return len(keys), hits, len(keys) - hits


def call(client, path):
    start = time.perf_counter()
    response = client.get(path)
    elapsed = time.perf_counter() - start
    return response, elapsed


def run_until_done(client, metric, days, timeout=180.0):
    """Poll mode=cache until no chunk is running; return the last body."""
    deadline = time.time() + timeout
    while True:
        body = client.get(query(metric, days, "cache")).get_json()
        if body["job"]["state"] != "running":
            return body
        if time.time() > deadline:
            raise TimeoutError("chunk jobs did not finish")
        time.sleep(0.003)


def prep_warm(env, metric, days):
    """Fill the ledger and tables with a real (fake-upstream) cold pass, then restart the runner."""
    client = api_app.app.test_client()
    client.get(query(metric, days, "refresh"))
    run_until_done(client, metric, days)
    env.new_runner()
    env.upstream.reset_counters()


def mark_every_third_partial(env, metric, days):
    keys, _ = env.ledger(metric, days)
    conn = env.conn()
    try:
        for index, key in enumerate(keys):
            if index % 3 == 0:
                conn.execute("UPDATE coverage_chunks SET coverage = 'partial' WHERE scope_key = ? AND source = ? AND chunk_start = ?",
                             (env.scope(), metric, key))
        conn.commit()
    finally:
        conn.close()


def one_rep(env, metric, days):
    """One refresh call plus polling to completion. Returns a dict of measurements."""
    client = api_app.app.test_client()
    chunks, hits, misses = env.hits_misses(metric, days)
    env.upstream.reset_counters()
    base = env.runner.snapshot()
    started = time.perf_counter()
    response, api_s = call(client, query(metric, days, "refresh"))
    body = run_until_done(client, metric, days)
    job_s = time.perf_counter() - started
    snap = env.runner.snapshot()
    return {
        "status": response.status_code, "apiMs": ms(api_s), "jobMs": ms(job_s), "chunks": chunks,
        "cacheHits": hits, "cacheMisses": misses,
        "upstreamRequests": env.upstream.counters["requests"],
        "upstreamListCalls": env.upstream.counters["builds"] + env.upstream.counters["wiql"],
        "recordedSleepSeconds": round(sum(env.sleep_log), 3), "sleepCount": len(env.sleep_log),
        "upstreamStatus": {k: v for k, v in env.upstream.counters.items() if k.startswith("status_") or k == "timeouts"},
        "submitted": snap["counters"].get("submitted", 0) - base["counters"].get("submitted", 0),
        "started": snap["counters"].get("started", 0), "coalesced": snap["counters"].get("coalesced", 0),
        "busy": snap["counters"].get("busy", 0), "queueDepthPeak": snap["queueDepthPeak"],
        "finalJob": {k: body["job"][k] for k in ("state", "completed", "partial", "failed", "deferred", "pending")},
        "complete": body["cacheStatus"]["complete"],
    }


def aggregate_reps(reps):
    def med(key):
        return statistics.median(r[key] for r in reps)
    last = reps[-1]
    return {
        "reps": len(reps), "apiMs": summarize([r["apiMs"] for r in reps]), "jobMs": summarize([r["jobMs"] for r in reps]),
        "chunks": last["chunks"], "cacheHits": med("cacheHits"), "cacheMisses": med("cacheMisses"),
        "upstreamRequests": med("upstreamRequests"), "upstreamListCalls": med("upstreamListCalls"),
        "recordedSleepSeconds": med("recordedSleepSeconds"), "sleepCount": med("sleepCount"),
        "upstreamStatus": last["upstreamStatus"], "submitted": med("submitted"), "started": med("started"),
        "coalesced": med("coalesced"), "busy": med("busy"), "queueDepthPeak": max(r["queueDepthPeak"] for r in reps),
        "finalJob": last["finalJob"], "complete": last["complete"],
    }


def local_read(env, metric, days, repeats=30):
    window = window_for(days)
    conn = env.conn()
    try:
        table = "pipeline_runs" if metric == "pipelines" else "work_items_window"
        total = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        samples, counts = [], {}
        for _ in range(repeats):
            started = time.perf_counter()
            counts = activity_service.daily_counts(conn, metric, PROJECTS, window)
            samples.append(ms(time.perf_counter() - started))
        keys, cov = env.ledger(metric, days)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        cls = []
        for _ in range(repeats):
            started = time.perf_counter()
            activity_service.classify_days(window, cov, counts, now, None)
            cls.append(ms(time.perf_counter() - started))
    finally:
        conn.close()
    return {"tableRows": total, "daysWithRows": len(counts), "dailyCountsMs": summarize(samples), "classifyDaysMs": summarize(cls)}


def scenario(name, days, runs, mode="ok", latency=BASE_LATENCY, retry_after=None, prep="empty", reps=5,
             max_pending=64, repeats=30, metric=MAIN_METRIC):
    upstream_cfg = dict(projects=PROJECTS, runs_per_month=runs, latency=latency, mode=mode, retry_after=retry_after)
    if prep == "warm":
        # prep with a healthy upstream, then measure repeated refresh calls (no chunk is stale or missing)
        with Env(FakeUpstream(**{**upstream_cfg, "mode": "ok"}), max_pending=max_pending) as env:
            prep_warm(env, metric, days)
            client = api_app.app.test_client()
            refresh, cache = [], []
            for _ in range(repeats):
                response, s = call(client, query(metric, days, "refresh"))
                assert response.status_code == 200
                refresh.append(ms(s))
            for _ in range(repeats):
                _r, s = call(client, query(metric, days, "cache"))
                cache.append(ms(s))
            chunks, hits, misses = env.hits_misses(metric, days)
            snap = env.runner.snapshot()
            return {"scenario": name, "windowDays": days, "runsPerMonthPerProject": runs, "latencyMs": ms(latency),
                    "kind": SYNTHETIC, "metric": metric, "chunks": chunks, "cacheHits": hits, "cacheMisses": misses,
                    "refreshCallMs": summarize(refresh), "cacheCallMs": summarize(cache),
                    "upstreamRequests": env.upstream.counters["requests"], "submitted": snap["counters"].get("submitted", 0),
                    "queueDepthPeak": snap["queueDepthPeak"], "busy": snap["counters"].get("busy", 0),
                    "localRead": local_read(env, metric, days)}
    results = []
    for _ in range(reps):
        with Env(FakeUpstream(**{**upstream_cfg, "mode": "ok" if prep == "partial" else mode}), max_pending=max_pending) as env:
            if prep == "partial":
                prep_warm(env, metric, days)
                mark_every_third_partial(env, metric, days)
                env.upstream.mode = "ok"
            results.append(one_rep(env, metric, days))
            local = local_read(env, metric, days, repeats=10)
    out = aggregate_reps(results)
    out.update({"scenario": name, "metric": metric, "windowDays": days, "runsPerMonthPerProject": runs, "latencyMs": ms(latency),
                "kind": SYNTHETIC, "localRead": local})
    return out


def concurrency(days, threads=8, runs=BASE_RUNS, latency=0.02, metric=MAIN_METRIC):
    with Env(FakeUpstream(projects=PROJECTS, runs_per_month=runs, latency=latency)) as env:
        chunks, _, _ = env.hits_misses(metric, days)
        barrier = threading.Barrier(threads)
        times, statuses = [], []
        guard = threading.Lock()

        def worker():
            client = api_app.app.test_client()
            barrier.wait()
            response, s = call(client, query(metric, days, "refresh"))
            with guard:
                times.append(ms(s))
                statuses.append(response.status_code)

        started = time.perf_counter()
        pool = [threading.Thread(target=worker) for _ in range(threads)]
        for t in pool:
            t.start()
        for t in pool:
            t.join()
        body = run_until_done(api_app.app.test_client(), metric, days)
        wall = time.perf_counter() - started
        snap = env.runner.snapshot()
        builds = env.upstream.counters["builds"] + env.upstream.counters["wiql"]
        return {"scenario": "concurrent-identical", "metric": metric, "kind": SYNTHETIC, "windowDays": days, "threads": threads,
                "chunks": chunks, "statuses": sorted(set(statuses)), "apiMs": summarize(times), "wallMs": ms(wall),
                "submitted": snap["counters"].get("submitted", 0), "started": snap["counters"].get("started", 0),
                "coalesced": snap["counters"].get("coalesced", 0), "maxStartsPerChunk": snap["maxStartsPerChunk"],
                "oneSubmissionPerChunk": snap["maxStartsPerChunk"] == 1 and snap["counters"].get("started", 0) == chunks,
                "upstreamListCalls": builds, "listCallsPerChunk": round(builds / max(1, chunks), 2),
                "upstreamRequests": env.upstream.counters["requests"],
                "queueDepthPeak": snap["queueDepthPeak"], "finalState": body["job"]["state"]}


def retry_behaviour():
    """Work item chunks go through AzureClient (the only client with Retry-After handling)."""
    metric, days = "workitems-completed", 30
    cases = [
        ("retry-after-0-then-ok", dict(mode="429", retry_after=0, fail_first=2)),
        ("retry-after-0-always", dict(mode="429", retry_after=0)),
        ("retry-after-90", dict(mode="429", retry_after=90)),
    ]
    out = []
    for name, cfg in cases:
        sleeps = []
        upstream = FakeUpstream(projects=PROJECTS, runs_per_month=BASE_RUNS, latency=BASE_LATENCY, **cfg)
        with Env(upstream, sleep_log=sleeps) as env:
            chunks, _, _ = env.hits_misses(metric, days)
            client = api_app.app.test_client()
            started = time.perf_counter()
            response, api_s = call(client, query(metric, days, "refresh"))
            body = run_until_done(client, metric, days)
            job_s = time.perf_counter() - started
            stats = {k: sum(c.stats[k] for c in env.client_cls.instances) for k in ("requests", "retries", "throttled")}
            out.append({"scenario": name, "kind": SYNTHETIC, "windowDays": days, "chunks": chunks,
                        "apiMs": ms(api_s), "jobMs": ms(job_s), "upstreamWiqlCalls": upstream.counters["wiql"],
                        "upstream429": upstream.counters["status_429"], "clientRequests": stats["requests"],
                        "clientRetries": stats["retries"], "sleepCount": len(sleeps), "sleepValues": sorted(set(sleeps)),
                        "finalJob": {k: body["job"][k] for k in ("state", "completed", "partial", "failed", "deferred", "pending")},
                        "retryAfterSeconds": body["job"].get("retryAfterSeconds")})
    return out


def run(quick=False):
    reps = 2 if quick else 5
    repeats = 10 if quick else 30
    windows = (7, 90, 1096) if quick else WINDOWS
    results = {"scenarios": [], "concurrency": [], "retry": [], "meta": {
        "label": "SYNTHETIC BENCHMARK: fake upstream, generated data, temporary SQLite; not an Azure DevOps or production measurement",
        "python": platform.python_version(), "sqlite": sqlite3.sqlite_version, "cpuCount": os.cpu_count(),
        "platform": platform.platform(), "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "projects": len(PROJECTS), "baseRunsPerMonthPerProject": BASE_RUNS, "highRunsPerMonthPerProject": HIGH_RUNS,
        "fakeUpstreamLatencyMs": ms(BASE_LATENCY), "runnerWorkers": 2, "runnerMaxPending": 64, "reps": reps,
        "warmRepeats": repeats, "maxChunks": activity_chunks.MAX_CHUNKS,
        "queryMaxSpanDays": date_window.QUERY_MAX_SPAN_DAYS, "queryMaxAgeDays": date_window.QUERY_MAX_AGE_DAYS}}
    plan = []
    for d in windows:
        plan += [
            ("cold", d, dict(runs=BASE_RUNS, reps=reps)),
            ("warm", d, dict(runs=BASE_RUNS, prep="warm", repeats=repeats)),
            ("partial-every-3rd", d, dict(runs=BASE_RUNS, prep="partial", reps=reps)),
            ("429-storm", d, dict(runs=BASE_RUNS, mode="429", retry_after=0, reps=reps)),
            ("5xx", d, dict(runs=BASE_RUNS, mode="5xx", reps=reps)),
            ("timeout", d, dict(runs=BASE_RUNS, mode="timeout", reps=reps)),
            ("cold-high-volume", d, dict(runs=HIGH_RUNS, reps=reps)),
            ("warm-high-volume", d, dict(runs=HIGH_RUNS, prep="warm", repeats=repeats)),
        ]
    plan += [("pipelines-cold", d, dict(runs=BASE_RUNS, reps=reps, metric="pipelines")) for d in windows]
    plan += [("pipelines-warm", d, dict(runs=BASE_RUNS, prep="warm", repeats=repeats, metric="pipelines")) for d in windows]
    plan += [("cold-latency-50ms", d, dict(runs=BASE_RUNS, latency=0.05, reps=reps)) for d in (365, 1096) if d in windows]
    plan += [("cold-pending-limit-16", d, dict(runs=BASE_RUNS, max_pending=16, reps=reps)) for d in (1096,) if d in windows]
    for name, d, kw in plan:
        print(f"[bench] {name} window={d}d", flush=True)
        results["scenarios"].append(scenario(name, d, **kw))
    for d in ([90, 1096] if not quick else [90]):
        print(f"[bench] concurrency window={d}d", flush=True)
        results["concurrency"].append(concurrency(d))
    print("[bench] retry behaviour", flush=True)
    results["retry"] = retry_behaviour()
    return results


def fmt(summary):
    return "-" if not summary else f"{summary['p50']} / {summary['p95']}"


def markdown(results):
    m = results["meta"]
    lines = ["# Activity benchmark summary (SYNTHETIC)", "", m["label"], "",
             f"Python {m['python']}, SQLite {m['sqlite']}, {m['cpuCount']} CPUs, generated {m['generatedAt']}. "
             f"{m['projects']} synthetic projects, runner {m['runnerWorkers']} workers / {m['runnerMaxPending']} pending, "
             f"fake upstream latency {m['fakeUpstreamLatencyMs']} ms per call.", "",
             "## Scenarios (times in ms, p50 / p95)", "",
             "| scenario | metric | days | runs/mo/proj | chunks | hits | misses | API call | job to done | upstream req | started | coalesced | busy | queue peak | recorded backoff s | final job |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in results["scenarios"]:
        if "refreshCallMs" in s:
            lines.append(f"| {s['scenario']} (refresh) | {s['metric']} | {s['windowDays']} | {s['runsPerMonthPerProject']} | {s['chunks']} | {s['cacheHits']} | "
                         f"{s['cacheMisses']} | {fmt(s['refreshCallMs'])} | - | {s['upstreamRequests']} | {s['submitted']} submitted | 0 | {s['busy']} | {s['queueDepthPeak']} | - | n/a |")
            lines.append(f"| {s['scenario']} (cache) | {s['metric']} | {s['windowDays']} | {s['runsPerMonthPerProject']} | {s['chunks']} | - | - | {fmt(s['cacheCallMs'])} | - | 0 | 0 | 0 | 0 | 0 | - | n/a |")
        else:
            lines.append(f"| {s['scenario']} | {s['metric']} | {s['windowDays']} | {s['runsPerMonthPerProject']} | {s['chunks']} | {s['cacheHits']} | {s['cacheMisses']} | "
                         f"{fmt(s['apiMs'])} | {fmt(s['jobMs'])} | {s['upstreamRequests']} | {s['started']} | {s['coalesced']} | {s['busy']} | "
                         f"{s['queueDepthPeak']} | {s['recordedSleepSeconds']} | {s['finalJob']['state']} |")
    lines += ["", "## Local SQLite window read (daily_counts / classify_days, ms p50 / p95)", "",
              "| scenario | metric | days | table rows | days with rows | daily_counts | classify_days |", "|---|---|---|---|---|---|---|"]
    for s in results["scenarios"]:
        if s["scenario"] in ("warm", "warm-high-volume"):
            r = s["localRead"]
            lines.append(f"| {s['scenario']} | {s['metric']} | {s['windowDays']} | {r['tableRows']} | {r['daysWithRows']} | {fmt(r['dailyCountsMs'])} | {fmt(r['classifyDaysMs'])} |")
    lines += ["", "## Concurrency: identical requests", "",
              "| days | threads | chunks | submitted | started | coalesced | max starts per chunk | one submission per chunk | upstream list calls (WIQL) | per chunk | API call p50 / p95 | wall ms |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for c in results["concurrency"]:
        lines.append(f"| {c['windowDays']} | {c['threads']} | {c['chunks']} | {c['submitted']} | {c['started']} | {c['coalesced']} | {c['maxStartsPerChunk']} | "
                     f"{c['oneSubmissionPerChunk']} | {c['upstreamListCalls']} | {c['listCallsPerChunk']} | {fmt(c['apiMs'])} | {c['wallMs']} |")
    lines += ["", "## Retry behaviour (work item chunks through AzureClient, sleeps recorded not slept)", "",
              "| case | chunks | WIQL calls | 429s | client requests | retries | sleeps | sleep values (s) | final job | retryAfterSeconds |", "|---|---|---|---|---|---|---|---|---|---|"]
    for r in results["retry"]:
        lines.append(f"| {r['scenario']} | {r['chunks']} | {r['upstreamWiqlCalls']} | {r['upstream429']} | {r['clientRequests']} | {r['clientRetries']} | "
                     f"{r['sleepCount']} | {r['sleepValues']} | {r['finalJob']['state']} | {r['retryAfterSeconds']} |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--quick", action="store_true", help="fewer windows and repetitions (smoke run)")
    default_out = Path(__file__).resolve().parents[3] / ".local" / "advanced-date-range-picker" / "bench"
    parser.add_argument("--out", default=str(default_out), help="output directory for results.json and summary.md")
    args = parser.parse_args(argv)
    results = run(quick=args.quick)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(results, indent=2, sort_keys=True), encoding="utf-8")
    (out / "summary.md").write_text(markdown(results), encoding="utf-8")
    print(f"[bench] wrote {out / 'results.json'} and {out / 'summary.md'} (synthetic data only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
