"""Per-day activity counts and day classification for the heatmap and timeline.

Counts come from the local source tables. A count is shown only for days the
coverage ledger proves were fetched. A day with no rows is never reported as
zero activity unless its chunk is covered.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import coverage_ledger as cl
from date_window import DateWindow

# Fixed table/column names. Only these are interpolated into SQL.
# Pull requests have two separate metrics: created (creation_date) and closed (closed_date, status completed only).
METRICS: Dict[str, Tuple[str, str, str]] = {
    "pipelines": ("pipeline_runs", "queue_time", "project"),
    "deployments": ("deployment_records", "started_on", "project"),
    "commits": ("team_commits", "date", "project"),
    "pull-requests-created": ("pull_requests", "creation_date", "project"),
    "pull-requests-closed": ("pull_requests", "closed_date", "project"),
    # Windowed work items live in their own table; the active work_items cache is never counted here.
    "workitems-completed": ("work_items_window", "closed_date", "project"),
    "workitems-created": ("work_items_window", "created_date", "project"),
}

# Fixed, whitelisted extra WHERE conditions (never built from input).
EXTRA_WHERE: Dict[str, str] = {
    "pull-requests-closed": "status = 'completed'",
    "workitems-completed": "kind = 'completed'",
    "workitems-created": "kind = 'created'",
}

COVERED_ZERO = "covered_zero"
COVERED_ACTIVE = "covered_active"
PARTIAL = "partial"
NOT_COLLECTED = "not_collected"
UNAVAILABLE_RETENTION = "unavailable_retention"


def daily_counts(conn: sqlite3.Connection, metric: str, projects: Sequence[str], window: DateWindow) -> Dict[str, int]:
    """Rows per UTC day for one metric, restricted to the given project set."""
    if metric not in METRICS:
        raise ValueError(f"unknown metric: {metric}")
    projects = [p for p in projects if p]
    if not projects:
        return {}
    table, day_column, project_column = METRICS[metric]
    extra = f" AND {EXTRA_WHERE[metric]}" if metric in EXTRA_WHERE else ""
    placeholders = ",".join("?" for _ in projects)
    first = window.start.strftime("%Y-%m-%d")
    last = (window.end - timedelta(days=1)).strftime("%Y-%m-%d")
    rows = conn.execute(
        f"""SELECT substr({day_column}, 1, 10) AS day, COUNT(*) AS n
            FROM {table}
            WHERE {project_column} IN ({placeholders}){extra}
              AND substr({day_column}, 1, 10) >= ? AND substr({day_column}, 1, 10) <= ?
            GROUP BY day""",
        (*projects, first, last),
    ).fetchall()
    return {row[0]: int(row[1]) for row in rows if row[0]}


def _month_key(day: datetime) -> str:
    return day.strftime("%Y-%m-01")


def classify_days(
    window: DateWindow,
    chunk_coverage: Mapping[str, Mapping[str, str]],
    counts: Mapping[str, int],
    now: datetime,
    retention_days: Optional[int],
) -> List[dict]:
    """One entry per UTC day in the window, ascending.

    ``chunk_coverage`` maps a chunk key (first day of month) to its ledger row
    (``coverage``, ``fetchedAt``, ``chunkEnd``).
    """
    today = now.date()
    retention_floor = None if retention_days is None else today - timedelta(days=retention_days)
    days: List[dict] = []
    for offset in range(window.days):
        day = window.start + timedelta(days=offset)
        key = day.strftime("%Y-%m-%d")
        count = counts.get(key)
        row = chunk_coverage.get(_month_key(day))
        # A row only covers days up to the end that was actually fetched; later days of the same month are unknown.
        if row is not None and key > row["chunkEnd"]:
            row = None
        stale = False
        if row is not None:
            stale = cl.freshness(row["fetchedAt"], row["chunkEnd"], now=now) == cl.STALE
        too_old = retention_floor is not None and day.date() < retention_floor

        if row is not None and row["coverage"] == cl.COVERAGE_COMPLETE:
            state = COVERED_ACTIVE if (count or 0) > 0 else COVERED_ZERO
            value = count or 0
        elif row is not None and row["coverage"] == cl.COVERAGE_PARTIAL:
            state = PARTIAL
            value = count
        elif too_old:
            state = UNAVAILABLE_RETENTION
            value = None
        else:
            state = NOT_COLLECTED
            value = None
        days.append({"date": key, "count": value, "state": state, "stale": stale})
    return days


__all__ = [
    "METRICS",
    "COVERED_ZERO",
    "COVERED_ACTIVE",
    "PARTIAL",
    "NOT_COLLECTED",
    "UNAVAILABLE_RETENTION",
    "daily_counts",
    "classify_days",
]
