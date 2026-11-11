"""Pull Requests service for DevOpsFlow.

Provides read-only aggregation, identity matching, vote mapping, caching,
and deterministic fixture support for Azure DevOps Pull Requests.
"""

import json
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
import requests

import sync_service

logger = logging.getLogger("pr_service")

CACHE_TTL_SECONDS = 300  # 5 minutes TTL for PR cache
PR_PAGE_SIZE = 200
PR_MAX_REQUESTS = 25

VOTE_LABELS_TR = {
    10: "Onaylandı",
    5: "Önerilerle Onaylandı",
    0: "İnceleme Bekliyor",
    -5: "Yazar Yanıtı Bekleniyor",
    -10: "Reddedildi"
}

VOTE_LABELS_EN = {
    10: "Approved",
    5: "Approved with suggestions",
    0: "Waiting for review",
    -5: "Waiting for author",
    -10: "Rejected"
}

VOTE_KEYS = {
    10: "approved",
    5: "approvedWithSuggestions",
    0: "noVote",
    -5: "waitingForAuthor",
    -10: "rejected"
}


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def init_pr_db():
    """Initializes the pull_requests cache table in SQLite."""
    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS pull_requests (
                id INTEGER NOT NULL,
                project TEXT NOT NULL,
                repository TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL,
                is_draft INTEGER DEFAULT 0,
                author_id TEXT,
                author_name TEXT,
                author_avatar TEXT,
                source_branch TEXT,
                target_branch TEXT,
                merge_status TEXT,
                creation_date TEXT,
                closed_date TEXT,
                url TEXT,
                reviewers_json TEXT,
                work_items_json TEXT,
                last_synced_at TEXT,
                PRIMARY KEY (id, project, repository)
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS pr_cache_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                attempted_at TEXT NOT NULL,
                completed_at TEXT,
                outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed')),
                successful_projects TEXT NOT NULL DEFAULT '[]'
            )
        ''')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_pr_scope ON pull_requests(project, status, creation_date)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_pr_author ON pull_requests(author_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_pr_status ON pull_requests(status)')
        conn.commit()


# Ensure table is ready on module load
try:
    init_pr_db()
except Exception as e:
    logger.warning("Could not initialize PR db: %s", e)


def is_user_match(identity: Dict[str, Any], current_user: Optional[Dict[str, Any]]) -> bool:
    """Checks if an author or reviewer identity matches the current authenticated user."""
    if not current_user:
        return False

    c_id = (current_user.get("id") or "").strip().lower()
    c_name = (current_user.get("displayName") or "").strip().lower()
    c_unique = (current_user.get("uniqueName") or "").strip().lower()

    i_id = (identity.get("id") or "").strip().lower()
    i_name = (identity.get("displayName") or identity.get("name") or "").strip().lower()
    i_unique = (identity.get("uniqueName") or "").strip().lower()

    if c_id and i_id and c_id == i_id:
        return True
    if c_unique and i_unique and c_unique == i_unique:
        return True
    if c_name and i_name and (c_name == i_name or c_name in i_name or i_name in c_name):
        return True

    return False


def parse_azure_pr(raw_pr: Dict[str, Any], org_url: str) -> Dict[str, Any]:
    """Normalizes an Azure DevOps PR object into standard DevOpsFlow PR record."""
    pr_id = raw_pr.get("pullRequestId")
    title = (raw_pr.get("title") or "").strip()
    description = raw_pr.get("description") or ""
    status = (raw_pr.get("status") or "active").lower()
    is_draft = 1 if raw_pr.get("isDraft") else 0

    repo = raw_pr.get("repository") or {}
    repo_name = (repo.get("name") or "Unknown").strip()
    project = (repo.get("project", {}).get("name") or "General").strip()

    created_by = raw_pr.get("createdBy") or {}
    author_id = created_by.get("id") or ""
    author_name = created_by.get("displayName") or "Unknown"
    author_avatar = created_by.get("imageUrl") or (created_by.get("_links", {}).get("avatar", {}).get("href", ""))

    creation_date = raw_pr.get("creationDate") or ""
    closed_date = raw_pr.get("closedDate") or ""
    source_branch = (raw_pr.get("sourceRefName") or "").replace("refs/heads/", "")
    target_branch = (raw_pr.get("targetRefName") or "").replace("refs/heads/", "")
    merge_status = (raw_pr.get("mergeStatus") or "notSet").lower()

    # Normalize reviewers
    reviewers = []
    for r in raw_pr.get("reviewers") or []:
        vote = int(r.get("vote", 0))
        reviewers.append({
            "id": r.get("id") or "",
            "displayName": r.get("displayName") or "",
            "uniqueName": r.get("uniqueName") or "",
            "vote": vote,
            "voteKey": VOTE_KEYS.get(vote, "noVote"),
            "voteLabel": VOTE_LABELS_TR.get(vote, "İnceleme Bekliyor"),
            "voteLabelEn": VOTE_LABELS_EN.get(vote, "Waiting for review"),
            "isRequired": bool(r.get("isRequired")),
            "hasDeclined": bool(r.get("hasDeclined")),
            "avatar": r.get("imageUrl") or (r.get("_links", {}).get("avatar", {}).get("href", ""))
        })

    # Normalize work item refs
    work_items = []
    for w in raw_pr.get("workItemRefs") or []:
        w_id = w.get("id")
        if w_id:
            try:
                work_items.append({"id": int(w_id), "url": w.get("url") or ""})
            except (ValueError, TypeError):
                pass

    repo_web_url = (repo.get("webUrl") or "").rstrip("/")
    url = f"{repo_web_url}/pullrequest/{pr_id}" if repo_web_url else (
        f"{org_url.rstrip('/')}/{project}/_git/{repo_name}/pullrequest/{pr_id}"
    )

    return {
        "id": pr_id,
        "project": project,
        "repository": repo_name,
        "title": title,
        "description": description,
        "status": status,
        "isDraft": is_draft,
        "authorId": author_id,
        "authorName": author_name,
        "authorAvatar": author_avatar,
        "sourceBranch": source_branch,
        "targetBranch": target_branch,
        "mergeStatus": merge_status,
        "creationDate": creation_date,
        "closedDate": closed_date,
        "url": url,
        "reviewers": reviewers,
        "workItems": work_items,
        "reviewersCount": len(reviewers)
    }


# -----------------------------------------------------------------------------
# Deterministic Offline Fixture PRs
# -----------------------------------------------------------------------------

def build_fixture_prs() -> List[Dict[str, Any]]:
    """Builds 16 deterministic PRs across Alpha, Beta, Gamma for CI & offline use."""
    user = {
        "id": "00000000-0000-0000-0000-000000000001",
        "displayName": "Fixture User",
        "uniqueName": "fixture.user@devopsflow.local",
        "avatar": ""
    }
    reviewer_ada = {
        "id": "00000000-0000-0000-0000-000000000002",
        "displayName": "Fixture Person A",
        "uniqueName": "ada@devopsflow.local",
        "avatar": ""
    }
    reviewer_grace = {
        "id": "00000000-0000-0000-0000-000000000003",
        "displayName": "Fixture Person B",
        "uniqueName": "grace@devopsflow.local",
        "avatar": ""
    }

    base = datetime(2026, 11, 1, 10, 0, 0)
    prs = []

    # 1. Active PRs needing Fixture User's review (myVote == 0)
    prs.append({
        "id": 101,
        "project": "Alpha",
        "repository": "Alpha.Web",
        "title": "feat(auth): Add multi-tenant token validation and token caching",
        "description": "Implements tenant token isolation according to RFC 6749 and adds SQLite memory cache for validated session JWTs.",
        "status": "active",
        "isDraft": 0,
        "authorId": reviewer_ada["id"],
        "authorName": reviewer_ada["displayName"],
        "authorAvatar": "",
        "sourceBranch": "feature/token-validation",
        "targetBranch": "main",
        "mergeStatus": "succeeded",
        "creationDate": (base + timedelta(days=4, hours=2)).isoformat() + "Z",
        "closedDate": "",
        "url": "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Web/pullrequest/101",
        "reviewers": [
            {**user, "vote": 0, "voteKey": "noVote", "voteLabel": "İnceleme Bekliyor", "voteLabelEn": "Waiting for review", "isRequired": True},
            {**reviewer_grace, "vote": 10, "voteKey": "approved", "voteLabel": "Onaylandı", "voteLabelEn": "Approved", "isRequired": False}
        ],
        "workItems": [{"id": 10246, "url": ""}],
        "reviewersCount": 2
    })

    prs.append({
        "id": 102,
        "project": "Alpha",
        "repository": "Alpha.Service",
        "title": "fix(deps): Resolve circular dependency in event dispatch pipeline",
        "description": "Fixes topological sort when events produce reciprocal notifications.",
        "status": "active",
        "isDraft": 0,
        "authorId": reviewer_grace["id"],
        "authorName": reviewer_grace["displayName"],
        "authorAvatar": "",
        "sourceBranch": "fix/event-dispatch",
        "targetBranch": "develop",
        "mergeStatus": "succeeded",
        "creationDate": (base + timedelta(days=3, hours=5)).isoformat() + "Z",
        "closedDate": "",
        "url": "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Service/pullrequest/102",
        "reviewers": [
            {**user, "vote": 0, "voteKey": "noVote", "voteLabel": "İnceleme Bekliyor", "voteLabelEn": "Waiting for review", "isRequired": True}
        ],
        "workItems": [{"id": 10180, "url": ""}],
        "reviewersCount": 1
    })

    prs.append({
        "id": 201,
        "project": "Beta",
        "repository": "Beta.Core",
        "title": "perf(query): Optimize batch relation resolution for tree traversal",
        "description": "Replaces N+1 queries with single batched in-memory join over cached edges.",
        "status": "active",
        "isDraft": 0,
        "authorId": reviewer_ada["id"],
        "authorName": reviewer_ada["displayName"],
        "authorAvatar": "",
        "sourceBranch": "perf/relation-batching",
        "targetBranch": "main",
        "mergeStatus": "succeeded",
        "creationDate": (base + timedelta(days=2, hours=1)).isoformat() + "Z",
        "closedDate": "",
        "url": "https://dev.azure.com/fixture-org/Beta/_git/Beta.Core/pullrequest/201",
        "reviewers": [
            {**user, "vote": 0, "voteKey": "noVote", "voteLabel": "İnceleme Bekliyor", "voteLabelEn": "Waiting for review", "isRequired": False}
        ],
        "workItems": [],
        "reviewersCount": 1
    })

    # 2. PRs created by Fixture User
    prs.append({
        "id": 103,
        "project": "Alpha",
        "repository": "Alpha.Web",
        "title": "feat(kanban): Add horizontal scroll indicators and responsive column stacking",
        "description": "Implements floating scroll cues when horizontal board width exceeds viewport.",
        "status": "active",
        "isDraft": 0,
        "authorId": user["id"],
        "authorName": user["displayName"],
        "authorAvatar": "",
        "sourceBranch": "feature/kanban-scroll",
        "targetBranch": "main",
        "mergeStatus": "succeeded",
        "creationDate": (base + timedelta(days=4, hours=6)).isoformat() + "Z",
        "closedDate": "",
        "url": "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Web/pullrequest/103",
        "reviewers": [
            {**reviewer_ada, "vote": 10, "voteKey": "approved", "voteLabel": "Onaylandı", "voteLabelEn": "Approved", "isRequired": True},
            {**reviewer_grace, "vote": 5, "voteKey": "approvedWithSuggestions", "voteLabel": "Önerilerle Onaylandı", "voteLabelEn": "Approved with suggestions", "isRequired": False}
        ],
        "workItems": [{"id": 10246, "url": ""}],
        "reviewersCount": 2
    })

    prs.append({
        "id": 301,
        "project": "Gamma",
        "repository": "Gamma.Api",
        "title": "feat(dashboard): Personal productivity metrics and summary aggregations",
        "description": "Endpoints and cache structures for cross-project daily activity overview.",
        "status": "active",
        "isDraft": 1,
        "authorId": user["id"],
        "authorName": user["displayName"],
        "authorAvatar": "",
        "sourceBranch": "feature/dashboard-metrics",
        "targetBranch": "main",
        "mergeStatus": "notSet",
        "creationDate": (base + timedelta(days=5, hours=1)).isoformat() + "Z",
        "closedDate": "",
        "url": "https://dev.azure.com/fixture-org/Gamma/_git/Gamma.Api/pullrequest/301",
        "reviewers": [
            {**reviewer_grace, "vote": 0, "voteKey": "noVote", "voteLabel": "İnceleme Bekliyor", "voteLabelEn": "Waiting for review", "isRequired": True}
        ],
        "workItems": [],
        "reviewersCount": 1
    })

    # 3. PRs where Fixture User already reviewed (vote != 0)
    prs.append({
        "id": 104,
        "project": "Alpha",
        "repository": "Alpha.Service",
        "title": "refactor(config): Move connection timeouts to environment variables",
        "description": "Ensures proxy timeouts are configurable without code edits.",
        "status": "active",
        "isDraft": 0,
        "authorId": reviewer_ada["id"],
        "authorName": reviewer_ada["displayName"],
        "authorAvatar": "",
        "sourceBranch": "refactor/timeouts",
        "targetBranch": "develop",
        "mergeStatus": "succeeded",
        "creationDate": (base + timedelta(days=1)).isoformat() + "Z",
        "closedDate": "",
        "url": "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Service/pullrequest/104",
        "reviewers": [
            {**user, "vote": 10, "voteKey": "approved", "voteLabel": "Onaylandı", "voteLabelEn": "Approved", "isRequired": True}
        ],
        "workItems": [],
        "reviewersCount": 1
    })

    prs.append({
        "id": 202,
        "project": "Beta",
        "repository": "Beta.Core",
        "title": "fix(sync): Handle deleted work items with tombstone markers",
        "description": "Prevents resurrected soft-deleted records during incremental watermark sync.",
        "status": "active",
        "isDraft": 0,
        "authorId": reviewer_grace["id"],
        "authorName": reviewer_grace["displayName"],
        "authorAvatar": "",
        "sourceBranch": "fix/tombstone-sync",
        "targetBranch": "main",
        "mergeStatus": "succeeded",
        "creationDate": (base + timedelta(hours=14)).isoformat() + "Z",
        "closedDate": "",
        "url": "https://dev.azure.com/fixture-org/Beta/_git/Beta.Core/pullrequest/202",
        "reviewers": [
            {**user, "vote": -5, "voteKey": "waitingForAuthor", "voteLabel": "Yazar Yanıtı Bekleniyor", "voteLabelEn": "Waiting for author", "isRequired": True}
        ],
        "workItems": [],
        "reviewersCount": 1
    })

    # 4. Completed & Abandoned PRs
    prs.append({
        "id": 100,
        "project": "Alpha",
        "repository": "Alpha.Web",
        "title": "chore: Update dependencies to React 19 and Tailwind 3",
        "description": "Baseline framework upgrade across web applications.",
        "status": "completed",
        "isDraft": 0,
        "authorId": user["id"],
        "authorName": user["displayName"],
        "authorAvatar": "",
        "sourceBranch": "chore/react19",
        "targetBranch": "main",
        "mergeStatus": "succeeded",
        "creationDate": (base - timedelta(days=2)).isoformat() + "Z",
        "closedDate": (base - timedelta(days=1)).isoformat() + "Z",
        "url": "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Web/pullrequest/100",
        "reviewers": [
            {**reviewer_ada, "vote": 10, "voteKey": "approved", "voteLabel": "Onaylandı", "voteLabelEn": "Approved", "isRequired": True}
        ],
        "workItems": [],
        "reviewersCount": 1
    })

    prs.append({
        "id": 99,
        "project": "Alpha",
        "repository": "Alpha.Service",
        "title": "test(prototype): Experimental WebSocket live updates",
        "description": "Deprecated in favor of short-polling sync status report.",
        "status": "abandoned",
        "isDraft": 0,
        "authorId": reviewer_grace["id"],
        "authorName": reviewer_grace["displayName"],
        "authorAvatar": "",
        "sourceBranch": "prototype/ws-live",
        "targetBranch": "main",
        "mergeStatus": "notSet",
        "creationDate": (base - timedelta(days=5)).isoformat() + "Z",
        "closedDate": (base - timedelta(days=3)).isoformat() + "Z",
        "url": "https://dev.azure.com/fixture-org/Alpha/_git/Alpha.Service/pullrequest/99",
        "reviewers": [],
        "workItems": [],
        "reviewersCount": 0
    })

    return prs


# -----------------------------------------------------------------------------
# Live PR Sync and SQLite Caching
# -----------------------------------------------------------------------------

def sync_live_pull_requests(org_url: str, pat: str, force_refresh: bool = False, include_cache_status: bool = False):
    """Fetches PRs from Azure DevOps, stores in SQLite, and returns normalized records."""
    if sync_service.is_fixture_mode():
        return build_fixture_prs()

    # Check cache TTL
    now = _utcnow()
    now_iso = now.isoformat()

    if not force_refresh:
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            cursor = conn.cursor()
            state = cursor.execute("SELECT * FROM pr_cache_state WHERE id=1").fetchone()
            if state and state["outcome"] == "partial" and state["completed_at"]:
                try:
                    last_sync_dt = datetime.fromisoformat(state["completed_at"])
                    if 0 <= (now - last_sync_dt).total_seconds() < CACHE_TTL_SECONDS:
                        # Cache is fresh, load from SQLite
                        cursor.execute("SELECT * FROM pull_requests ORDER BY creation_date DESC")
                        cached = [_row_to_pr_dict(r) for r in cursor.fetchall()]
                        return {"items": cached, "cacheStatus": {"outcome": "partial", "complete": False, "stale": False, "paginationBounded": True, "completenessScope": "creationDate-window", "dateScope": "creationDate", "projectDiscoveryComplete": False, "organizationSnapshotComplete": False}} if include_cache_status else cached
                except Exception:
                    pass

    # Fetch from Azure DevOps
    headers = sync_service.get_devops_headers(pat)
    all_raw_prs = []
    org_fetch_succeeded = False
    org_fetch_complete = False
    fetch_incomplete = False
    project_fetch_outcomes = {}

    # 1. Try organization-level PR query (active, completed, abandoned)
    try:
        offset = 0
        for _ in range(PR_MAX_REQUESTS):
            params = {
                "searchCriteria.status": "all",
                "searchCriteria.minTime": (now - timedelta(days=30)).isoformat() + "Z",
                "searchCriteria.maxTime": now.isoformat() + "Z",
                "searchCriteria.queryTimeRangeType": "Created",
                "$skip": offset,
                "$top": PR_PAGE_SIZE,
                "api-version": "7.1",
            }
            url = f"{org_url.rstrip('/')}/_apis/git/pullrequests"
            res = requests.get(url, headers=headers, params=params, timeout=15)
            if res.status_code != 200:
                fetch_incomplete = True
                break
            page = res.json().get("value", [])
            org_fetch_succeeded = True
            all_raw_prs.extend(page)
            if len(page) < PR_PAGE_SIZE:
                org_fetch_complete = True
                break
            offset += len(page)
        else:
            fetch_incomplete = True
    except Exception as e:
        logger.warning("Org-level PR query failed, falling back to per-project: %s", e)

    # 2. Per-project fallback if org query returns empty or fails
    if not org_fetch_succeeded:
        try:
            # Query projects from local DB to avoid extra Azure round-trip
            with sync_service.db_lock, sync_service.get_db_connection() as conn:
                projects = [r["project"] for r in conn.execute(
                    "SELECT DISTINCT project FROM work_items WHERE deleted_at IS NULL AND project IS NOT NULL"
                ).fetchall()]

            for proj in projects[:PR_MAX_REQUESTS]:
                try:
                    params = {"searchCriteria.status": "all", "searchCriteria.minTime": (now - timedelta(days=30)).isoformat() + "Z", "searchCriteria.maxTime": now.isoformat() + "Z", "searchCriteria.queryTimeRangeType": "Created", "$skip": 0, "$top": PR_PAGE_SIZE, "api-version": "7.1"}
                    url = f"{org_url.rstrip('/')}/{proj}/_apis/git/pullrequests"
                    r = requests.get(url, headers=headers, params=params, timeout=10)
                    if r.status_code == 200:
                        all_raw_prs.extend(r.json().get("value", []))
                        project_fetch_outcomes[proj] = True
                        if len(r.json().get("value", [])) >= PR_PAGE_SIZE:
                            project_fetch_outcomes[proj] = False
                            fetch_incomplete = True
                    else:
                        project_fetch_outcomes[proj] = False
                except Exception as ex:
                    project_fetch_outcomes[proj] = False
                    logger.debug("Project %s PR fetch error: %s", proj, ex)
        except Exception as e:
            logger.error("Fallback PR fetch error: %s", e)

    # Normalize records
    normalized = []
    for raw in all_raw_prs:
        try:
            parsed = parse_azure_pr(raw, org_url)
            normalized.append(parsed)
        except Exception as ex:
            logger.warning("Failed to parse PR record: %s", ex)

    # Deduplicate by (id, project, repository)
    unique_map = {}
    for p in normalized:
        key = (p["id"], p["project"], p["repository"])
        unique_map[key] = p
    final_prs = list(unique_map.values())

    # Write to SQLite in a single transaction
    # The endpoint's minTime/maxTime filter is based on creationDate only. Older
    # PRs closed in-window are outside this query's scope and are not claimed.
    # QueryTimeRangeType=Created filters by creationDate, not closedDate. A
    # second Closed query would produce incompatible page sets/count semantics;
    # therefore old PRs closed inside the window remain an explicit gap.
    # The documented list API has no total-count contract for this query; keep
    # PR completeness conservative even after a terminal short/empty page.
    fetch_complete = False
    fetch_succeeded = org_fetch_succeeded or any(project_fetch_outcomes.values())
    if final_prs and fetch_succeeded:
        # Return successful project data, but don't replace the wider persisted cache.
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            conn.executemany('''INSERT OR REPLACE INTO pull_requests (
                id, project, repository, title, description, status, is_draft,
                author_id, author_name, author_avatar, source_branch, target_branch,
                merge_status, creation_date, closed_date, url, reviewers_json,
                work_items_json, last_synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', [(
                p["id"], p["project"], p["repository"], p["title"], p["description"], p["status"],
                p["isDraft"], p["authorId"], p["authorName"], p["authorAvatar"], p["sourceBranch"],
                p["targetBranch"], p["mergeStatus"], p["creationDate"], p["closedDate"], p["url"],
                json.dumps(p["reviewers"]), json.dumps(p["workItems"]), now_iso
            ) for p in final_prs])
            conn.commit()
    elif fetch_succeeded and not final_prs:
        pass  # Empty data is not authoritative under bounded organization query semantics.

    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        outcome = 'partial' if fetch_succeeded else 'failed'
        completed_at = now_iso if fetch_succeeded else None
        conn.execute('''INSERT INTO pr_cache_state (id, attempted_at, completed_at, outcome, successful_projects)
            VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,
            completed_at=excluded.completed_at, outcome=excluded.outcome, successful_projects=excluded.successful_projects''',
            (now_iso, completed_at, outcome, json.dumps(sorted(p for p, ok in project_fetch_outcomes.items() if ok))))
        conn.commit()

    if include_cache_status:
        return {"items": final_prs, "cacheStatus": {
            "outcome": outcome,
            "complete": fetch_complete,
            "stale": not fetch_succeeded,
            "paginationBounded": not fetch_complete,
            "dateScope": "creationDate",
            "completenessScope": "creationDate-window",
            "projectDiscoveryComplete": False,
            "organizationSnapshotComplete": False,
            "successfulProjects": sorted(p for p, ok in project_fetch_outcomes.items() if ok),
        }}
    return final_prs


def _row_to_pr_dict(row: sqlite3.Row) -> Dict[str, Any]:
    """Converts a SQLite pull_requests row into dictionary."""
    reviewers = []
    if row["reviewers_json"]:
        try:
            reviewers = json.loads(row["reviewers_json"])
        except Exception:
            pass

    work_items = []
    if row["work_items_json"]:
        try:
            work_items = json.loads(row["work_items_json"])
        except Exception:
            pass

    return {
        "id": row["id"],
        "project": row["project"],
        "repository": row["repository"],
        "title": row["title"],
        "description": row["description"] or "",
        "status": row["status"],
        "isDraft": row["is_draft"],
        "authorId": row["author_id"] or "",
        "authorName": row["author_name"] or "Unknown",
        "authorAvatar": row["author_avatar"] or "",
        "sourceBranch": row["source_branch"] or "",
        "targetBranch": row["target_branch"] or "",
        "mergeStatus": row["merge_status"] or "notSet",
        "creationDate": row["creation_date"] or "",
        "closedDate": row["closed_date"] or "",
        "url": row["url"] or "",
        "reviewers": reviewers,
        "workItems": work_items,
        "reviewersCount": len(reviewers)
    }


# -----------------------------------------------------------------------------
# Query and Evaluation Layer
# -----------------------------------------------------------------------------

def evaluate_pr_personal_flags(pr: Dict[str, Any], current_user: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Annotates a PR record with personal user context flags."""
    author_identity = {"id": pr.get("authorId"), "displayName": pr.get("authorName")}
    is_author = is_user_match(author_identity, current_user)

    is_reviewer = False
    my_vote = 0

    for r in pr.get("reviewers") or []:
        if is_user_match(r, current_user):
            is_reviewer = True
            my_vote = int(r.get("vote", 0))
            break

    is_active = (pr.get("status") or "").lower() == "active"
    needs_my_review = is_active and is_reviewer and not is_author and (my_vote == 0)
    has_reviewed = is_reviewer and (my_vote != 0)

    return {
        **pr,
        "isAuthor": is_author,
        "isReviewer": is_reviewer,
        "myVote": my_vote,
        "myVoteKey": VOTE_KEYS.get(my_vote, "noVote"),
        "myVoteLabel": VOTE_LABELS_TR.get(my_vote, "İnceleme Bekliyor"),
        "myVoteLabelEn": VOTE_LABELS_EN.get(my_vote, "Waiting for review"),
        "needsMyReview": needs_my_review,
        "hasReviewed": has_reviewed
    }


def query_pull_requests(
    all_prs: List[Dict[str, Any]],
    params: Dict[str, Any],
    current_user: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Filters, searches, sorts, and paginates PR records in memory."""
    project_filter = (params.get("project") or "").strip()
    repo_filter = (params.get("repository") or "").strip()
    status_filter = (params.get("status") or "active").strip().lower()
    quick_filter = (params.get("quickFilter") or "all").strip().lower()
    search_query = (params.get("search") or "").strip().lower()

    limit = max(1, min(100, int(params.get("limit") or 25)))
    offset = max(0, int(params.get("offset") or 0))
    sort_by = (params.get("sortBy") or "creationDate").strip()
    sort_order = (params.get("sortOrder") or "desc").strip().lower()

    # Step 1: Project Scope Filtering
    scoped = all_prs
    if project_filter and project_filter != "all":
        scoped = [p for p in scoped if p.get("project", "").lower() == project_filter.lower()]

    if repo_filter:
        scoped = [p for p in scoped if p.get("repository", "").lower() == repo_filter.lower()]

    # Annotate all scoped PRs with personal flags
    annotated = [evaluate_pr_personal_flags(p, current_user) for p in scoped]

    # Calculate summary metrics over the current project scope (active PRs)
    active_in_scope = [p for p in annotated if (p.get("status") or "").lower() == "active"]
    summary = {
        "needsMyReview": sum(1 for p in active_in_scope if p["needsMyReview"]),
        "createdByMe": sum(1 for p in active_in_scope if p["isAuthor"]),
        "involved": sum(1 for p in active_in_scope if p["isAuthor"] or p["isReviewer"]),
        "totalActive": len(active_in_scope)
    }

    # Step 2: Status filtering
    filtered = annotated
    if status_filter != "all":
        filtered = [p for p in filtered if (p.get("status") or "").lower() == status_filter]

    # Step 3: Quick Filter
    if quick_filter == "needs-my-review":
        filtered = [p for p in filtered if p["needsMyReview"]]
    elif quick_filter == "created-by-me":
        filtered = [p for p in filtered if p["isAuthor"]]
    elif quick_filter == "involved":
        filtered = [p for p in filtered if p["isAuthor"] or p["isReviewer"]]

    # Step 4: Text Search
    if search_query:
        def match_search(p):
            if search_query in str(p.get("id", "")):
                return True
            if search_query in (p.get("title") or "").lower():
                return True
            if search_query in (p.get("description") or "").lower():
                return True
            if search_query in (p.get("authorName") or "").lower():
                return True
            if search_query in (p.get("repository") or "").lower():
                return True
            if search_query in (p.get("sourceBranch") or "").lower():
                return True
            return False

        filtered = [p for p in filtered if match_search(p)]

    # Step 5: Sorting
    def sort_key(p):
        val = p.get(sort_by)
        if val is None:
            return ""
        return val

    reverse = (sort_order == "desc")
    filtered.sort(key=sort_key, reverse=reverse)

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


def get_pr_summary(all_prs: List[Dict[str, Any]], project: str = "all", current_user: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Lightweight aggregate summary for personal dashboard cards."""
    scoped = all_prs
    if project and project != "all":
        scoped = [p for p in scoped if p.get("project", "").lower() == project.lower()]

    annotated = [evaluate_pr_personal_flags(p, current_user) for p in scoped]
    active_in_scope = [p for p in annotated if (p.get("status") or "").lower() == "active"]

    return {
        "needsMyReview": sum(1 for p in active_in_scope if p["needsMyReview"]),
        "createdByMe": sum(1 for p in active_in_scope if p["isAuthor"]),
        "involved": sum(1 for p in active_in_scope if p["isAuthor"] or p["isReviewer"]),
        "totalActive": len(active_in_scope),
        "lastSyncedAt": _utcnow().isoformat()
    }


def get_single_pr_details(all_prs: List[Dict[str, Any]], pr_id: int, current_user: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Returns detailed information for a single PR."""
    match = next((p for p in all_prs if p.get("id") == pr_id), None)
    if not match:
        return None
    return evaluate_pr_personal_flags(match, current_user)
