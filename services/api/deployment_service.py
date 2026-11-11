"""Deployment Metrics service for DevOpsFlow.

Provides read-only aggregation of deployment records, environment distribution,
SQLite caching, and deterministic offline fixture support.
"""

import json
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
import requests

import sync_service

logger = logging.getLogger("deployment_service")

CACHE_TTL_SECONDS = 300  # 5 minutes
DEPLOYMENT_PAGE_SIZE = 50
DEPLOYMENT_MAX_PAGES = 20


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def init_deployment_db():
    """Initializes the deployment_records cache table in SQLite."""
    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS deployment_records (
                id INTEGER NOT NULL,
                project TEXT NOT NULL,
                release_id INTEGER,
                release_name TEXT NOT NULL,
                definition_id INTEGER,
                definition_name TEXT NOT NULL,
                environment_id INTEGER,
                environment_name TEXT NOT NULL,
                status TEXT NOT NULL,
                attempt INTEGER DEFAULT 1,
                started_on TEXT,
                completed_on TEXT,
                duration_seconds INTEGER,
                requested_by TEXT,
                url TEXT,
                last_synced_at TEXT,
                PRIMARY KEY (id, project)
            )
        ''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS deployment_cache_state (
            id INTEGER PRIMARY KEY CHECK (id = 1), requested_days INTEGER NOT NULL,
            attempted_at TEXT NOT NULL, completed_at TEXT,
            outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed')),
            successful_projects TEXT NOT NULL DEFAULT '[]')''')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_dep_scope ON deployment_records(project, environment_name, status, completed_on)')
        conn.commit()


try:
    init_deployment_db()
except Exception as e:
    logger.warning("Could not initialize deployment db: %s", e)


def parse_azure_deployment(raw: Dict[str, Any], org_name: str, project_name: str) -> Dict[str, Any]:
    """Converts a raw VSRM deployment record into normalized deployment dictionary."""
    dep_id = raw.get("id")
    release = raw.get("release") or {}
    release_id = release.get("id")
    release_name = release.get("name") or "Release"

    definition = raw.get("releaseDefinition") or {}
    def_id = definition.get("id")
    def_name = definition.get("name") or "Release Pipeline"

    environment = raw.get("releaseEnvironment") or {}
    env_id = environment.get("id")
    env_name = (environment.get("name") or "Production").strip()

    status = (raw.get("deploymentStatus") or "succeeded").lower()
    attempt = int(raw.get("attempt") or 1)

    started_on = raw.get("startedOn") or ""
    completed_on = raw.get("completedOn") or started_on

    duration_seconds = 0
    if started_on and completed_on:
        try:
            st = datetime.fromisoformat(started_on.replace("Z", "+00:00"))
            ct = datetime.fromisoformat(completed_on.replace("Z", "+00:00"))
            duration_seconds = max(0, int((ct - st).total_seconds()))
        except Exception:
            pass

    requested_by = raw.get("requestedBy", {}).get("displayName") or "Automated"

    web_url = f"https://dev.azure.com/{org_name}/{project_name}/_releaseProgress?releaseId={release_id}"

    return {
        "id": dep_id,
        "project": project_name,
        "releaseId": release_id,
        "releaseName": release_name,
        "definitionId": def_id,
        "definitionName": def_name,
        "environmentId": env_id,
        "environmentName": env_name,
        "status": status,
        "attempt": attempt,
        "startedOn": started_on,
        "completedOn": completed_on,
        "durationSeconds": duration_seconds,
        "requestedBy": requested_by,
        "url": web_url
    }


# -----------------------------------------------------------------------------
# Deterministic Offline Fixture Deployments
# -----------------------------------------------------------------------------

def build_fixture_deployments() -> List[Dict[str, Any]]:
    """Generates 20 deterministic deployment records across Alpha, Beta, Gamma."""
    base = datetime(2026, 11, 1, 14, 0, 0)
    deps = []

    configs = [
        # Alpha deployments
        (501, "Alpha", 101, "Release-101", 1, "Alpha.Production.CD", "Production", "succeeded", 300, "Fixture User", 5),
        (502, "Alpha", 101, "Release-101", 1, "Alpha.Production.CD", "Staging", "succeeded", 240, "Fixture User", 5),
        (503, "Alpha", 100, "Release-100", 1, "Alpha.Production.CD", "Production", "succeeded", 310, "Fixture Person A", 3),
        (504, "Alpha", 99, "Release-99", 1, "Alpha.Production.CD", "Staging", "failed", 120, "Fixture Person B", 2),
        (505, "Alpha", 98, "Release-98", 2, "Alpha.Test.CD", "Test", "succeeded", 180, "Automated", 4),
        (506, "Alpha", 97, "Release-97", 2, "Alpha.Test.CD", "Development", "succeeded", 90, "Fixture User", 1),
        (507, "Alpha", 102, "Release-102", 1, "Alpha.Production.CD", "Staging", "inProgress", 60, "Fixture User", 0),

        # Beta deployments
        (601, "Beta", 201, "Release-B12", 10, "Beta.Service.Deploy", "Production", "succeeded", 420, "Fixture Person B", 4),
        (602, "Beta", 201, "Release-B12", 10, "Beta.Service.Deploy", "Staging", "succeeded", 350, "Fixture Person B", 4),
        (603, "Beta", 200, "Release-B11", 10, "Beta.Service.Deploy", "Production", "failed", 190, "Fixture User", 2),
        (604, "Beta", 199, "Release-B10", 11, "Beta.Internal.CD", "Development", "succeeded", 110, "Automated", 5),
        (605, "Beta", 198, "Release-B09", 11, "Beta.Internal.CD", "Test", "succeeded", 160, "Fixture Person A", 3),
        (606, "Beta", 202, "Release-B13", 10, "Beta.Service.Deploy", "Staging", "inProgress", 45, "Fixture User", 0),

        # Gamma deployments
        (701, "Gamma", 301, "Release-G05", 20, "Gamma.Gateway.CD", "Production", "succeeded", 280, "Fixture User", 5),
        (702, "Gamma", 301, "Release-G05", 20, "Gamma.Gateway.CD", "Staging", "succeeded", 220, "Fixture User", 5),
        (703, "Gamma", 300, "Release-G04", 20, "Gamma.Gateway.CD", "Production", "succeeded", 290, "Fixture Person A", 3),
        (704, "Gamma", 299, "Release-G03", 20, "Gamma.Gateway.CD", "Staging", "failed", 150, "Fixture Person B", 2),
        (705, "Gamma", 298, "Release-G02", 21, "Gamma.Edge.Deploy", "Development", "succeeded", 80, "Automated", 4),
        (706, "Gamma", 297, "Release-G01", 21, "Gamma.Edge.Deploy", "Test", "succeeded", 130, "Fixture User", 1),
        (707, "Gamma", 302, "Release-G06", 20, "Gamma.Gateway.CD", "Production", "inProgress", 50, "Fixture User", 0),
    ]

    for dep_id, proj, rel_id, rel_name, def_id, def_name, env_name, st, dur, user, day_offset in configs:
        st_dt = base + timedelta(days=day_offset, hours=1)
        cm_dt = st_dt + timedelta(seconds=dur)
        deps.append({
            "id": dep_id,
            "project": proj,
            "releaseId": rel_id,
            "releaseName": rel_name,
            "definitionId": def_id,
            "definitionName": def_name,
            "environmentId": dep_id * 10,
            "environmentName": env_name,
            "status": st,
            "attempt": 1,
            "startedOn": st_dt.isoformat() + "Z",
            "completedOn": cm_dt.isoformat() + "Z" if st != "inProgress" else "",
            "durationSeconds": dur if st != "inProgress" else 0,
            "requestedBy": user,
            "url": f"https://dev.azure.com/fixture-org/{proj}/_releaseProgress?releaseId={rel_id}"
        })

    return deps


# -----------------------------------------------------------------------------
# Live Sync & SQLite Caching
# -----------------------------------------------------------------------------

def sync_live_deployments(org_url: str, org_name: str, pat: str, days: int = 30, force_refresh: bool = False, include_cache_status: bool = False):
    """Synchronizes deployment records from Azure DevOps VSRM API and caches in SQLite."""
    if sync_service.is_fixture_mode():
        return build_fixture_deployments()

    now = _utcnow()
    now_iso = now.isoformat()

    if not force_refresh:
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            cursor = conn.cursor()
            state = cursor.execute("SELECT * FROM deployment_cache_state WHERE id=1").fetchone()
            if state and state["outcome"] == "partial" and state["completed_at"]:
                try:
                    last_sync_dt = datetime.fromisoformat(state["completed_at"])
                    if state["requested_days"] == days and 0 <= (now - last_sync_dt).total_seconds() < CACHE_TTL_SECONDS:
                        cursor.execute("SELECT * FROM deployment_records WHERE started_on >= ? ORDER BY started_on DESC", ((now - timedelta(days=days)).isoformat(timespec="seconds") + "Z",))
                        cached = [_row_to_deployment_dict(r) for r in cursor.fetchall()]
                        return {"items": cached, "cacheStatus": {"outcome": "partial", "complete": False, "stale": False, "paginationBounded": True, "completenessScope": "discovered-projects/date-window", "projectDiscoveryComplete": False, "organizationSnapshotComplete": False}} if include_cache_status else cached
                except Exception:
                    pass

    headers = sync_service.get_devops_headers(pat)
    start_utc = now - timedelta(days=days)
    start_date_iso = start_utc.isoformat() + "Z"

    # Query projects from local DB to avoid extra round-trips
    projects = []
    project_scope_bounded = False
    try:
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            projects = [r["project"] for r in conn.execute(
                "SELECT DISTINCT project FROM work_items WHERE deleted_at IS NULL AND project IS NOT NULL"
            ).fetchall()]
            if len(projects) > 100:
                projects = projects[:100]
                project_scope_bounded = True
    except Exception as e:
        logger.error("Failed to load projects for deployment sync: %s", e)

    all_raw = []
    projects_fetch_ok = bool(projects) and not project_scope_bounded
    project_outcomes = {}
    request_budget = DEPLOYMENT_MAX_PAGES * max(1, min(len(projects), 100))
    requests_made = 0
    for proj in projects:
        try:
            vsrm_url = f"https://vsrm.dev.azure.com/{org_name}/{proj}/_apis/release/deployments"
            token = None
            seen_tokens = set()
            project_complete = False
            for _ in range(DEPLOYMENT_MAX_PAGES):
                if requests_made >= request_budget:
                    break
                params = {"minStartedTime": start_date_iso, "$top": DEPLOYMENT_PAGE_SIZE, "$expand": "releaseEnvironment", "api-version": "7.0"}
                if token:
                    params["continuationToken"] = token
                r = requests.get(vsrm_url, headers=headers, params=params, timeout=10)
                requests_made += 1
                if r.status_code != 200:
                    break
                for d in r.json().get('value', []):
                    all_raw.append((d, proj))
                next_token = (getattr(r, 'headers', {}) or {}).get('x-ms-continuationtoken')
                if not next_token:
                    project_complete = True
                    break
                if next_token in seen_tokens:
                    break
                seen_tokens.add(next_token)
                token = next_token
            project_outcomes[proj] = project_complete
            if not project_complete:
                projects_fetch_ok = False
        except Exception as ex:
            projects_fetch_ok = False
            project_outcomes[proj] = False
            logger.debug("Project %s deployment fetch error: %s", proj, ex)

    normalized = []
    for raw, proj in all_raw:
        try:
            normalized.append(parse_azure_deployment(raw, org_name, proj))
        except Exception as ex:
            logger.warning("Failed to parse deployment record: %s", ex)

    # Deduplicate by (id, project)
    unique_map = {}
    for d in normalized:
        unique_map[(d["id"], d["project"])] = d
    final_deps = list(unique_map.values())

    fetch_complete = bool(projects) and all(project_outcomes.get(p, False) for p in projects) and bool(all_raw)
    if project_scope_bounded:
        fetch_complete = False
    outcome = "complete" if fetch_complete else ("partial" if any(project_outcomes.values()) else "failed")
    completed_at = now_iso if fetch_complete else None
    if final_deps and (projects_fetch_ok or any(project_outcomes.values())):
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            conn.executemany('''
                INSERT OR REPLACE INTO deployment_records (
                    id, project, release_id, release_name, definition_id, definition_name,
                    environment_id, environment_name, status, attempt, started_on,
                    completed_on, duration_seconds, requested_by, url, last_synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', [(
                d["id"], d["project"], d["releaseId"], d["releaseName"], d["definitionId"],
                d["definitionName"], d["environmentId"], d["environmentName"], d["status"],
                d["attempt"], d["startedOn"], d["completedOn"], d["durationSeconds"],
                d["requestedBy"], d["url"], now_iso
            ) for d in final_deps])
            conn.commit()
    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        conn.execute('''INSERT INTO deployment_cache_state (id, requested_days, attempted_at, completed_at, outcome, successful_projects)
            VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,
            completed_at=excluded.completed_at, outcome=excluded.outcome,
            successful_projects=excluded.successful_projects''',
            (days, now_iso, completed_at, outcome, json.dumps(sorted(p for p, ok in project_outcomes.items() if ok))))
        conn.commit()

    if include_cache_status:
        return {"items": final_deps, "cacheStatus": {
            "outcome": outcome,
            "complete": fetch_complete, "stale": not any(project_outcomes.values()), "paginationBounded": not fetch_complete,
            "successfulProjects": sorted(p for p, ok in project_outcomes.items() if ok),
            "completenessScope": "discovered-projects/date-window",
            "projectDiscoveryComplete": False,
            "organizationSnapshotComplete": False,
        }}
    return final_deps


def _row_to_deployment_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "project": row["project"],
        "releaseId": row["release_id"],
        "releaseName": row["release_name"],
        "definitionId": row["definition_id"],
        "definitionName": row["definition_name"],
        "environmentId": row["environment_id"],
        "environmentName": row["environment_name"],
        "status": row["status"],
        "attempt": row["attempt"] or 1,
        "startedOn": row["started_on"] or "",
        "completedOn": row["completed_on"] or "",
        "durationSeconds": row["duration_seconds"] or 0,
        "requestedBy": row["requested_by"] or "Automated",
        "url": row["url"] or ""
    }


# -----------------------------------------------------------------------------
# Query and Metrics Calculation
# -----------------------------------------------------------------------------

def query_deployments(all_deps: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    """Filters, paginates, and computes summary metrics over deployment records."""
    project_filter = (params.get("project") or "").strip()
    env_filter = (params.get("environment") or "").strip()
    status_filter = (params.get("status") or "").strip().lower()
    search_query = (params.get("search") or "").strip().lower()

    days = max(1, int(params.get("days") or 30))
    limit = max(1, min(100, int(params.get("limit") or 25)))
    offset = max(0, int(params.get("offset") or 0))

    now_utc = _utcnow()
    min_date = now_utc - timedelta(days=days)

    filtered = []
    for d in all_deps:
        ts = d.get("startedOn") or d.get("completedOn")
        if ts:
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None)
                if dt < min_date:
                    continue
            except Exception:
                pass

        if project_filter and project_filter != "all" and d["project"].lower() != project_filter.lower():
            continue

        if env_filter and env_filter != "all" and d["environmentName"].lower() != env_filter.lower():
            continue

        if status_filter and status_filter != "all" and d["status"].lower() != status_filter:
            continue

        if search_query:
            match = (
                search_query in str(d["id"]) or
                search_query in d["releaseName"].lower() or
                search_query in d["definitionName"].lower() or
                search_query in d["environmentName"].lower() or
                search_query in d["project"].lower() or
                search_query in d["requestedBy"].lower()
            )
            if not match:
                continue

        filtered.append(d)

    filtered.sort(key=lambda d: d.get("startedOn") or d.get("completedOn") or "", reverse=True)

    summary = compute_deployment_summary(filtered, days)

    total_matching = len(filtered)
    page_items = filtered[offset:offset + limit]

    return {
        "items": page_items,
        "total": total_matching,
        "limit": limit,
        "offset": offset,
        "hasMore": (offset + len(page_items) < total_matching),
        "summary": summary,
        "supportedSources": ["Classic Release Deployments (Azure DevOps VSRM API)"],
        "dataScope": "fixture" if sync_service.is_fixture_mode() else "live_cached",
        "lastSyncedAt": _utcnow().isoformat()
    }


def compute_deployment_summary(deps: List[Dict[str, Any]], days: int = 30) -> Dict[str, Any]:
    """Computes deployment rates, environment breakdowns and daily stats."""
    total_deployments = len(deps)
    succeeded = 0
    failed = 0
    in_progress = 0

    env_map: Dict[str, Dict[str, int]] = {}
    proj_map: Dict[str, Dict[str, int]] = {}
    now_utc = _utcnow()
    daily_map = {}

    for i in range(days - 1, -1, -1):
        d_key = (now_utc - timedelta(days=i)).strftime('%Y-%m-%d')
        daily_map[d_key] = {
            "date": (now_utc - timedelta(days=i)).strftime('%d %b'),
            "succeeded": 0,
            "failed": 0,
            "total": 0
        }

    for d in deps:
        st = d.get("status", "").lower()
        env_name = d.get("environmentName") or "Other"
        proj_name = d.get("project") or "General"

        if env_name not in env_map:
            env_map[env_name] = {"succeeded": 0, "failed": 0, "inProgress": 0, "total": 0}
        env_map[env_name]["total"] += 1

        if proj_name not in proj_map:
            proj_map[proj_name] = {"succeeded": 0, "failed": 0, "inProgress": 0, "total": 0}
        proj_map[proj_name]["total"] += 1

        if st == "succeeded":
            succeeded += 1
            env_map[env_name]["succeeded"] += 1
            proj_map[proj_name]["succeeded"] += 1
        elif st == "failed":
            failed += 1
            env_map[env_name]["failed"] += 1
            proj_map[proj_name]["failed"] += 1
        elif st == "inprogress" or st == "in_progress":
            in_progress += 1
            env_map[env_name]["inProgress"] += 1
            proj_map[proj_name]["inProgress"] += 1

        started_on = d.get("startedOn") or d.get("completedOn", "")
        if started_on:
            d_key = started_on[:10]
            if d_key in daily_map:
                daily_map[d_key]["total"] += 1
                if st == "succeeded":
                    daily_map[d_key]["succeeded"] += 1
                elif st == "failed":
                    daily_map[d_key]["failed"] += 1

    completed_count = succeeded + failed
    success_rate = round((succeeded / completed_count * 100), 1) if completed_count > 0 else 100.0

    environments = [
        {
            "name": name,
            "total": stats["total"],
            "succeeded": stats["succeeded"],
            "failed": stats["failed"],
            "inProgress": stats["inProgress"],
            "successRate": round((stats["succeeded"] / (stats["succeeded"] + stats["failed"]) * 100), 1) if (stats["succeeded"] + stats["failed"]) > 0 else 100.0
        }
        for name, stats in sorted(env_map.items(), key=lambda x: x[1]["total"], reverse=True)
    ]

    projects = [
        {
            "project": name,
            "total": stats["total"],
            "succeeded": stats["succeeded"],
            "failed": stats["failed"],
            "inProgress": stats["inProgress"],
            "successRate": round((stats["succeeded"] / (stats["succeeded"] + stats["failed"]) * 100), 1) if (stats["succeeded"] + stats["failed"]) > 0 else 100.0
        }
        for name, stats in sorted(proj_map.items(), key=lambda x: x[1]["total"], reverse=True)
    ]

    return {
        "periodDays": days,
        "totalDeployments": total_deployments,
        "succeeded": succeeded,
        "failed": failed,
        "inProgress": in_progress,
        "successRate": success_rate,
        "environments": environments,
        "projects": projects,
        "dailyStats": list(daily_map.values()),
        "lastSyncedAt": _utcnow().isoformat()
    }


def get_single_deployment_details(all_deps: List[Dict[str, Any]], dep_id: int, project: Optional[str] = None) -> Optional[Dict[str, Any]]:
    for d in all_deps:
        if d["id"] == dep_id:
            if project and project != "all" and d["project"].lower() != project.lower():
                continue
            return d
    return None
