"""Bounded, coalesced background fetches for activity chunks.

A chunk fetch runs one source for one scope and one UTC month. Identical chunk
fetches already in flight are coalesced. At most ``max_workers`` fetches run at
once, and at most ``max_pending`` are queued or running across the process. When
the pending limit is reached new work is refused, not queued without bound.

Outcomes are written to the coverage ledger: a complete fetch promotes the
chunk, an incomplete one stores ``partial`` (never over ``complete``), and an
exception logs a failed attempt with an error code only. Exception text, which
can contain URLs or tokens, is never stored.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable, Dict, Optional, Tuple

import coverage_ledger as cl
from activity_chunks import chunk_key, chunk_last_day
from date_window import DateWindow
from persistence import get_db_connection

IDLE = "idle"
RUNNING = "running"
DONE = "done"
PARTIAL = "partial"
FAILED = "failed"
BUSY = "busy"
DEFERRED = "deferred"  # upstream asked for a wait longer than one minute; nothing is retried before then

ChunkFetch = Callable[[DateWindow], bool]
JobKey = Tuple[str, str, str]  # (scope, metric, chunk_key)


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z"


class ChunkJobRunner:
    def __init__(self, db_path: Optional[str] = None, max_workers: int = 2, max_pending: int = 64,
                 clock: Optional[Callable[[], float]] = None):
        self._db_path = db_path
        self._clock = clock or time.monotonic
        self._defer_until: Dict[JobKey, float] = {}
        self._defer_seconds: Dict[JobKey, float] = {}
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="activity-chunk")
        self._max_pending = max_pending
        self._lock = threading.Lock()
        self._running: Dict[JobKey, bool] = {}
        self._outcome: Dict[JobKey, str] = {}
        conn = self._connect()
        try:
            cl.init_coverage_db(conn)
        finally:
            conn.close()

    def submit(self, scope: str, metric: str, chunk: DateWindow, fetch: ChunkFetch) -> str:
        """Start a chunk fetch unless one is already in flight. Returns the key state."""
        key: JobKey = (scope, metric, chunk_key(chunk))
        with self._lock:
            if key in self._running:
                return RUNNING  # coalesced
            if self._clock() < self._defer_until.get(key, 0.0):
                return DEFERRED
            if len(self._running) >= self._max_pending:
                return BUSY
            self._running[key] = True
            self._outcome.pop(key, None)
            self._defer_until.pop(key, None)
        self._pool.submit(self._run, key, chunk, fetch)
        return RUNNING

    def status(self, scope: str, metric: str, chunk_keys) -> Dict[str, int | str]:
        counts = {"pending": 0, "completed": 0, "partial": 0, "failed": 0, "deferred": 0}
        retry_after = 0.0
        with self._lock:
            for ck in chunk_keys:
                key = (scope, metric, ck)
                if key in self._running:
                    counts["pending"] += 1
                    continue
                outcome = self._outcome.get(key)
                if outcome == DONE:
                    counts["completed"] += 1
                elif outcome == PARTIAL:
                    counts["partial"] += 1
                elif outcome == FAILED:
                    counts["failed"] += 1
                elif outcome == DEFERRED:
                    counts["deferred"] += 1
                    retry_after = max(retry_after, self._defer_seconds.get(key, 0.0))
        if counts["pending"]:
            state = RUNNING
        elif counts["deferred"] and not counts["completed"] and not counts["partial"] and not counts["failed"]:
            state = DEFERRED
        elif counts["failed"]:
            state = FAILED
        elif counts["partial"]:
            state = PARTIAL
        elif counts["completed"]:
            state = DONE
        else:
            state = IDLE
        return {"state": state, **counts, "retryAfterSeconds": retry_after}

    def _connect(self):
        return get_db_connection(self._db_path)

    def _run(self, key: JobKey, chunk: DateWindow, fetch: ChunkFetch) -> None:
        scope, metric, ck = key
        outcome = FAILED
        conn = self._connect()
        try:
            complete = bool(fetch(chunk))
            cl.promote_chunk(conn, scope, metric, ck, chunk_last_day(chunk), complete, fetched_at=_now_iso())
            outcome = DONE if complete else PARTIAL
        except Exception as error:  # noqa: BLE001 - any upstream failure is an attempt failure
            if getattr(error, "deferred", False):
                # Upstream asked for a longer wait than one minute: record the attempt, keep coverage, retry later.
                seconds = float(getattr(error, "retry_after", None) or 60.0)
                cl.record_failed_attempt(conn, scope, metric, ck, error_code="retry-after-deferred", attempted_at=_now_iso())
                outcome = DEFERRED
                with self._lock:
                    self._defer_until[key] = self._clock() + seconds
                    self._defer_seconds[key] = seconds
            else:
                cl.record_failed_attempt(conn, scope, metric, ck, error_code=type(error).__name__, attempted_at=_now_iso())
        finally:
            conn.close()
            with self._lock:
                self._running.pop(key, None)
                self._outcome[key] = outcome

    def shutdown(self, wait: bool = True) -> None:
        self._pool.shutdown(wait=wait)


def build_live_fetchers(org_url: str, org_name: str, pat: str) -> Dict[str, ChunkFetch]:
    """Chunk fetchers backed by the existing window-aware sync functions."""
    import pipeline_service
    import deployment_service
    import team_service

    def _complete(result) -> bool:
        return bool((result or {}).get("cacheStatus", {}).get("complete"))

    return {
        "pipelines": lambda chunk: _complete(
            pipeline_service.sync_live_pipeline_runs(org_url, pat, window=chunk, include_cache_status=True)
        ),
        "deployments": lambda chunk: _complete(
            deployment_service.sync_live_deployments(org_url, org_name, pat, window=chunk, include_cache_status=True)
        ),
        "commits": lambda chunk: _complete(team_service.sync_live_team_activity(org_url, pat, window=chunk)),
    }
