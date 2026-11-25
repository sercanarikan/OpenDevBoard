"""Windowed work items for calendar ranges, stored apart from the active work-item cache.

Two kinds with distinct timestamp semantics that are never merged:

* ``completed``: ``[Microsoft.VSTS.Common.ClosedDate]`` inside the window, state Closed/Completed/Done/Resolved.
* ``created``: ``[System.CreatedDate]`` inside the window, any state.

Rows live in ``work_items_window`` (primary key ``(id, kind)``). The ``work_items`` table, its scope filter and its
sync are not touched. Upstream access is read-only: one WIQL query per chunk (``AzureClient.wiql_ids``, the only POST)
and detail GETs through ``AzureClient.get_items``. ``ChangedDate`` is never used as a substitute for either date.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

import azure_client
import persistence

# Fixed names only: these values are the only things interpolated into SQL or WIQL.
KINDS: Dict[str, Dict[str, str]] = {
    "completed": {"wiql_field": "[Microsoft.VSTS.Common.ClosedDate]", "column": "closed_date", "key": "closedDate"},
    "created": {"wiql_field": "[System.CreatedDate]", "column": "created_date", "key": "createdDate"},
}
COMPLETED_STATES = ("Closed", "Completed", "Done", "Resolved")
DETAIL_FIELDS = (
    "System.Id", "System.TeamProject", "System.WorkItemType", "System.State", "System.Title", "System.AssignedTo",
    "System.CreatedDate", "Microsoft.VSTS.Common.ClosedDate", "System.ChangedDate",
)

_UPSERT_SQL = """INSERT OR REPLACE INTO work_items_window (
    id, kind, project, type, state, title, assigned_to, created_date, closed_date, changed_date, url, last_synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""


def init_window_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS work_items_window (
            id INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('completed', 'created')),
            project TEXT,
            type TEXT,
            state TEXT,
            title TEXT,
            assigned_to TEXT,
            created_date TEXT,
            closed_date TEXT,
            changed_date TEXT,
            url TEXT,
            last_synced_at TEXT,
            PRIMARY KEY (id, kind)
        )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_wiw_kind_closed ON work_items_window(kind, closed_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_wiw_kind_created ON work_items_window(kind, created_date)")


def _check_kind(kind: str) -> Dict[str, str]:
    if kind not in KINDS:
        raise ValueError(f"unknown work item window kind: {kind}")
    return KINDS[kind]


def build_where(projects: Sequence[str], window, kind: str) -> str:
    spec = _check_kind(kind)
    names = ", ".join(f"'{azure_client.quote_wiql(p)}'" for p in projects)
    field = spec["wiql_field"]
    where = (f"[System.TeamProject] IN ({names}) AND {field} >= '{window.iso_start()}' "
             f"AND {field} < '{window.iso_end()}'")
    if kind == "completed":
        states = ", ".join(f"'{s}'" for s in COMPLETED_STATES)
        where += f" AND [System.State] IN ({states})"
    return where


def _assigned(value: Any) -> str:
    if isinstance(value, dict):
        return (value.get("displayName") or "").strip()
    return str(value).strip() if value else ""


def _row(item: Dict[str, Any], kind: str, now_iso: str) -> Tuple:
    f = item.get("fields", {})
    return (int(item["id"]), kind, (f.get("System.TeamProject") or "").strip(), (f.get("System.WorkItemType") or "").strip(),
            (f.get("System.State") or "").strip(), (f.get("System.Title") or "").strip(), _assigned(f.get("System.AssignedTo")),
            f.get("System.CreatedDate"), f.get("Microsoft.VSTS.Common.ClosedDate"), f.get("System.ChangedDate"),
            item.get("url"), now_iso)


def fetch_work_items_window(org_url: str, pat: str, projects: Optional[Sequence[str]], window, kind: str,
                            client=None) -> Tuple[List[Dict[str, Any]], bool]:
    """Read-only fetch of one UTC window of work items, upserted into ``work_items_window``.

    Returns ``(rows, complete)``. ``complete`` is False when the WIQL result limit was reached (or Azure refused
    the query as too large), or a detail batch failed. Rows read are still stored. A complete fetch also removes rows
    of the same kind, in the same window and projects, that upstream no longer returns (reopened or moved items);
    nothing outside the window, of another kind or another project is deleted, and a partial fetch deletes nothing.
    """
    _check_kind(kind)
    projects = [p for p in (projects or []) if p]
    if not projects:
        return [], False  # nothing to scope the query to: never mark a chunk complete
    client = client or azure_client.AzureClient(org_url, pat)
    complete = True
    try:
        ids = client.wiql_ids(build_where(projects, window, kind))
    except azure_client.AzureError as error:
        if not getattr(error, "size_limit", False):
            raise
        return [], False
    if len(ids) >= azure_client.WIQL_RESULT_LIMIT:
        complete = False
    items: Dict[int, Dict[str, Any]] = {}
    ids = list(dict.fromkeys(ids))
    for start in range(0, len(ids), azure_client.BATCH_SIZE):
        result = client.get_items(ids[start:start + azure_client.BATCH_SIZE], expand_relations=False,
                                  fields=list(DETAIL_FIELDS))
        items.update(result.items)
        if result.failed_batches:
            complete = False
    now_iso = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z"
    rows = [_row(item, kind, now_iso) for item in items.values()]
    column = KINDS[kind]["column"]
    with persistence.db_lock, persistence.get_db_connection() as conn:
        init_window_db(conn)
        if rows:
            conn.executemany(_UPSERT_SQL, rows)
        if complete:
            keep = {r[0] for r in rows}
            placeholders = ",".join("?" for _ in projects)
            stale = conn.execute(
                f"""SELECT id FROM work_items_window WHERE kind = ? AND project IN ({placeholders})
                    AND {column} >= ? AND {column} < ?""",
                (kind, *projects, window.iso_start(), window.iso_end())).fetchall()
            drop = [(r[0], kind) for r in stale if r[0] not in keep]
            if drop:
                conn.executemany("DELETE FROM work_items_window WHERE id = ? AND kind = ?", drop)
        conn.commit()
    return [_to_dict(r) for r in rows], complete


def _to_dict(row: Tuple) -> Dict[str, Any]:
    return {"id": row[0], "kind": row[1], "project": row[2], "type": row[3], "state": row[4], "title": row[5],
            "assignedTo": row[6], "createdDate": row[7], "closedDate": row[8], "changedDate": row[9], "url": row[10]}


def load_local_work_items_window(conn: sqlite3.Connection, projects: Sequence[str], window, kind: str) -> List[Dict[str, Any]]:
    """Cache-only read from ``work_items_window`` (never ``work_items``, never upstream)."""
    spec = _check_kind(kind)
    projects = [p for p in projects if p]
    if not projects:
        return []
    column = spec["column"]
    placeholders = ",".join("?" for _ in projects)
    first = window.start.strftime("%Y-%m-%d")
    last = (window.end - timedelta(days=1)).strftime("%Y-%m-%d")
    init_window_db(conn)
    rows = conn.execute(
        f"""SELECT id, kind, project, type, state, title, assigned_to, created_date, closed_date, changed_date, url
            FROM work_items_window
            WHERE kind = ? AND project IN ({placeholders})
              AND substr({column}, 1, 10) >= ? AND substr({column}, 1, 10) <= ?
            ORDER BY {column} DESC, id""",
        (kind, *projects, first, last)).fetchall()
    out = []
    for r in rows:
        d = _to_dict(tuple(r))
        if window.contains(_parse_utc(d[spec["key"]])):
            out.append(d)
    return out


def _parse_utc(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt
