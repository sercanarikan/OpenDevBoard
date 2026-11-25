"""Coverage ledger for chunked activity fetches.

Coverage answers "was this source fully fetched for this scope and month?".
Freshness answers "how old is that fetch?". They are stored and decided
separately:

* ``coverage`` is written only by a fetch attempt. ``complete`` means the whole
  chunk was fetched. ``partial`` means some pages or projects were missing.
* ``freshness`` is derived at read time from ``fetched_at`` and a TTL.

A failed or partial refresh never downgrades an existing ``complete`` row. It
is recorded as an attempt only.

Scope isolation: every row is keyed by a scope hash built from the organization
URL, the sorted project set and, for user-specific sources, a hashed actor id.
Raw identities and tokens are never stored.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, Optional

COVERAGE_COMPLETE = "complete"
COVERAGE_PARTIAL = "partial"
ATTEMPT_FAILED = "failed"

FRESH = "fresh"
STALE = "stale"

TTL_CURRENT_CHUNK = timedelta(minutes=15)  # chunk contains today (UTC)
TTL_CLOSED_CHUNK = timedelta(days=7)  # chunk ended before today (UTC)


def scope_key(org_url: str, projects: Iterable[str], actor_id: Optional[str] = None) -> str:
    """Hash of the data scope. Different project sets or actors never share coverage."""
    payload = {
        "org": (org_url or "").rstrip("/").lower(),
        "projects": sorted({p for p in projects if p}),
        "actor": hashlib.sha256(actor_id.encode("utf-8")).hexdigest() if actor_id else None,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def init_coverage_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS coverage_chunks (
            scope_key TEXT NOT NULL,
            source TEXT NOT NULL,
            chunk_start TEXT NOT NULL,
            chunk_end TEXT NOT NULL,
            coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial')),
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (scope_key, source, chunk_start)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS coverage_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_key TEXT NOT NULL,
            source TEXT NOT NULL,
            chunk_start TEXT NOT NULL,
            attempted_at TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed')),
            error_code TEXT
        )"""
    )
    conn.commit()


def _utc_iso(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).replace(tzinfo=None).isoformat(timespec="seconds") + "Z"


def promote_chunk(
    conn: sqlite3.Connection,
    scope: str,
    source: str,
    chunk_start: str,
    chunk_end: str,
    complete: bool,
    fetched_at: Optional[str] = None,
) -> str:
    """Record the outcome of one chunk fetch and return the coverage now stored.

    Rules:
    * ``complete=True`` stores ``complete`` (replacing anything).
    * ``complete=False`` stores ``partial`` only when no row exists or the row is
      already ``partial``. An existing ``complete`` row is kept.
    """
    fetched_at = fetched_at or _utc_iso()
    outcome = COVERAGE_COMPLETE if complete else COVERAGE_PARTIAL
    conn.commit()  # BEGIN IMMEDIATE fails inside an open transaction
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT coverage FROM coverage_chunks WHERE scope_key = ? AND source = ? AND chunk_start = ?",
            (scope, source, chunk_start),
        ).fetchone()
        existing = row[0] if row is not None else None
        if complete or existing in (None, COVERAGE_PARTIAL):
            conn.execute(
                """INSERT INTO coverage_chunks (scope_key, source, chunk_start, chunk_end, coverage, fetched_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(scope_key, source, chunk_start) DO UPDATE SET
                     chunk_end = excluded.chunk_end, coverage = excluded.coverage, fetched_at = excluded.fetched_at""",
                (scope, source, chunk_start, chunk_end, outcome, fetched_at),
            )
            stored = outcome
        else:
            stored = existing
        conn.execute(
            "INSERT INTO coverage_attempts (scope_key, source, chunk_start, attempted_at, outcome, error_code) VALUES (?, ?, ?, ?, ?, NULL)",
            (scope, source, chunk_start, fetched_at, outcome),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return stored


def record_failed_attempt(
    conn: sqlite3.Connection,
    scope: str,
    source: str,
    chunk_start: str,
    error_code: str,
    attempted_at: Optional[str] = None,
) -> None:
    """Log a failed fetch. Coverage rows are not touched."""
    conn.execute(
        "INSERT INTO coverage_attempts (scope_key, source, chunk_start, attempted_at, outcome, error_code) VALUES (?, ?, ?, ?, ?, ?)",
        (scope, source, chunk_start, attempted_at or _utc_iso(), ATTEMPT_FAILED, error_code[:64]),
    )
    conn.commit()


def read_coverage(
    conn: sqlite3.Connection, scope: str, source: str, chunk_starts: Iterable[str]
) -> Dict[str, Dict[str, str]]:
    keys = list(chunk_starts)
    if not keys:
        return {}
    placeholders = ",".join("?" for _ in keys)
    rows = conn.execute(
        f"""SELECT chunk_start, chunk_end, coverage, fetched_at FROM coverage_chunks
            WHERE scope_key = ? AND source = ? AND chunk_start IN ({placeholders})""",
        (scope, source, *keys),
    ).fetchall()
    return {
        row[0]: {"chunkEnd": row[1], "coverage": row[2], "fetchedAt": row[3]}
        for row in rows
    }


def freshness(fetched_at: str, chunk_end: str, now: Optional[datetime] = None) -> str:
    """``stale`` once the fetch is older than the TTL for its chunk."""
    now = (now or datetime.now(timezone.utc)).replace(tzinfo=None)
    fetched = datetime.fromisoformat(fetched_at.rstrip("Z"))
    today = now.strftime("%Y-%m-%d")
    ttl = TTL_CURRENT_CHUNK if chunk_end >= today else TTL_CLOSED_CHUNK
    return STALE if now - fetched > ttl else FRESH
