"""Pipeline Health service for DevOpsFlow.

Provides read-only aggregation, status vs result classification, YAML and Classic
pipeline differentiation, SQLite caching, and deterministic offline fixture support.
"""

import json
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
import requests

import sync_service

logger = logging.getLogger("pipeline_service")

CACHE_TTL_SECONDS = 300  # 5 minutes
BUILD_PAGE_SIZE = 250
BUILD_MAX_PAGES = 25


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def init_pipeline_db():
    """Initializes the pipeline_runs cache table in SQLite."""
    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS pipeline_runs (
                id INTEGER NOT NULL,
                project TEXT NOT NULL,
                pipeline_id INTEGER,
                pipeline_name TEXT NOT NULL,
                pipeline_type TEXT NOT NULL DEFAULT 'yaml',
                build_number TEXT,
                status TEXT NOT NULL,
                result TEXT,
                source_branch TEXT,
                source_version TEXT,
                requested_by TEXT,
                queue_time TEXT,
                start_time TEXT,
                finish_time TEXT,
                duration_seconds INTEGER,
                url TEXT,
                last_synced_at TEXT,
                PRIMARY KEY (id, project)
            )
        ''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS pipeline_cache_state (
            id INTEGER PRIMARY KEY CHECK (id = 1), requested_days INTEGER NOT NULL,
            attempted_at TEXT NOT NULL, completed_at TEXT,
            outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed')),
            successful_projects TEXT NOT NULL DEFAULT '[]')''')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_pipe_scope ON pipeline_runs(project, status, result, finish_time)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_pipe_name ON pipeline_runs(pipeline_name)')
        conn.commit()


try:
    init_pipeline_db()
except Exception as e:
    logger.warning("Could not initialize pipeline db: %s", e)


def parse_azure_build(raw: Dict[str, Any], org_url: str) -> Dict[str, Any]:
    """Converts an Azure DevOps Build/Run record into normalized pipeline run dictionary."""
    build_id = raw.get("id")
    project = (raw.get("project", {}).get("name") or "General").strip()

    definition = raw.get("definition") or {}
    pipe_id = definition.get("id")
    pipe_name = (definition.get("name") or "Unknown Pipeline").strip()
    pipe_type = (definition.get("type") or "yaml").lower()

    build_number = raw.get("buildNumber") or str(build_id)
    status = (raw.get("status") or "completed").strip()
    result = raw.get("result")
    if result:
        result = result.strip()

    source_branch = (raw.get("sourceBranch") or "").replace("refs/heads/", "")
    source_version = raw.get("sourceVersion") or ""

    requested_by = raw.get("requestedFor", {}).get("displayName") or "Automated"

    queue_time = raw.get("queueTime") or ""
    start_time = raw.get("startTime") or ""
    finish_time = raw.get("finishTime") or queue_time

    duration_seconds = 0
    if start_time and finish_time:
        try:
            st = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
            ft = datetime.fromisoformat(finish_time.replace("Z", "+00:00"))
            duration_seconds = max(0, int((ft - st).total_seconds()))
        except Exception:
            pass

    web_url = raw.get("_links", {}).get("web", {}).get("href")
    if not web_url:
        web_url = f"{org_url.rstrip('/')}/{project}/_build/results?buildId={build_id}"

    return {
        "id": build_id,
        "project": project,
        "pipelineId": pipe_id,
        "pipelineName": pipe_name,
        "pipelineType": pipe_type,
        "buildNumber": build_number,
        "status": status,
        "result": result,
        "sourceBranch": source_branch,
        "sourceVersion": source_version,
        "requestedBy": requested_by,
        "queueTime": queue_time,
        "startTime": start_time,
        "finishTime": finish_time,
        "durationSeconds": duration_seconds,
        "url": web_url
    }


# -----------------------------------------------------------------------------
# Deterministic Offline Fixture Pipeline Data
# -----------------------------------------------------------------------------

def build_fixture_pipelines() -> List[Dict[str, Any]]:
    """Generates 20 deterministic pipeline runs across Alpha, Beta, Gamma."""
    base = datetime(2026, 11, 1, 12, 0, 0)
    runs = []

    configs = [
        # Alpha pipelines
        (101, "Alpha", 1, "Alpha.CI.Build", "yaml", "main", "succeeded", "completed", 120, "Fixture Person A", 5),
        (102, "Alpha", 1, "Alpha.CI.Build", "yaml", "feature/auth", "succeeded", "completed", 115, "Fixture User", 4),
        (103, "Alpha", 1, "Alpha.CI.Build", "yaml", "fix/event-loop", "failed", "completed", 45, "Fixture Person B", 3),
        (104, "Alpha", 2, "Alpha.Web.Test", "yaml", "main", "succeeded", "completed", 340, "Automated", 5),
        (105, "Alpha", 2, "Alpha.Web.Test", "yaml", "develop", "failed", "completed", 210, "Fixture User", 2),
        (106, "Alpha", 3, "Alpha.Release.Classic", "classic", "main", "succeeded", "completed", 420, "Fixture User", 4),
        (107, "Alpha", 1, "Alpha.CI.Build", "yaml", "main", None, "inProgress", 60, "Fixture Person A", 0),

        # Beta pipelines
        (201, "Beta", 10, "Beta.Core.Service", "yaml", "main", "succeeded", "completed", 180, "Fixture Person B", 5),
        (202, "Beta", 10, "Beta.Core.Service", "yaml", "feature/sync", "succeeded", "completed", 190, "Fixture User", 3),
        (203, "Beta", 10, "Beta.Core.Service", "yaml", "main", "failed", "completed", 85, "Fixture Person A", 1),
        (204, "Beta", 11, "Beta.Integration.Tests", "yaml", "main", "succeeded", "completed", 510, "Automated", 4),
        (205, "Beta", 11, "Beta.Integration.Tests", "yaml", "develop", "partiallySucceeded", "completed", 490, "Fixture User", 2),
        (206, "Beta", 12, "Beta.Nightly.Scan", "classic", "main", "succeeded", "completed", 820, "Automated", 3),
        (207, "Beta", 10, "Beta.Core.Service", "yaml", "feature/batch", None, "inProgress", 75, "Fixture User", 0),

        # Gamma pipelines
        (301, "Gamma", 20, "Gamma.Api.Pipeline", "yaml", "main", "succeeded", "completed", 140, "Fixture User", 5),
        (302, "Gamma", 20, "Gamma.Api.Pipeline", "yaml", "develop", "succeeded", "completed", 130, "Fixture Person A", 3),
        (303, "Gamma", 20, "Gamma.Api.Pipeline", "yaml", "main", "failed", "completed", 60, "Fixture Person B", 2),
        (304, "Gamma", 21, "Gamma.Worker.Deploy", "yaml", "main", "succeeded", "completed", 260, "Fixture User", 4),
        (305, "Gamma", 22, "Gamma.Legacy.Build", "classic", "main", "canceled", "completed", 40, "Fixture User", 1),
        (306, "Gamma", 20, "Gamma.Api.Pipeline", "yaml", "feature/metrics", None, "inProgress", 90, "Fixture User", 0),
    ]

    for run_id, proj, p_id, p_name, p_type, branch, res, st, dur, user, day_offset in configs:
        st_dt = base + timedelta(days=day_offset, hours=2)
        fn_dt = st_dt + timedelta(seconds=dur)
        runs.append({
            "id": run_id,
            "project": proj,
            "pipelineId": p_id,
            "pipelineName": p_name,
            "pipelineType": p_type,
            "buildNumber": f"2026110{day_offset}.{run_id % 10}",
            "status": st,
            "result": res,
            "sourceBranch": branch,
            "sourceVersion": f"commit_{run_id:04x}abcdef",
            "requestedBy": user,
            "queueTime": st_dt.isoformat() + "Z",
            "startTime": st_dt.isoformat() + "Z",
            "finishTime": fn_dt.isoformat() + "Z" if st == "completed" else "",
            "durationSeconds": dur if st == "completed" else 0,
            "url": f"https://dev.azure.com/fixture-org/{proj}/_build/results?buildId={run_id}"
        })

    return runs


# -----------------------------------------------------------------------------
# Live Sync & SQLite Caching
# -----------------------------------------------------------------------------

def sync_live_pipeline_runs(org_url: str, pat: str, days: int = 30, force_refresh: bool = False, include_cache_status: bool = False):
    """Synchronizes pipeline runs from Azure DevOps and caches in SQLite."""
    if sync_service.is_fixture_mode():
        return build_fixture_pipelines()

    now = _utcnow()
    now_iso = now.isoformat()

    if not force_refresh:
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            cursor = conn.cursor()
            state = cursor.execute("SELECT * FROM pipeline_cache_state WHERE id=1").fetchone()
            if state and state["outcome"] == "partial" and state["requested_days"] == days and state["completed_at"]:
                try:
                    last_sync_dt = datetime.fromisoformat(state["completed_at"])
                    if 0 <= (now - last_sync_dt).total_seconds() < CACHE_TTL_SECONDS:
                        cursor.execute("SELECT * FROM pipeline_runs WHERE queue_time >= ? ORDER BY queue_time DESC", ((now - timedelta(days=days)).isoformat(timespec="seconds") + "Z",))
                        cached = [_row_to_pipeline_dict(r) for r in cursor.fetchall()]
                        return {"items": cached, "cacheStatus": {"outcome": "partial", "complete": False, "stale": False, "paginationBounded": True, "completenessScope": "discovered-projects/date-window", "projectDiscoveryComplete": False, "organizationSnapshotComplete": False}} if include_cache_status else cached
                except Exception:
                    pass

    headers = sync_service.get_devops_headers(pat)
    start_utc = now - timedelta(days=days)
    start_date_iso = start_utc.isoformat() + "Z"

    all_raw = []
    org_fetch_succeeded = False
    org_fetch_complete = False
    project_outcomes = {}
    fetch_failed = False
    try:
        url = f"{org_url.rstrip('/')}/_apis/build/builds"
        token = None
        seen_tokens = set()
        for _ in range(BUILD_MAX_PAGES):
            params = {"minTime": start_date_iso, "$top": BUILD_PAGE_SIZE, "queryOrder": "finishTimeDescending", "api-version": "7.1"}
            if token:
                params["continuationToken"] = token
            res = requests.get(url, headers=headers, params=params, timeout=15)
            if res.status_code != 200:
                fetch_failed = True
                break
            org_fetch_succeeded = True
            all_raw.extend(res.json().get("value", []))
            next_token = (getattr(res, "headers", {}) or {}).get("x-ms-continuationtoken")
            if not next_token:
                org_fetch_complete = True
                break
            if next_token in seen_tokens:
                fetch_failed = True
                break
            seen_tokens.add(next_token)
            token = next_token
        else:
            fetch_failed = True
    except Exception as e:
        fetch_failed = True
        logger.warning("Org-level builds query failed: %s", e)

    # Project fallback if org query returns empty
    if not org_fetch_succeeded:
        try:
            with sync_service.db_lock, sync_service.get_db_connection() as conn:
                projects = [r["project"] for r in conn.execute(
                    "SELECT DISTINCT project FROM work_items WHERE deleted_at IS NULL AND project IS NOT NULL"
                ).fetchall()]
            if len(projects) > BUILD_MAX_PAGES:
                projects = projects[:BUILD_MAX_PAGES]
                fetch_failed = True
            for proj in projects[:BUILD_MAX_PAGES]:
                try:
                    url = f"{org_url.rstrip('/')}/{proj}/_apis/build/builds"
                    token = None
                    seen_tokens = set()
                    project_complete = False
                    for _ in range(BUILD_MAX_PAGES):
                        params = {"minTime": start_date_iso, "$top": BUILD_PAGE_SIZE, "queryOrder": "finishTimeDescending", "api-version": "7.1"}
                        if token:
                            params["continuationToken"] = token
                        r = requests.get(url, headers=headers, params=params, timeout=10)
                        if r.status_code != 200:
                            break
                        all_raw.extend(r.json().get("value", []))
                        next_token = (getattr(r, "headers", {}) or {}).get("x-ms-continuationtoken")
                        if not next_token:
                            project_complete = True
                            break
                        if next_token in seen_tokens:
                            break
                        seen_tokens.add(next_token)
                        token = next_token
                    project_outcomes[proj] = project_complete
                    if not project_complete:
                        fetch_failed = True
                except Exception:
                    fetch_failed = True
                    project_outcomes[proj] = False
        except Exception as e:
            logger.error("Project fallback build fetch error: %s", e)

    normalized = []
    for raw in all_raw:
        try:
            normalized.append(parse_azure_build(raw, org_url))
        except Exception as ex:
            logger.warning("Failed to parse build record: %s", ex)

    # Deduplicate by (id, project)
    unique_map = {}
    for r in normalized:
        unique_map[(r["id"], r["project"])] = r
    final_runs = list(unique_map.values())

    fetch_complete = org_fetch_complete and bool(all_raw) and not fetch_failed
    fetch_succeeded = org_fetch_succeeded or any(project_outcomes.values())
    if final_runs and fetch_succeeded:
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            cursor = conn.cursor()
            # Append fetched rows; bounded/partial reads must not erase prior cached data.
            cursor.executemany('''
                INSERT OR REPLACE INTO pipeline_runs (
                    id, project, pipeline_id, pipeline_name, pipeline_type, build_number,
                    status, result, source_branch, source_version, requested_by,
                    queue_time, start_time, finish_time, duration_seconds, url, last_synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', [
                (
                    r["id"], r["project"], r["pipelineId"], r["pipelineName"], r["pipelineType"],
                    r["buildNumber"], r["status"], r["result"], r["sourceBranch"], r["sourceVersion"],
                    r["requestedBy"], r["queueTime"], r["startTime"], r["finishTime"],
                    r["durationSeconds"], r["url"], now_iso
                ) for r in final_runs
            ])
            conn.commit()

    outcome = "complete" if fetch_complete else ("partial" if fetch_succeeded else "failed")
    completed_at = now_iso if fetch_complete else None
    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        conn.execute('''INSERT INTO pipeline_cache_state (id, requested_days, attempted_at, completed_at, outcome, successful_projects)
            VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET requested_days=excluded.requested_days,
            attempted_at=excluded.attempted_at, completed_at=excluded.completed_at, outcome=excluded.outcome,
            successful_projects=excluded.successful_projects''',
            (days, now_iso, completed_at, outcome, json.dumps(sorted(p for p, ok in project_outcomes.items() if ok))))
        conn.commit()

    if include_cache_status:
        return {"items": final_runs, "cacheStatus": {
            "outcome": outcome,
            "complete": fetch_complete, "stale": not fetch_succeeded,
            "paginationBounded": not fetch_complete,
            "successfulProjects": sorted(p for p, ok in project_outcomes.items() if ok),
            "completenessScope": "discovered-projects/date-window",
            "projectDiscoveryComplete": False,
            "organizationSnapshotComplete": False,
        }}
    return final_runs


def _row_to_pipeline_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "project": row["project"],
        "pipelineId": row["pipeline_id"],
        "pipelineName": row["pipeline_name"],
        "pipelineType": row["pipeline_type"],
        "buildNumber": row["build_number"],
        "status": row["status"],
        "result": row["result"],
        "sourceBranch": row["source_branch"] or "",
        "sourceVersion": row["source_version"] or "",
        "requestedBy": row["requested_by"] or "Automated",
        "queueTime": row["queue_time"] or "",
        "startTime": row["start_time"] or "",
        "finishTime": row["finish_time"] or "",
        "durationSeconds": row["duration_seconds"] or 0,
        "url": row["url"] or ""
    }


# -----------------------------------------------------------------------------
# Query and Metrics Calculation
# -----------------------------------------------------------------------------

def query_pipeline_runs(all_runs: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    """Filters, paginates, and computes summary metrics over pipeline runs."""
    project_filter = (params.get("project") or "").strip()
    status_filter = (params.get("status") or "").strip().lower()
    result_filter = (params.get("result") or "").strip().lower()
    search_query = (params.get("search") or "").strip().lower()
    branch_filter = (params.get("branch") or "").strip().lower()

    days = max(1, int(params.get("days") or 30))
    limit = max(1, min(100, int(params.get("limit") or 25)))
    offset = max(0, int(params.get("offset") or 0))

    # Time cut-off
    now_utc = _utcnow()
    min_date = now_utc - timedelta(days=days)

    filtered = []
    for r in all_runs:
        # Check time window if finish/queue time exists
        ts = r.get("finishTime") or r.get("queueTime")
        if ts:
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None)
                if dt < min_date:
                    continue
            except Exception:
                pass

        if project_filter and project_filter != "all" and r["project"].lower() != project_filter.lower():
            continue

        if status_filter and status_filter != "all" and r["status"].lower() != status_filter:
            continue

        if result_filter and result_filter != "all":
            res = (r.get("result") or "none").lower()
            if res != result_filter:
                continue

        if branch_filter and branch_filter != "all" and branch_filter not in r["sourceBranch"].lower():
            continue

        if search_query:
            match = (
                search_query in str(r["id"]) or
                search_query in r["pipelineName"].lower() or
                search_query in r["project"].lower() or
                search_query in r["sourceBranch"].lower() or
                search_query in r["requestedBy"].lower()
            )
            if not match:
                continue

        filtered.append(r)

    # Sort descending by finish/queue time
    filtered.sort(key=lambda r: r.get("finishTime") or r.get("queueTime") or "", reverse=True)

    # Compute summary over the filtered time & project window
    summary = compute_pipeline_summary(filtered, days)

    total_matching = len(filtered)
    page_items = filtered[offset:offset + limit]

    return {
        "items": page_items,
        "total": total_matching,
        "limit": limit,
        "offset": offset,
        "hasMore": (offset + len(page_items) < total_matching),
        "summary": summary,
        "dataScope": "fixture" if sync_service.is_fixture_mode() else "live_cached",
        "lastSyncedAt": _utcnow().isoformat()
    }


def compute_pipeline_summary(runs: List[Dict[str, Any]], days: int = 30) -> Dict[str, Any]:
    """Computes success rate (completed denominator), run counts, and daily breakdown."""
    total_runs = len(runs)
    unique_pipelines = len({r["pipelineName"] for r in runs})

    succeeded = 0
    failed = 0
    partially_succeeded = 0
    in_progress = 0
    canceled = 0

    failed_runs = []
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

    for r in runs:
        st = r.get("status", "").lower()
        res = (r.get("result") or "").lower()

        if st == "inprogress":
            in_progress += 1
        elif res == "succeeded":
            succeeded += 1
        elif res == "failed":
            failed += 1
            if len(failed_runs) < 10:
                failed_runs.append(r)
        elif res == "partiallysucceeded":
            partially_succeeded += 1
        elif res == "canceled":
            canceled += 1

        finish_time = r.get("finishTime") or r.get("queueTime", "")
        if finish_time:
            d_key = finish_time[:10]
            if d_key in daily_map:
                daily_map[d_key]["total"] += 1
                if res == "succeeded":
                    daily_map[d_key]["succeeded"] += 1
                elif res == "failed":
                    daily_map[d_key]["failed"] += 1

    # Completed runs: strictly completed outcome
    completed_runs = succeeded + failed + partially_succeeded
    success_rate = round((succeeded / completed_runs * 100), 1) if completed_runs > 0 else 100.0

    return {
        "periodDays": days,
        "totalPipelines": unique_pipelines,
        "totalRuns": total_runs,
        "succeeded": succeeded,
        "failed": failed,
        "partiallySucceeded": partially_succeeded,
        "inProgress": in_progress,
        "canceled": canceled,
        "successRate": success_rate,
        "failedRuns": failed_runs,
        "dailyStats": list(daily_map.values()),
        "lastSyncedAt": _utcnow().isoformat()
    }


def get_single_run_details(all_runs: List[Dict[str, Any]], run_id: int, project: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Retrieves full details for a single pipeline run."""
    for r in all_runs:
        if r["id"] == run_id:
            if project and project != "all" and r["project"].lower() != project.lower():
                continue
            return r
    return None
