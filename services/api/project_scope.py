"""Persisted project set per organisation.

Refresh mode discovers the project list upstream and stores it here. Cache-only
requests read the stored set, so both modes compute the same coverage scope key
and cache-only requests never call Azure DevOps.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Iterable, List, Optional


def _org_key(org_url: str) -> str:
    return (org_url or "").rstrip("/").lower()


def init_project_scope_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS activity_project_sets (
            org_key TEXT PRIMARY KEY,
            projects_json TEXT NOT NULL,
            fetched_at TEXT NOT NULL
        )"""
    )
    conn.commit()


def save_project_set(conn: sqlite3.Connection, org_url: str, projects: Iterable[str], fetched_at: str) -> None:
    names = sorted({p for p in projects if p})
    conn.execute(
        """INSERT INTO activity_project_sets (org_key, projects_json, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT(org_key) DO UPDATE SET projects_json = excluded.projects_json, fetched_at = excluded.fetched_at""",
        (_org_key(org_url), json.dumps(names), fetched_at),
    )
    conn.commit()


def load_project_set(conn: sqlite3.Connection, org_url: str) -> Optional[List[str]]:
    row = conn.execute("SELECT projects_json FROM activity_project_sets WHERE org_key = ?", (_org_key(org_url),)).fetchone()
    if row is None:
        return None
    return sorted({p for p in json.loads(row[0]) if p})
