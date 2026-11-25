"""My History personal activity service for DevOpsFlow.

Provides read-only aggregation of verified user timeline events:
completed work items, author commits, created/merged PRs, review actions,
SQLite caching, and deterministic offline fixtures.
"""

import json
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional

# Calendar fetches page explicitly. A cap or a failed page marks the result partial rather than complete.
CALENDAR_MAX_PAGES = 20
CALENDAR_MAX_WORK_ITEMS = 1000
WORK_ITEM_BATCH = 200  # Azure DevOps work item batch endpoint accepts at most 200 ids
PR_PAGE_SIZE = 150
COMMIT_PAGE_SIZE = 50
from concurrent.futures import ThreadPoolExecutor
import requests

import feature_context
import persistence
from date_window import DateWindow, rolling_window

logger = logging.getLogger("history_service")

CACHE_TTL_SECONDS = 300  # 5 minutes


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def ensure_history_schema(conn: sqlite3.Connection) -> None:
    """Creates (and migrates) the history_events table on the given connection."""
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS history_events (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            project TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT,
            actor_name TEXT NOT NULL,
            actor_id TEXT,
            url TEXT,
            source_endpoint TEXT,
            source_event_id TEXT,
            verification_status TEXT DEFAULT 'verified',
            last_synced_at TEXT
        )
    ''')
    # Safely migrate existing tables if columns are missing
    cursor.execute("PRAGMA table_info(history_events)")
    existing_cols = {row[1] for row in cursor.fetchall()}
    for col_name, col_type in [
        ("source_endpoint", "TEXT"),
        ("source_event_id", "TEXT"),
        ("verification_status", "TEXT DEFAULT 'verified'")
    ]:
        if col_name not in existing_cols:
            cursor.execute(f"ALTER TABLE history_events ADD COLUMN {col_name} {col_type}")

    cursor.execute('CREATE INDEX IF NOT EXISTS idx_hist_actor ON history_events(actor_name, occurred_at)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_hist_type ON history_events(event_type, project)')
    conn.commit()


def init_history_db():
    """Initializes the history_events cache table in SQLite."""
    with persistence.db_lock, persistence.get_db_connection() as conn:
        ensure_history_schema(conn)


try:
    init_history_db()
except Exception as e:
    logger.warning("Could not initialize history db: %s", e)


# -----------------------------------------------------------------------------
# Deterministic Offline Fixture History
# -----------------------------------------------------------------------------

def build_fixture_history(current_user: str = "Fixture User") -> Dict[str, Any]:
    """Generates deterministic verified timeline events for the active user."""
    base = datetime.now(timezone.utc).replace(tzinfo=None)

    raw_configs = [
        # Today
        ("evt-01", "workItem.closed", 0, 1, "Alpha", "workItem", 91001, "Sample catalog session timeout", "Work item tamamlandı ve kapatıldı", f"https://dev.azure.com/fixture-org/Alpha/_workitems/edit/91001"),
        ("evt-02", "git.commit", 0, 3, "Alpha", "commit", "c03g7", "fix(theme): Retain user theme preference on reboot", "Alpha.Web deposuna commit gönderildi", "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Web/commit/c03g7"),
        ("evt-03", "git.pullRequest.reviewed", 0, 5, "Alpha", "pullRequest", 104, "Handle transient pool disconnects", "PR incelendi ve oy verildi (Onaylandı)", "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Core/pullrequest/104"),

        # Yesterday
        ("evt-04", "git.commit", 1, 2, "Gamma", "commit", "c03g6", "test(edge): Load simulation benchmark suite", "Gamma.Edge deposuna commit gönderildi", "https://dev.azure.com/fixture-org/Gamma/_git/Gamma.Edge/commit/c03g6"),
        ("evt-05", "workItem.stateChanged", 1, 4, "sample-catalog", "workItem", 91002, "Sample catalog archive support", "Durum 'Devam Ediyor' olarak güncellendi", "https://dev.azure.com/fixture-org/sample-catalog/_workitems/edit/91002"),
        ("evt-06", "git.pullRequest.created", 1, 6, "Gamma", "pullRequest", 304, "Load simulation benchmark suite", "Yeni Pull Request açıldı", "https://dev.azure.com/fixture-org/Gamma/_git/Gamma.Edge/pullrequest/304"),

        # This Week
        ("evt-07", "git.commit", 3, 2, "Alpha", "commit", "c01a5", "refactor(i18n): Migrate language bundle loader", "Alpha.Web deposuna commit gönderildi", "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Web/commit/c01a5"),
        ("evt-08", "git.pullRequest.merged", 3, 5, "Alpha", "pullRequest", 102, "Migrate language bundle loader", "Pull Request başarıyla birleştirildi", "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Web/pullrequest/102"),
        ("evt-09", "workItem.closed", 4, 3, "Beta", "workItem", 91004, "Sample catalog shared client library", "Work item tamamlandı", "https://dev.azure.com/fixture-org/Beta/_workitems/edit/91004"),
        ("evt-10", "git.commit", 4, 7, "Beta", "commit", "c02b3", "docs(openapi): Refresh schema references", "Beta.Api deposuna commit gönderildi", "https://dev.azure.com/fixture-org/Beta/_git/Beta.Api/commit/c02b3"),
        ("evt-11", "git.pullRequest.reviewed", 4, 9, "Beta", "pullRequest", 201, "Implement batch item fetch endpoint", "PR incelendi ve onaylandı", "https://dev.azure.com/fixture-org/Beta/_git/Beta.Api/pullrequest/201"),
        ("evt-12", "git.commit", 5, 2, "Alpha", "commit", "c01a4", "style(nav): Align sidebar items with tokens", "Alpha.Web deposuna commit gönderildi", "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Web/commit/c01a4"),

        # Earlier
        ("evt-13", "git.commit", 8, 4, "Gamma", "commit", "c03g1", "feat(gw): Add rate limiter header verification", "Gamma.Gateway deposuna commit gönderildi", "https://dev.azure.com/fixture-org/Gamma/_git/Gamma.Gateway/commit/c03g1"),
        ("evt-14", "git.pullRequest.merged", 9, 3, "Gamma", "pullRequest", 301, "Add rate limiter header verification", "Pull Request başarıyla birleştirildi", "https://dev.azure.com/fixture-org/Gamma/_git/Gamma.Gateway/pullrequest/301"),
        ("evt-15", "workItem.closed", 12, 5, "sample-catalog", "workItem", 91003, "Sample catalog design review", "İş tamamlandı ve kapatıldı", "https://dev.azure.com/fixture-org/sample-catalog/_workitems/edit/91003"),
        ("evt-16", "git.commit", 15, 6, "Alpha", "commit", "c01a1", "feat(auth): Add multi-tenant JWT middleware", "Alpha.Web deposuna commit gönderildi", "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Web/commit/c01a1")
    ]

    events = []
    for evt_id, ev_type, day_offset, hour_offset, proj, ent_type, ent_id, title, summary_text, url in raw_configs:
        ts = base - timedelta(days=day_offset, hours=hour_offset)
        source_endpoint = (
            f"/_apis/wit/workitems/{ent_id}" if ent_type == "workItem"
            else f"/_apis/git/repositories/{proj}/commits/{ent_id}" if ent_type == "commit"
            else f"/_apis/git/pullrequests/{ent_id}"
        )
        events.append({
            "id": evt_id,
            "eventType": ev_type,
            "occurredAt": ts.isoformat() + "Z",
            "project": proj,
            "entity": {
                "type": ent_type,
                "id": ent_id,
                "title": title
            },
            "summary": summary_text,
            "url": url,
            "sourceEndpoint": source_endpoint,
            "sourceEventId": str(ent_id),
            "verificationStatus": "verified",
            "actor": {
                "id": "00000000-0000-0000-0000-000000000001",
                "displayName": current_user
            }
        })

    events.sort(key=lambda x: x["occurredAt"], reverse=True)
    return {"events": events}


# -----------------------------------------------------------------------------
# Provenance & Verification Helpers
# -----------------------------------------------------------------------------

def verify_work_item_event(wi_id: int, title: str, project: str, closed_date: str, closed_by: Optional[Dict[str, Any]], user_info: Dict[str, Any], org_url: str = "") -> Optional[Dict[str, Any]]:
    """Verifies that a work item closing/state change was genuinely authored by the active user."""
    if not closed_by or not closed_date:
        return None

    user_name = (user_info.get("displayName") or "").strip().lower()
    user_id = (user_info.get("id") or "").lower()
    user_email = (user_info.get("uniqueName") or "").lower()

    cb_name = (closed_by.get("displayName") or "").strip().lower()
    cb_id = (closed_by.get("id") or "").lower()
    cb_email = (closed_by.get("uniqueName") or "").lower()

    matches = False
    if user_id and cb_id and user_id == cb_id:
        matches = True
    elif user_email and cb_email and user_email == cb_email:
        matches = True
    elif user_name and cb_name and (user_name in cb_name or cb_name in user_name):
        matches = True

    if not matches:
        return None

    base_url = org_url.rstrip('/') if org_url else "https://dev.azure.com"
    return {
        "id": f"wi-{wi_id}",
        "eventType": "workItem.closed",
        "occurredAt": closed_date,
        "project": project,
        "entity": {
            "type": "workItem",
            "id": wi_id,
            "title": title
        },
        "summary": f"Work Item #{wi_id} tamamlandı ve kapatıldı",
        "url": f"{base_url}/{project}/_workitems/edit/{wi_id}",
        "sourceEndpoint": f"/_apis/wit/workitems/{wi_id}",
        "sourceEventId": str(wi_id),
        "verificationStatus": "verified",
        "actor": {
            "id": closed_by.get("id") or user_info.get("id") or "",
            "displayName": closed_by.get("displayName") or user_info.get("displayName") or ""
        }
    }


def extract_verified_pr_events(pr: Dict[str, Any], user_info: Dict[str, Any], org_url: str) -> List[Dict[str, Any]]:
    """Extracts genuine, verifiable PR events without attributing actions performed by others or unverified timestamps."""
    events = []
    user_name = (user_info.get("displayName") or "").strip().lower()
    user_id = (user_info.get("id") or "").lower()
    user_email = (user_info.get("uniqueName") or "").lower()

    pr_id = pr.get("pullRequestId")
    title = pr.get("title") or "PR"
    repo_obj = pr.get("repository") or {}
    repo = repo_obj.get("name") or "repo"
    proj = repo_obj.get("project", {}).get("name") or pr.get("project") or "General"
    c_date = pr.get("creationDate", "")
    closed_date = pr.get("closedDate") or c_date
    web_url = pr.get("url") or f"{org_url.rstrip('/')}/{proj}/_git/{repo}/pullrequest/{pr_id}"

    # 1. PR Created Event (Verified authored by user)
    created_by = pr.get("createdBy") or {}
    author_name = (created_by.get("displayName") or "").strip().lower()
    author_id = (created_by.get("id") or "").lower()
    author_email = (created_by.get("uniqueName") or "").lower()

    is_author = (
        (user_id and author_id and user_id == author_id) or
        (user_email and author_email and user_email == author_email) or
        (user_name and author_name and user_name in author_name)
    )

    if is_author and c_date:
        events.append({
            "id": f"pr-created-{pr_id}",
            "eventType": "git.pullRequest.created",
            "occurredAt": c_date,
            "project": proj,
            "entity": {
                "type": "pullRequest",
                "id": pr_id,
                "title": title,
                "repository": repo
            },
            "summary": f"Pull Request #{pr_id} açıldı",
            "url": web_url,
            "sourceEndpoint": f"/_apis/git/pullrequests/{pr_id}",
            "sourceEventId": str(pr_id),
            "verificationStatus": "verified",
            "actor": {
                "id": created_by.get("id") or user_info.get("id") or "",
                "displayName": created_by.get("displayName") or user_info.get("displayName") or ""
            }
        })

    # 2. PR Merged Event (Verified completed by user)
    # Check closedBy to verify WHO actually merged it
    closed_by = pr.get("closedBy") or {}
    closer_name = (closed_by.get("displayName") or "").strip().lower()
    closer_id = (closed_by.get("id") or "").lower()
    closer_email = (closed_by.get("uniqueName") or "").lower()

    is_closer = (
        (user_id and closer_id and user_id == closer_id) or
        (user_email and closer_email and user_email == closer_email) or
        (user_name and closer_name and user_name in closer_name)
    )

    if pr.get("status") == "completed" and is_closer and closed_date:
        events.append({
            "id": f"pr-merged-{pr_id}",
            "eventType": "git.pullRequest.merged",
            "occurredAt": closed_date,
            "project": proj,
            "entity": {
                "type": "pullRequest",
                "id": pr_id,
                "title": title,
                "repository": repo
            },
            "summary": f"Pull Request #{pr_id} birleştirildi",
            "url": web_url,
            "sourceEndpoint": f"/_apis/git/pullrequests/{pr_id}",
            "sourceEventId": str(pr_id),
            "verificationStatus": "verified",
            "actor": {
                "id": closed_by.get("id") or user_info.get("id") or "",
                "displayName": closed_by.get("displayName") or user_info.get("displayName") or ""
            }
        })

    # 3. PR Review Event (Only include if review action has verified actor and timestamp)
    for r in pr.get("reviewers", []):
        r_id = (r.get("id") or "").lower()
        r_name = (r.get("displayName") or "").lower()
        r_email = (r.get("uniqueName") or "").lower()
        is_user_reviewer = (
            (user_id and r_id and user_id == r_id) or
            (user_email and r_email and user_email == r_email) or
            (user_name and r_name and user_name in r_name)
        )
        if is_user_reviewer and not is_author:
            vote = r.get("vote", 0)
            # Only include if vote is decisive and review timestamp is specifically verifiable (e.g. reviewTime or iteration/closedDate with approval)
            rev_time = r.get("lastModifiedDate") or r.get("voteDate")
            if vote != 0 and rev_time:
                v_label = "onaylandı" if vote == 10 else "incelendi"
                events.append({
                    "id": f"pr-review-{pr_id}",
                    "eventType": "git.pullRequest.reviewed",
                    "occurredAt": rev_time,
                    "project": proj,
                    "entity": {
                        "type": "pullRequest",
                        "id": pr_id,
                        "title": title,
                        "repository": repo
                    },
                    "summary": f"Pull Request #{pr_id} {v_label}",
                    "url": web_url,
                    "sourceEndpoint": f"/_apis/git/pullrequests/{pr_id}/reviewers",
                    "sourceEventId": str(pr_id),
                    "verificationStatus": "verified",
                    "actor": {
                        "id": r.get("id") or user_info.get("id") or "",
                        "displayName": r.get("displayName") or user_info.get("displayName") or ""
                    }
                })
            break

    return events


# -----------------------------------------------------------------------------
# Live Sync & SQLite Caching
# -----------------------------------------------------------------------------

def sync_live_history(org_url: str, pat: str, user_info: Dict[str, Any], days: int = 30, force_refresh: bool = False,
                      window: Optional[DateWindow] = None) -> Dict[str, Any]:
    """Synchronizes user's personal activity events from Azure DevOps.

    A calendar ``window`` bounds every upstream query to ``[window.start, window.end)``. It never uses the
    cache shortcut and never deletes cached rows; fetched true events are only upserted.
    """
    window = window or rolling_window(days)
    calendar = window.is_calendar
    user_name = (user_info.get("displayName") or "Unknown").strip()
    user_id = (user_info.get("id") or "").lower()
    user_email = (user_info.get("uniqueName") or "").lower()

    if feature_context.is_fixture_mode():
        return build_fixture_history(user_name)

    now = _utcnow()
    now_iso = now.isoformat()

    if not force_refresh and not calendar:
        with persistence.db_lock, persistence.get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT MAX(last_synced_at) as last_sync, COUNT(*) as count FROM history_events WHERE actor_name = ?", (user_name,))
            row = cursor.fetchone()
            if row and row["last_sync"] and row["count"] > 0:
                try:
                    last_sync_dt = datetime.fromisoformat(row["last_sync"])
                    if (now - last_sync_dt).total_seconds() < CACHE_TTL_SECONDS:
                        cursor.execute("SELECT * FROM history_events WHERE actor_name = ? ORDER BY occurred_at DESC", (user_name,))
                        events = [_row_to_event_dict(r) for r in cursor.fetchall()]
                        return {"events": events}
                except Exception:
                    pass

    headers = feature_context.get_devops_headers(pat)
    start_utc = now - timedelta(days=days)
    commit_range = f"fromDate={start_utc.isoformat()}Z"
    if calendar:
        commit_range = f"fromDate={window.iso_start()}&searchCriteria.toDate={window.iso_end()}"
        # Bounds come from validated datetimes, never from request text.
        start_lit = window.start.strftime('%Y-%m-%dT%H:%M:%SZ')
        end_lit = window.end.strftime('%Y-%m-%dT%H:%M:%SZ')
        # An item closed inside the window and changed afterwards is found through ClosedDate; the exact event
        # date (ClosedDate, else ChangedDate) is checked again after the fetch.
        changed_clause = (
            f"(([System.ChangedDate] >= '{start_lit}' AND [System.ChangedDate] < '{end_lit}') "
            f"OR ([Microsoft.VSTS.Common.ClosedDate] >= '{start_lit}' AND [Microsoft.VSTS.Common.ClosedDate] < '{end_lit}')) "
        )
    else:
        changed_clause = f"[System.ChangedDate] >= @Today - {days} "

    events = []
    # Calendar fetches record every incomplete source so the result is never presented as complete.
    coverage_issues: List[str] = []

    # 1. Closed / Completed Work Items assigned to @Me
    try:
        wiql_url = f"{org_url.rstrip('/')}/_apis/wit/wiql?api-version=7.1"
        query_str = (
            f"SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], "
            f"[System.TeamProject], [Microsoft.VSTS.Common.ClosedDate], [System.ChangedDate] "
            f"FROM WorkItems "
            f"WHERE [System.AssignedTo] = @Me "
            f"  AND [System.State] IN ('Closed', 'Completed', 'Resolved', 'Done') "
            f"  AND {changed_clause}"
            f"ORDER BY [System.ChangedDate] DESC"
        )
        wiql_res = requests.post(wiql_url, headers=headers, json={"query": query_str}, timeout=15)
        if wiql_res.status_code == 200:
            wi_refs = wiql_res.json().get("workItems", [])
            if calendar:
                if len(wi_refs) > CALENDAR_MAX_WORK_ITEMS:
                    coverage_issues.append("work-items-capped")
                    wi_refs = wi_refs[:CALENDAR_MAX_WORK_ITEMS]
                all_ids = [str(w["id"]) for w in wi_refs]
                id_chunks = [all_ids[i:i + WORK_ITEM_BATCH] for i in range(0, len(all_ids), WORK_ITEM_BATCH)]
            else:
                id_chunks = [[str(w["id"]) for w in wi_refs[:100]]]
            for wi_ids in id_chunks:
                if not wi_ids:
                    continue
                d_url = f"{org_url.rstrip('/')}/_apis/wit/workitems?ids={','.join(wi_ids)}&fields=System.Title,System.WorkItemType,System.State,System.TeamProject,Microsoft.VSTS.Common.ClosedDate,System.ChangedDate,Microsoft.VSTS.Common.ClosedBy,System.ChangedBy&api-version=7.1"
                d_res = requests.get(d_url, headers=headers, timeout=15)
                if d_res.status_code != 200:
                    if calendar:
                        coverage_issues.append("work-item-details-failed")
                    continue
                for item in d_res.json().get("value", []):
                    f = item.get("fields", {})
                    i_id = item.get("id")
                    proj = f.get("System.TeamProject", "Unknown")
                    title = f.get("System.Title", "Work Item")
                    c_date = f.get("Microsoft.VSTS.Common.ClosedDate") or f.get("System.ChangedDate", "")
                    closed_by = f.get("Microsoft.VSTS.Common.ClosedBy") or f.get("System.ChangedBy")

                    verified_wi = verify_work_item_event(i_id, title, proj, c_date, closed_by, user_info, org_url)
                    if verified_wi:
                        events.append(verified_wi)
        elif calendar:
            coverage_issues.append("work-items-query-failed")
    except Exception as e:
        logger.warning("History: work items fetch failed: %s", e)
        if calendar:
            coverage_issues.append("work-items-error")

    # 2. Merged PRs authored by user & Reviewed PRs (calendar: every page up to the cap, same query otherwise)
    try:
        pr_base = "{}/_apis/git/pullrequests?searchCriteria.status=all&$top={}&api-version=7.1".format(
            org_url.rstrip('/'), PR_PAGE_SIZE if calendar else 150)
        pr_pages = CALENDAR_MAX_PAGES if calendar else 1
        pr_complete = False
        for page_index in range(pr_pages):
            pr_url = pr_base + (f"&$skip={page_index * PR_PAGE_SIZE}" if calendar and page_index else "")
            pr_res = requests.get(pr_url, headers=headers, timeout=12)
            if pr_res.status_code != 200:
                break
            page = pr_res.json().get("value", [])
            for pr in page:
                events.extend(extract_verified_pr_events(pr, user_info, org_url))
            if not calendar or len(page) < PR_PAGE_SIZE:
                pr_complete = True
                break
        if calendar and not pr_complete:
            coverage_issues.append("pull-requests-incomplete")
    except Exception as e:
        logger.warning("History: pull requests fetch failed: %s", e)
        if calendar:
            coverage_issues.append("pull-requests-error")

    # 3. Commits authored by user (calendar: every page per repository up to the cap)
    try:
        repo_res = requests.get(f"{org_url.rstrip('/')}/_apis/git/repositories?api-version=7.1", headers=headers, timeout=10)
        if repo_res.status_code == 200:
            repos = repo_res.json().get("value", [])

            def fetch_user_commits(repo):
                """Returns (events, complete). ``complete`` is False when a page failed or the cap was reached."""
                p_name = repo.get("project", {}).get("name", "")
                r_id = repo.get("id")
                r_name = repo.get("name")
                if not p_name or not r_id:
                    return [], not calendar
                out = []
                repo_complete = False
                try:
                    for page_index in range(CALENDAR_MAX_PAGES if calendar else 1):
                        page_size = COMMIT_PAGE_SIZE if calendar else 50
                        skip = f"&$skip={page_index * page_size}" if calendar and page_index else ""
                        c_url = f"{org_url.rstrip('/')}/{p_name}/_apis/git/repositories/{r_id}/commits?searchCriteria.{commit_range}&$top={page_size}{skip}&api-version=7.1"
                        res = requests.get(c_url, headers=headers, timeout=6)
                        if res.status_code != 200:
                            break
                        page = res.json().get("value", [])
                        for c in page:
                            a_obj = c.get("author", {})
                            a_name = (a_obj.get("name") or "").lower()
                            a_email = (a_obj.get("email") or "").lower()
                            if (user_name.lower() in a_name) or (user_email and user_email in a_email):
                                commit_id = c.get("commitId", "")
                                out.append({
                                    "id": f"commit-{commit_id[:8]}",
                                    "eventType": "git.commit",
                                    "occurredAt": a_obj.get("date", ""),
                                    "project": p_name,
                                    "entity": {
                                        "type": "commit",
                                        "id": commit_id[:8],
                                        "title": (c.get("comment") or "").split('\n')[0][:80],
                                        "repository": r_name
                                    },
                                    "summary": f"{r_name} deposuna commit: {(c.get('comment') or '').split(chr(10))[0][:60]}",
                                    "url": f"{org_url.rstrip('/')}/{p_name}/_git/{r_name}/commit/{commit_id}",
                                    "sourceEndpoint": f"/_apis/git/repositories/{r_name}/commits/{commit_id}",
                                    "sourceEventId": commit_id[:8],
                                    "verificationStatus": "verified",
                                    "actor": {"id": user_id, "displayName": user_name}
                                })
                        if not calendar or len(page) < COMMIT_PAGE_SIZE:
                            repo_complete = True
                            break
                except Exception:
                    pass
                if calendar and not repo_complete:
                    logger.warning("History calendar commit fetch incomplete for %s", p_name)
                return out, repo_complete

            with ThreadPoolExecutor(max_workers=8) as executor:
                for batch, repo_complete in executor.map(fetch_user_commits, repos):
                    events.extend(batch)
                    if calendar and not repo_complete:
                        coverage_issues.append("commits-incomplete")
        elif calendar:
            coverage_issues.append("repositories-failed")
    except Exception as e:
        logger.warning("History: commits fetch failed: %s", e)
        if calendar:
            coverage_issues.append("commits-error")

    # Deduplicate events by id
    unique_map = {}
    for ev in events:
        unique_map[ev["id"]] = ev
    final_events = list(unique_map.values())
    if calendar:
        final_events = [e for e in final_events if _window_matches(e.get("occurredAt"), window)]
    final_events.sort(key=lambda x: x["occurredAt"], reverse=True)

    # Cache in SQLite
    if final_events:
        with persistence.db_lock, persistence.get_db_connection() as conn:
            cursor = conn.cursor()
            if not calendar:
                cursor.execute("DELETE FROM history_events WHERE actor_name = ?", (user_name,))
            cursor.executemany('''
                INSERT OR REPLACE INTO history_events (
                    id, event_type, occurred_at, project, entity_type, entity_id,
                    title, summary, actor_name, actor_id, url, source_endpoint,
                    source_event_id, verification_status, last_synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', [
                (
                    e["id"], e["eventType"], e["occurredAt"], e["project"],
                    e["entity"]["type"], str(e["entity"]["id"]), e["entity"]["title"],
                    e["summary"], user_name, user_id, e["url"],
                    e.get("sourceEndpoint", ""), e.get("sourceEventId", ""),
                    e.get("verificationStatus", "verified"), now_iso
                ) for e in final_events
            ])
            conn.commit()

    if not calendar:
        return {"events": final_events}
    complete = not coverage_issues
    return {
        "events": final_events,
        "cacheStatus": {
            "outcome": "complete" if complete else "partial",
            "complete": complete,
            "stale": not complete,
            "issues": sorted(set(coverage_issues)),
        },
    }


IDENTITY_MAX_AGE = timedelta(hours=24)


def _identity_org_key(org_url: str) -> str:
    return (org_url or "").rstrip("/").lower()


def ensure_identity_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS activity_identity (
            org_key TEXT PRIMARY KEY,
            actor_id TEXT NOT NULL,
            display TEXT,
            verified_at TEXT NOT NULL
        )"""
    )


def save_identity(conn: sqlite3.Connection, org_url: str, user_info: Dict[str, Any], verified_at: Optional[datetime] = None) -> None:
    """Persists the verified current user per organisation (no credentials). Call only after a successful check."""
    actor_id = (user_info.get("id") or "").strip()
    if not actor_id:
        return
    ensure_identity_schema(conn)
    conn.execute(
        "INSERT OR REPLACE INTO activity_identity (org_key, actor_id, display, verified_at) VALUES (?, ?, ?, ?)",
        (_identity_org_key(org_url), actor_id, user_info.get("displayName") or "",
         (verified_at or _utcnow()).isoformat(timespec="seconds")),
    )
    conn.commit()


def load_identity(conn: sqlite3.Connection, org_url: str, max_age: Optional[timedelta] = None) -> Optional[Dict[str, Any]]:
    """Stored verified identity, or None when missing (or older than ``max_age`` when given)."""
    ensure_identity_schema(conn)
    row = conn.execute(
        "SELECT actor_id, display, verified_at FROM activity_identity WHERE org_key = ?", (_identity_org_key(org_url),)
    ).fetchone()
    if not row or not row[0]:
        return None
    try:
        verified_at = datetime.fromisoformat(row[2])
    except Exception:
        return None
    if max_age is not None and _utcnow() - verified_at > max_age:
        return None
    return {"id": row[0], "displayName": row[1] or "", "verifiedAt": row[2]}


def load_local_history(conn: sqlite3.Connection, user_id: str, window: DateWindow) -> List[Dict[str, Any]]:
    """Cache-only read of the verified user's events in the window. Never touches upstream.

    Identity isolation: rows are matched on the verified actor id only; an empty id returns nothing, so another
    user's rows can never be returned.
    """
    user_id = (user_id or "").strip().lower()
    if not user_id:
        return []
    conn.row_factory = sqlite3.Row
    ensure_history_schema(conn)
    rows = conn.execute(
        "SELECT * FROM history_events WHERE lower(actor_id) = ? ORDER BY occurred_at DESC", (user_id,)
    ).fetchall()
    return [e for e in (_row_to_event_dict(r) for r in rows) if _window_matches(e.get("occurredAt"), window)]


def _row_to_event_dict(row: sqlite3.Row) -> Dict[str, Any]:
    row_keys = row.keys()
    return {
        "id": row["id"],
        "eventType": row["event_type"],
        "occurredAt": row["occurred_at"],
        "project": row["project"],
        "entity": {
            "type": row["entity_type"],
            "id": row["entity_id"],
            "title": row["title"]
        },
        "summary": row["summary"] or "",
        "url": row["url"] or "",
        "sourceEndpoint": row["source_endpoint"] if "source_endpoint" in row_keys else "",
        "sourceEventId": row["source_event_id"] if "source_event_id" in row_keys else "",
        "verificationStatus": row["verification_status"] if "verification_status" in row_keys else "verified",
        "actor": {
            "id": row["actor_id"] or "",
            "displayName": row["actor_name"]
        }
    }


# -----------------------------------------------------------------------------
# Summary and Query Aggregations
# -----------------------------------------------------------------------------

def _window_matches(date_str: Optional[str], window: DateWindow) -> bool:
    """Window membership. Rolling keeps the historical lower-bound-only semantics."""
    if not window.is_calendar:
        return _is_within_window(date_str, window.start)
    if not date_str:
        return False
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return window.contains(dt)
    except Exception:
        return False


def compute_history_summary(events: List[Dict[str, Any]], days: int = 30, project: str = "all", activity_type: str = "all", search: str = "",
                            window: Optional[DateWindow] = None) -> Dict[str, Any]:
    """Computes personal activity counts, heatmap, and distinct projects touched."""
    now_utc = _utcnow()
    window = window or rolling_window(days, now_utc)

    project_key = (project or "all").strip().lower()
    activity_key = (activity_type or "all").strip().lower()
    search_key = (search or "").strip().lower()
    filtered = [
        e for e in events
        if _window_matches(e.get("occurredAt"), window)
        and (project_key == "all" or (e.get("project") or "").lower() == project_key)
        and (activity_key == "all" or _matches_history_activity(e, activity_key))
        and (not search_key or search_key in _history_search_text(e))
    ]

    total_events = len(filtered)
    completed_wi = 0
    commits_count = 0
    prs_count = 0
    reviews_count = 0
    projects_touched = set()

    daily_map = {}
    for d_key, d_label in window.day_keys(now_utc):
        daily_map[d_key] = {
            "date": d_label,
            "count": 0,
            "commits": 0,
            "workItems": 0,
            "prs": 0
        }

    for e in filtered:
        ev_type = e.get("eventType", "")
        proj = e.get("project")
        if proj:
            projects_touched.add(proj)

        if "workItem" in ev_type:
            completed_wi += 1
        elif "commit" in ev_type:
            commits_count += 1
        elif "pullRequest.reviewed" in ev_type:
            reviews_count += 1
        elif "pullRequest" in ev_type:
            prs_count += 1

        d_str = (e.get("occurredAt") or "")[:10]
        if d_str in daily_map:
            daily_map[d_str]["count"] += 1
            if "commit" in ev_type:
                daily_map[d_str]["commits"] += 1
            elif "workItem" in ev_type:
                daily_map[d_str]["workItems"] += 1
            elif "pullRequest" in ev_type:
                daily_map[d_str]["prs"] += 1

    return {
        "periodDays": window.days,
        "totalEvents": total_events,
        "totalMatchingEvents": total_events,
        "completedWorkItems": completed_wi,
        "commitsCount": commits_count,
        "prsCount": prs_count,
        "reviewsCount": reviews_count,
        "projectsTouched": sorted(projects_touched),
        "dailyHeatmap": list(daily_map.values()),
        "lastSyncedAt": _utcnow().isoformat()
    }


def query_history_events(events: List[Dict[str, Any]], params: Dict[str, Any], window: Optional[DateWindow] = None) -> Dict[str, Any]:
    """Filters, searches, and paginates history events."""
    activity_type = (params.get("activityType") or params.get("eventType") or "all").strip().lower()
    project = (params.get("project") or "all").strip().lower()
    search = (params.get("search") or "").strip().lower()
    days = max(1, int(params.get("days") or 30))
    limit = max(1, min(100, int(params.get("limit") or 25)))
    offset = max(0, int(params.get("offset") or 0))

    window = window or rolling_window(days, _utcnow())

    filtered = []
    for e in events:
        if not _window_matches(e.get("occurredAt"), window):
            continue
        if project != "all" and e.get("project", "").lower() != project:
            continue
        if activity_type != "all" and not _matches_history_activity(e, activity_type):
            continue

        if search:
            if search not in _history_search_text(e):
                continue

        filtered.append(e)

    filtered.sort(key=lambda x: x.get("occurredAt") or "", reverse=True)
    total = len(filtered)
    page_items = filtered[offset:offset + limit]

    return {
        "items": page_items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": (offset + len(page_items) < total),
        "lastSyncedAt": _utcnow().isoformat()
    }


def _matches_history_activity(event: Dict[str, Any], activity_type: str) -> bool:
    event_type = event.get("eventType", "").lower()
    entity_type = event.get("entity", {}).get("type", "").lower()
    if activity_type == "commit":
        return "commit" in event_type or entity_type == "commit"
    if activity_type == "workitem":
        return "workitem" in event_type or entity_type == "workitem"
    if activity_type == "pullrequest":
        return "pullrequest" in event_type or entity_type == "pullrequest"
    if activity_type == "review":
        return "review" in event_type
    return True


def _history_search_text(event: Dict[str, Any]) -> str:
    return " ".join((
        event.get("summary", ""),
        event.get("entity", {}).get("title", ""),
        event.get("project", ""),
        str(event.get("entity", {}).get("id", "")),
    )).lower()


def group_events_by_timeline(events: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Groups events into today, yesterday, thisWeek, and earlier."""
    now_utc = _utcnow()
    today_str = now_utc.strftime('%Y-%m-%d')
    yesterday_str = (now_utc - timedelta(days=1)).strftime('%Y-%m-%d')
    week_ago = now_utc - timedelta(days=7)

    today = []
    yesterday = []
    this_week = []
    earlier = []

    for e in events:
        ts = e.get("occurredAt")
        if not ts:
            earlier.append(e)
            continue
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None)
            d_str = dt.strftime('%Y-%m-%d')
            if d_str == today_str:
                today.append(e)
            elif d_str == yesterday_str:
                yesterday.append(e)
            elif dt >= week_ago:
                this_week.append(e)
            else:
                earlier.append(e)
        except Exception:
            earlier.append(e)

    return {
        "today": today,
        "yesterday": yesterday,
        "thisWeek": this_week,
        "earlier": earlier
    }


def _is_within_window(date_str: Optional[str], min_date: datetime) -> bool:
    if not date_str:
        return True
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00")).replace(tzinfo=None)
        return dt >= min_date
    except Exception:
        return True
