"""Pull Requests service for DevOpsFlow.

Provides read-only aggregation, identity matching, vote mapping, caching,
and deterministic fixture support for Azure DevOps Pull Requests.
"""

import json
import logging
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
from urllib.parse import quote
import requests

import project_inventory
import feature_context
import persistence
import observability

logger = logging.getLogger("pr_service")
_user_group_cache = {}
_user_group_cache_lock = threading.Lock()

CACHE_TTL_SECONDS = 300  # 5 minutes TTL for PR cache
PR_FAILURE_RETRY_SECONDS = 30
PR_PAGE_SIZE = 200
PR_MAX_REQUESTS = 25
PR_PROJECT_MAX_PAGES = 50
PROJECT_SCOPE = "accessible-projects"

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


def _pr_get(url, stage, **kwargs):
    """Issue one read-only PR/identity GET and record a low-cardinality outcome."""
    try:
        response = requests.get(url, **kwargs)
    except requests.Timeout:
        observability.observe_pr_upstream(stage, 'timeout')
        raise
    except requests.ConnectionError:
        observability.observe_pr_upstream(stage, 'connection_error')
        raise
    except Exception:
        observability.observe_pr_upstream(stage, 'transport_error')
        raise
    status = response.status_code
    result = ('ok' if 200 <= status < 300 else 'rate_limited' if status == 429 else
              'server_error' if status >= 500 else 'http_error')
    observability.observe_pr_upstream(stage, result)
    return response


def _read_pr_cache_snapshot(now=None):
    """Read PR rows and their metadata from one SQLite snapshot."""
    now = now or _utcnow()
    started = time.monotonic()
    result = 'ok'
    try:
        with persistence.db_lock, persistence.get_db_connection() as conn:
            conn.execute('BEGIN')
            state = conn.execute("SELECT * FROM pr_cache_state WHERE id=1").fetchone()
            cached = [_row_to_pr_dict(row) for row in conn.execute(
                "SELECT * FROM pull_requests ORDER BY creation_date DESC"
            ).fetchall()]
            last_row_sync = conn.execute("SELECT MAX(last_synced_at) FROM pull_requests").fetchone()[0]
        if not state:
            return {
                'items': cached,
                'fresh': False,
                'attemptedRecently': False,
                'cacheStatus': {
                    'outcome': 'failed', 'complete': False, 'stale': False,
                    'paginationBounded': True, 'dateScope': 'all',
                    'completenessScope': PROJECT_SCOPE, 'projectDiscoveryComplete': False,
                    'organizationSnapshotComplete': False, 'successfulProjects': [],
                    'lastSyncedAt': last_row_sync, 'hasSnapshot': bool(cached), 'errors': [],
                },
            }

        outcome = state['outcome'] or 'failed'
        completed_at = state['completed_at']
        last_complete_at = state['last_complete_at'] if 'last_complete_at' in state.keys() else None
        try:
            errors = json.loads(state['errors_json'] or '[]')
        except (KeyError, TypeError, ValueError):
            errors = []
        scope = state['scope'] if 'scope' in state.keys() else 'organization-pr-query'
        last_synced = max((stamp for stamp in (last_row_sync, last_complete_at) if stamp), default=None)
        fresh = False
        if outcome in {'complete', 'partial'} and completed_at:
            try:
                age = (now - datetime.fromisoformat(completed_at)).total_seconds()
                fresh = 0 <= age < CACHE_TTL_SECONDS
            except (TypeError, ValueError):
                pass
        attempted_recently = False
        attempted_at = state['attempted_at']
        if outcome == 'failed' and attempted_at:
            try:
                age = (now - datetime.fromisoformat(attempted_at)).total_seconds()
                attempted_recently = 0 <= age < PR_FAILURE_RETRY_SECONDS
            except (TypeError, ValueError):
                pass
        return {
            'items': cached,
            'fresh': fresh,
            'attemptedRecently': attempted_recently,
            'cacheStatus': {
                'outcome': outcome,
                'complete': outcome == 'complete',
                'stale': outcome != 'complete' or not fresh,
                'paginationBounded': outcome != 'complete',
                'dateScope': 'all',
                'completenessScope': scope,
                'projectDiscoveryComplete': scope == PROJECT_SCOPE and outcome == 'complete',
                'organizationSnapshotComplete': False,
                'successfulProjects': json.loads(state['successful_projects'] or '[]'),
                'lastSyncedAt': last_synced,
                'hasSnapshot': bool(cached) or bool(last_complete_at),
                'errors': errors,
            },
        }
    except Exception:
        result = 'error'
        raise
    finally:
        observability.observe_pr_stage('sqlite_cache_read', started, result)


def _record_pr_refresh_failure():
    """Record an opaque failed attempt without changing PR rows or successful timestamps."""
    attempted_at = _utcnow().isoformat()
    errors_json = json.dumps([{"kind": "upstream_error"}])
    with persistence.db_lock, persistence.get_db_connection() as conn:
        state = conn.execute("SELECT id FROM pr_cache_state WHERE id=1").fetchone()
        if state:
            conn.execute("UPDATE pr_cache_state SET attempted_at=?, outcome='failed', errors_json=? WHERE id=1",
                         (attempted_at, errors_json))
        else:
            conn.execute('''INSERT INTO pr_cache_state
                (id, attempted_at, completed_at, outcome, successful_projects, errors_json, last_complete_at, scope)
                VALUES (1, ?, NULL, 'failed', '[]', ?, NULL, ?)''',
                (attempted_at, errors_json, PROJECT_SCOPE))
        conn.commit()


def load_live_pull_requests(org_url: str, pat: str, refresh_flights, now=None, force_refresh=False):
    """Serve a bounded PR cache read and share at most one refresh flight per process."""
    if feature_context.is_fixture_mode():
        return build_fixture_prs()

    key = ('pull-requests',)
    def compute():
        started = time.monotonic()
        result = 'error'
        try:
            data = sync_live_pull_requests(org_url, pat, force_refresh=force_refresh, include_cache_status=True)
            outcome = data.get('cacheStatus', {}).get('outcome') if isinstance(data, dict) else None
            result = 'ok' if outcome == 'complete' else 'partial' if outcome == 'partial' else 'failed'
            return data
        except Exception as error:
            try:
                _record_pr_refresh_failure()
            except Exception as state_error:
                logger.error("Could not record PR refresh failure (%s)", type(state_error).__name__)
            logger.error("PR refresh raised unexpectedly (%s)", type(error).__name__)
            raise
        finally:
            observability.observe_pr_stage('cache_refresh', started, result)

    if force_refresh:
        return refresh_flights.run(key, compute)

    snapshot = _read_pr_cache_snapshot(now)
    status = snapshot['cacheStatus']
    if snapshot['fresh']:
        return {'items': snapshot['items'], 'cacheStatus': status}

    if snapshot['attemptedRecently']:
        status['retryAfterSeconds'] = PR_FAILURE_RETRY_SECONDS
        status['refreshing'] = False
        return {'items': snapshot['items'], 'cacheStatus': status}

    refresh_flights.start(key, compute)
    refreshing = refresh_flights.in_flight(key)
    if status['hasSnapshot']:
        status['stale'] = True
        status['refreshing'] = refreshing
        return {'items': snapshot['items'], 'cacheStatus': status}

    if not refreshing:
        # A very fast flight may have completed between the first read and status check.
        refreshed = _read_pr_cache_snapshot(now)
        if refreshed['fresh'] or refreshed['cacheStatus']['hasSnapshot']:
            refreshed['cacheStatus']['stale'] = not refreshed['fresh']
            return {'items': refreshed['items'], 'cacheStatus': refreshed['cacheStatus']}
        return {'items': [], 'cacheStatus': refreshed['cacheStatus']}

    status.update({'outcome': 'loading', 'complete': False, 'stale': False,
                   'hasSnapshot': False, 'refreshing': True, 'retryAfterSeconds': 2})
    return {'items': [], 'cacheStatus': status}


def init_pr_db():
    """Initializes the pull_requests cache table in SQLite."""
    with persistence.db_lock, persistence.get_db_connection() as conn:
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
                successful_projects TEXT NOT NULL DEFAULT '[]',
                errors_json TEXT NOT NULL DEFAULT '[]',
                last_complete_at TEXT,
                scope TEXT NOT NULL DEFAULT 'organization-pr-query'
            )
        ''')
        cache_columns = {row[1] for row in cursor.execute("PRAGMA table_info(pr_cache_state)").fetchall()}
        if "errors_json" not in cache_columns:
            cursor.execute("ALTER TABLE pr_cache_state ADD COLUMN errors_json TEXT NOT NULL DEFAULT '[]'")
        if "last_complete_at" not in cache_columns:
            cursor.execute("ALTER TABLE pr_cache_state ADD COLUMN last_complete_at TEXT")
        if "scope" not in cache_columns:
            cursor.execute("ALTER TABLE pr_cache_state ADD COLUMN scope TEXT NOT NULL DEFAULT 'organization-pr-query'")
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
    if identity.get("isContainer") and i_id and i_id.lower() in {
        group_id.lower() for group_id in (current_user.get("groupIds") or []) if group_id
    }:
        return True
    if c_name and i_name and c_name == i_name:
        return True

    return False


def fetch_user_group_ids(org_name: str, subject_descriptor: str, headers: Dict[str, str]) -> Dict[str, Any]:
    """Resolves the current user's Azure DevOps group origin IDs using read-only Graph GETs."""
    cache_key = (org_name.lower(), subject_descriptor)
    now = time.monotonic()
    with _user_group_cache_lock:
        cached = _user_group_cache.get(cache_key)
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    memberships_url = f"https://vssps.dev.azure.com/{org_name}/_apis/graph/memberships/{quote(subject_descriptor, safe='')}"
    started = time.monotonic()
    try:
        response = _pr_get(memberships_url, 'group_membership', headers=headers, params={"direction": "up", "api-version": "7.1-preview.1"}, timeout=8)
        if response.status_code != 200:
            status = response.status_code
            kind = "auth" if status in (401, 403) else ("rate_limited" if status == 429 else "upstream_http")
            result = {"groupIds": [], "status": "unavailable", "error": {"kind": kind, "status": status}}
        else:
            all_descriptors = list(dict.fromkeys(
                m.get("containerDescriptor") for m in response.json().get("value", []) if m.get("containerDescriptor")
            ))
            descriptors = all_descriptors[:25]
            group_ids = []
            group_lookup_failed = len(all_descriptors) > len(descriptors)
            for descriptor in descriptors:
                group_url = f"https://vssps.dev.azure.com/{org_name}/_apis/graph/groups/{quote(descriptor, safe='')}"
                group_response = _pr_get(group_url, 'group_membership', headers=headers, params={"api-version": "7.1-preview.1"}, timeout=8)
                if group_response.status_code == 200:
                    origin_id = group_response.json().get("originId")
                    if origin_id:
                        group_ids.append(str(origin_id))
                else:
                    group_lookup_failed = True
            result = {"groupIds": sorted(set(group_ids)), "status": "unavailable" if group_lookup_failed else "available"}
            if group_lookup_failed:
                result["error"] = {"kind": "group_lookup_incomplete"}
    except requests.Timeout:
        result = {"groupIds": [], "status": "unavailable", "error": {"kind": "timeout"}}
    except requests.ConnectionError:
        result = {"groupIds": [], "status": "unavailable", "error": {"kind": "connection_refused"}}
    except Exception:
        result = {"groupIds": [], "status": "unavailable", "error": {"kind": "upstream_error"}}
    with _user_group_cache_lock:
        _user_group_cache[cache_key] = (time.monotonic(), result)
    observability.observe_pr_stage('group_lookup', started, 'ok' if result['status'] == 'available' else 'unavailable')
    return result


def cached_user_group_ids(org_name: str, subject_descriptor: str):
    """Return the last group result, if any, plus whether its five-minute TTL is fresh."""
    key = (org_name.lower(), subject_descriptor)
    with _user_group_cache_lock:
        cached = _user_group_cache.get(key)
    if not cached:
        return None, False
    return cached[1], 0 <= time.monotonic() - cached[0] < CACHE_TTL_SECONDS


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
            "isContainer": bool(r.get("isContainer")),
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

FIXTURE_LONG_PR_DESCRIPTION = (
    "## Summary\n\n"
    "Implements tenant token isolation according to RFC 6749 and adds an in-memory cache for validated session tokens.\n\n"
    "## Changes\n\n"
    + "\n".join(f"- Synthetic change {i}: **validates** the `tenant` claim before the cache lookup." for i in range(1, 25))
    + "\n\n## Notes\n\n> Synthetic fixture text, longer than the 400 characters Azure DevOps keeps in list responses.\n\n"
    "```\nconst tenant = claims.tenant;\n```\n\n"
    "See [the design note](https://example.com/design). <script>alert('blocked')</script>\n"
)


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
        "description": FIXTURE_LONG_PR_DESCRIPTION,
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
    if feature_context.is_fixture_mode():
        return build_fixture_prs()

    # Check cache TTL
    now = _utcnow()
    now_iso = now.isoformat()

    if not force_refresh:
        with persistence.db_lock, persistence.get_db_connection() as conn:
            cursor = conn.cursor()
            state = cursor.execute("SELECT * FROM pr_cache_state WHERE id=1").fetchone()
            if state and state["outcome"] in {"complete", "partial"} and state["completed_at"]:
                try:
                    last_sync_dt = datetime.fromisoformat(state["completed_at"])
                    if 0 <= (now - last_sync_dt).total_seconds() < CACHE_TTL_SECONDS:
                        # Cache is fresh, load from SQLite
                        cursor.execute("SELECT * FROM pull_requests ORDER BY creation_date DESC")
                        cached = [_row_to_pr_dict(r) for r in cursor.fetchall()]
                        last_row_sync = cursor.execute("SELECT MAX(last_synced_at) FROM pull_requests").fetchone()[0]
                        last_successful_sync = max((stamp for stamp in (last_row_sync, state["last_complete_at"]) if stamp), default=None)
                        try:
                            cached_errors = json.loads(state["errors_json"] or "[]")
                        except (KeyError, TypeError, ValueError):
                            cached_errors = []
                        last_complete_at = state["last_complete_at"]
                        cached_scope = state["scope"] if "scope" in state.keys() else "organization-pr-query"
                        return {"items": cached, "cacheStatus": {"outcome": state["outcome"], "complete": state["outcome"] == "complete", "stale": state["outcome"] != "complete", "paginationBounded": state["outcome"] != "complete", "lastSyncedAt": last_successful_sync, "hasSnapshot": bool(cached) or bool(last_complete_at), "errors": cached_errors, "completenessScope": cached_scope, "dateScope": "all", "projectDiscoveryComplete": cached_scope == PROJECT_SCOPE and state["outcome"] == "complete", "organizationSnapshotComplete": False}} if include_cache_status else cached
                except Exception:
                    pass

    # Fetch from Azure DevOps
    headers = feature_context.get_devops_headers(pat)
    all_raw_prs = []
    org_fetch_succeeded = False
    org_fetch_complete = False
    fetch_incomplete = False
    project_fetch_outcomes = {}
    upstream_errors = []

    def record_error(status=None, error=None):
        if status in (401, 403):
            kind = "auth"
        elif status == 429:
            kind = "rate_limited"
        elif isinstance(error, requests.Timeout):
            kind = "timeout"
        elif isinstance(error, requests.ConnectionError):
            kind = "connection_refused"
        elif status is not None:
            kind = "upstream_http"
        else:
            kind = "upstream_error"
        entry = {"kind": kind}
        if status is not None:
            entry["status"] = status
        if entry not in upstream_errors:
            upstream_errors.append(entry)

    # 0. Preferred path: read every accessible project (all inventory pages). The organization-level PR
    # endpoint filters after paging, so it returns short pages that are not the last page and silently
    # truncates the result; a short page is only trusted at project level, and even there the scan runs
    # until an empty page. Do not filter by creation date: active PRs can await review long after the
    # recent-history window.
    discovery_started = time.monotonic()
    projects, project_discovery_complete = project_inventory.discover_projects(org_url, headers)
    observability.observe_pr_stage('project_discovery', discovery_started,
                                   'ok' if project_discovery_complete else 'partial')
    scoped = project_discovery_complete
    scoped_all_complete = False
    if scoped:
        def fetch_project_prs(proj):
            records, errors, offset = [], [], 0
            url = f"{org_url.rstrip('/')}/{quote(proj, safe='')}/_apis/git/pullrequests"
            fetch_started = time.monotonic()
            fetch_result = 'ok'
            try:
                for _ in range(PR_PROJECT_MAX_PAGES):
                    params = {"searchCriteria.status": "all", "$skip": offset, "$top": PR_PAGE_SIZE, "api-version": "7.1"}
                    r = _pr_get(url, 'project_fetch', headers=headers, params=params, timeout=15)
                    if r.status_code != 200:
                        fetch_result = 'error'
                        errors.append((r.status_code, None))
                        return proj, records, False, errors
                    page = r.json().get("value", [])
                    if not page:
                        return proj, records, True, errors
                    records.extend(page)
                    offset += len(page)
            except Exception as ex:
                fetch_result = 'error'
                errors.append((None, ex))
            finally:
                observability.observe_pr_stage('project_fetch', fetch_started, fetch_result)
            return proj, records, False, errors

        wait_started = time.monotonic()
        wait_result = 'ok'
        try:
            with ThreadPoolExecutor(max_workers=8) as executor:
                for proj, records, complete, errors in executor.map(fetch_project_prs, projects):
                    all_raw_prs.extend(records)
                    project_fetch_outcomes[proj] = complete
                    if not complete:
                        fetch_incomplete = True
                    for status, error in errors:
                        record_error(status=status, error=error)
        except Exception:
            wait_result = 'error'
            raise
        finally:
            observability.observe_pr_stage('project_fetch_wait', wait_started, wait_result)
        scoped_all_complete = not fetch_incomplete

    # 1. Degraded mode (project inventory unavailable): organization-level query, then work-item projects.
    if not scoped:
        try:
            offset = 0
            for _ in range(PR_MAX_REQUESTS):
                params = {
                    "searchCriteria.status": "all",
                    "$skip": offset,
                    "$top": PR_PAGE_SIZE,
                    "api-version": "7.1",
                }
                url = f"{org_url.rstrip('/')}/_apis/git/pullrequests"
                res = _pr_get(url, 'org_fallback', headers=headers, params=params, timeout=15)
                if res.status_code != 200:
                    fetch_incomplete = True
                    record_error(status=res.status_code)
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
            record_error(error=e)
            logger.warning("Org-level PR query failed, falling back to per-project (%s)", type(e).__name__)

    # 2. Per-project fallback if org query returns empty or fails
    if not org_fetch_succeeded and not scoped:
        try:
            # Query projects from local DB to avoid extra Azure round-trip
            with persistence.db_lock, persistence.get_db_connection() as conn:
                projects = [r["project"] for r in conn.execute(
                    "SELECT DISTINCT project FROM work_items WHERE deleted_at IS NULL AND project IS NOT NULL"
                ).fetchall()]

            for proj in projects[:PR_MAX_REQUESTS]:
                try:
                    offset = 0
                    project_complete = False
                    for _ in range(PR_MAX_REQUESTS):
                        params = {"searchCriteria.status": "all", "$skip": offset, "$top": PR_PAGE_SIZE, "api-version": "7.1"}
                        url = f"{org_url.rstrip('/')}/{proj}/_apis/git/pullrequests"
                        r = _pr_get(url, 'project_fallback', headers=headers, params=params, timeout=10)
                        if r.status_code != 200:
                            record_error(status=r.status_code)
                            break
                        page = r.json().get("value", [])
                        all_raw_prs.extend(page)
                        if len(page) < PR_PAGE_SIZE:
                            project_complete = True
                            break
                        offset += len(page)
                    project_fetch_outcomes[proj] = project_complete
                    if not project_complete:
                        fetch_incomplete = True
                except Exception as ex:
                    project_fetch_outcomes[proj] = False
                    record_error(error=ex)
                    logger.debug("Project PR fetch failed (%s)", type(ex).__name__)
        except Exception as e:
            logger.error("Fallback PR fetch failed (%s)", type(e).__name__)

    # Normalize records
    normalized = []
    for raw in all_raw_prs:
        try:
            parsed = parse_azure_pr(raw, org_url)
            normalized.append(parsed)
        except Exception as ex:
            logger.warning("Failed to parse a PR record (%s)", type(ex).__name__)

    # Deduplicate by (id, project, repository)
    unique_map = {}
    for p in normalized:
        key = (p["id"], p["project"], p["repository"])
        unique_map[key] = p
    final_prs = list(unique_map.values())

    # Write to SQLite in a single transaction
    fetch_succeeded = org_fetch_succeeded or any(project_fetch_outcomes.values()) or (scoped and not projects)
    # The local work-item cache is not an authoritative organization project
    # inventory, so a successful fallback can provide rows but cannot certify
    # a complete organization snapshot or delete older cached rows.
    fetch_complete = scoped_all_complete if scoped else (org_fetch_complete and not fetch_incomplete)
    publish_started = time.monotonic()
    publish_result = 'ok'
    try:
        if fetch_succeeded:
            with persistence.db_lock, persistence.get_db_connection() as conn:
                if fetch_complete:
                    # This query is the full organization snapshot; remove rows that
                    # disappeared (including on a valid empty result) atomically.
                    conn.execute("DELETE FROM pull_requests")
                if final_prs:
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

        with persistence.db_lock, persistence.get_db_connection() as conn:
            outcome = 'complete' if fetch_complete else ('partial' if fetch_succeeded else 'failed')
            completed_at = now_iso if fetch_succeeded else None
            conn.execute('''INSERT INTO pr_cache_state (id, attempted_at, completed_at, outcome, successful_projects, errors_json, last_complete_at, scope)
                VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, attempted_at=excluded.attempted_at,
                completed_at=COALESCE(excluded.completed_at, pr_cache_state.completed_at), outcome=excluded.outcome, successful_projects=excluded.successful_projects,
                errors_json=excluded.errors_json, last_complete_at=COALESCE(excluded.last_complete_at, pr_cache_state.last_complete_at)''',
                (now_iso, completed_at, outcome, json.dumps(sorted(p for p, ok in project_fetch_outcomes.items() if ok)), json.dumps(upstream_errors), now_iso if fetch_complete else None, PROJECT_SCOPE if scoped else "organization-pr-query"))
            conn.commit()
    except Exception:
        publish_result = 'error'
        raise
    finally:
        observability.observe_pr_stage('cache_publish', publish_started, publish_result)

    if not fetch_succeeded:
        with persistence.db_lock, persistence.get_db_connection() as conn:
            cached = [_row_to_pr_dict(r) for r in conn.execute("SELECT * FROM pull_requests ORDER BY creation_date DESC").fetchall()]
        final_prs = cached
    elif not fetch_complete:
        # Keep rows from projects/pages that were not refreshed in a partial response.
        with persistence.db_lock, persistence.get_db_connection() as conn:
            cached = [_row_to_pr_dict(r) for r in conn.execute("SELECT * FROM pull_requests ORDER BY creation_date DESC").fetchall()]
        merged = {(p["id"], p["project"], p["repository"]): p for p in cached}
        merged.update({(p["id"], p["project"], p["repository"]): p for p in final_prs})
        final_prs = list(merged.values())

    with persistence.db_lock, persistence.get_db_connection() as conn:
        last_row_sync = conn.execute("SELECT MAX(last_synced_at) FROM pull_requests").fetchone()[0]
        state = conn.execute("SELECT completed_at, last_complete_at FROM pr_cache_state WHERE id=1").fetchone()
        last_successful_sync = max((stamp for stamp in (last_row_sync, state["last_complete_at"] if state else None) if stamp), default=None)

    if include_cache_status:
        return {"items": final_prs, "cacheStatus": {
            "outcome": outcome,
            "complete": fetch_complete,
            "stale": not fetch_complete,
            "paginationBounded": not fetch_complete,
            "dateScope": "all",
            "completenessScope": PROJECT_SCOPE if scoped else "organization-pr-query",
            "projectDiscoveryComplete": scoped,
            "organizationSnapshotComplete": False,
            "successfulProjects": sorted(p for p, ok in project_fetch_outcomes.items() if ok),
            "lastSyncedAt": last_successful_sync,
            "hasSnapshot": bool(final_prs) or bool(state["last_complete_at"] if state else None),
            "errors": upstream_errors,
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
# Window-aware sync and local reads (calendar windows)
# -----------------------------------------------------------------------------

# Two distinct timestamp semantics that are never merged:
#   created: pull_requests.creation_date, fetched with queryTimeRangeType=created (any status).
#   closed:  pull_requests.closed_date with status completed, fetched with queryTimeRangeType=closed, status=completed.
PR_KINDS = {
    "created": {"status": "all", "range_type": "created", "column": "creation_date"},
    "closed": {"status": "completed", "range_type": "closed", "column": "closed_date"},
}

_PR_UPSERT_SQL = '''INSERT OR REPLACE INTO pull_requests (
    id, project, repository, title, description, status, is_draft,
    author_id, author_name, author_avatar, source_branch, target_branch,
    merge_status, creation_date, closed_date, url, reviewers_json,
    work_items_json, last_synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'''


def _check_kind(kind: str) -> Dict[str, str]:
    if kind not in PR_KINDS:
        raise ValueError(f"unknown pull request kind: {kind}")
    return PR_KINDS[kind]


def fetch_prs_window(org_url: str, pat: str, projects: Optional[List[str]], window, kind: str):
    """Read-only (GET) fetch of one UTC window of pull requests, upserted into ``pull_requests``.

    ``kind`` is ``created`` or ``closed`` (see PR_KINDS). Returns ``(rows, complete)``. ``complete`` is False when
    any project failed, a page request failed, or the page budget was reached; rows read before the failure are
    still stored. Rows outside the window are kept: the upstream time filter is only a request hint, and nothing is
    deleted. ``projects=None`` discovers the accessible projects (an incomplete inventory is never complete).
    """
    spec = _check_kind(kind)
    headers = feature_context.get_devops_headers(pat)
    complete = True
    if projects is None:
        projects, inventory_complete = project_inventory.discover_projects(org_url, headers)
        complete = bool(inventory_complete)
    raw_rows: List[Dict[str, Any]] = []
    for proj in [p for p in projects if p]:
        url = f"{org_url.rstrip('/')}/{quote(proj, safe='')}/_apis/git/pullrequests"
        offset = 0
        project_done = False
        try:
            for _ in range(PR_PROJECT_MAX_PAGES):
                params = {
                    "searchCriteria.status": spec["status"],
                    "searchCriteria.queryTimeRangeType": spec["range_type"],
                    "searchCriteria.minTime": window.iso_start(),
                    "searchCriteria.maxTime": window.iso_end(),
                    "$skip": offset, "$top": PR_PAGE_SIZE, "api-version": "7.1",
                }
                r = _pr_get(url, 'window_fetch', headers=headers, params=params, timeout=15)
                if r.status_code != 200:
                    break
                page = r.json().get("value", [])
                if not page:
                    project_done = True
                    break
                raw_rows.extend(page)
                offset += len(page)
        except Exception as ex:  # noqa: BLE001 - exception text can carry URLs or tokens; log the type only
            logger.warning("Window PR fetch failed (%s)", type(ex).__name__)
        if not project_done:
            complete = False

    unique: Dict[Any, Dict[str, Any]] = {}
    for raw in raw_rows:
        try:
            parsed = parse_azure_pr(raw, org_url)
        except Exception as ex:  # noqa: BLE001
            logger.warning("Failed to parse a PR record (%s)", type(ex).__name__)
            continue
        unique[(parsed["id"], parsed["project"], parsed["repository"])] = parsed
    rows = list(unique.values())
    if rows:
        now_iso = _utcnow().isoformat()
        init_pr_db()
        with persistence.db_lock, persistence.get_db_connection() as conn:
            conn.executemany(_PR_UPSERT_SQL, [(
                p["id"], p["project"], p["repository"], p["title"], p["description"], p["status"],
                p["isDraft"], p["authorId"], p["authorName"], p["authorAvatar"], p["sourceBranch"],
                p["targetBranch"], p["mergeStatus"], p["creationDate"], p["closedDate"], p["url"],
                json.dumps(p["reviewers"]), json.dumps(p["workItems"]), now_iso) for p in rows])
            conn.commit()
    return rows, complete


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


def load_local_pull_requests(conn: sqlite3.Connection, projects: List[str], window, kind: str) -> List[Dict[str, Any]]:
    """Cache-only read of pull requests for a calendar window and project set. Never touches upstream.

    ``created`` selects by creation_date. ``closed`` selects completed PRs by closed_date.
    """
    spec = _check_kind(kind)
    projects = [p for p in projects if p]
    if not projects:
        return []
    column = spec["column"]  # whitelisted: only PR_KINDS values are interpolated
    first = window.start.strftime("%Y-%m-%d")
    last = (window.end - timedelta(days=1)).strftime("%Y-%m-%d")
    where_status = " AND status = 'completed'" if kind == "closed" else ""
    placeholders = ",".join("?" for _ in projects)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        f"""SELECT * FROM pull_requests
            WHERE project IN ({placeholders}){where_status}
              AND substr({column}, 1, 10) >= ? AND substr({column}, 1, 10) <= ?
            ORDER BY {column} DESC""",
        (*projects, first, last),
    ).fetchall()
    return [d for d in (_row_to_pr_dict(r) for r in rows)
            if window.contains(_parse_utc(d["closedDate"] if kind == "closed" else d["creationDate"]))]


def to_team_pull_request(pr: Dict[str, Any]) -> Dict[str, Any]:
    """The compact PR shape team activity aggregation consumes (reviewers who voted, as names)."""
    return {
        "id": pr["id"],
        "project": pr["project"],
        "repository": pr["repository"],
        "title": pr["title"] or "PR",
        "author": pr["authorName"] or "Unknown",
        "reviewers": [r.get("displayName") for r in pr.get("reviewers", [])
                      if r.get("displayName") and r.get("vote", 0) != 0],
        "status": pr["status"] or "active",
        "creationDate": pr["creationDate"],
        "url": pr["url"],
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
    needs_my_review = is_active and is_reviewer and (my_vote == 0)
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
        "dataScope": "fixture" if feature_context.is_fixture_mode() else "live_cached",
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


# Azure DevOps shortens ``description`` in pull request *list* responses; the single-PR response carries the full text.
PR_LIST_DESCRIPTION_LIMIT = 400


def with_full_description(pr: Dict[str, Any], org_url: Optional[str] = None, pat: Optional[str] = None) -> Dict[str, Any]:
    """Adds ``descriptionStatus`` to a PR detail and, outside fixture mode, replaces the cached (possibly shortened)
    description with the full text read from Azure DevOps (one GET).

    ``descriptionStatus``: ``available`` (text present), ``empty`` (confirmed none) or ``unavailable`` (the full
    text could not be read; ``description`` then holds only what the list cache has, which may be a shortened preview).
    """
    result = dict(pr)
    cached = result.get("description") or ""
    if org_url and pat:
        try:
            url = (f"{org_url.rstrip('/')}/{quote(str(pr.get('project') or ''), safe='')}/_apis/git/repositories/"
                   f"{quote(str(pr.get('repository') or ''), safe='')}/pullrequests/{int(pr['id'])}")
            res = requests.get(url, headers=feature_context.get_devops_headers(pat), params={"api-version": "7.1"}, timeout=10)
            if res.status_code == 200:
                full = (res.json() or {}).get("description")
                full = full if isinstance(full, str) else ""
                result["description"] = full
                result["descriptionStatus"] = "available" if full.strip() else "empty"
                return result
        except Exception:
            pass
        result["descriptionStatus"] = "unavailable"
        return result
    if cached.strip():
        result["descriptionStatus"] = "available"
    else:
        result["descriptionStatus"] = "empty"
    return result


def get_single_pr_details(all_prs: List[Dict[str, Any]], pr_id: int, current_user: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Returns detailed information for a single PR."""
    match = next((p for p in all_prs if p.get("id") == pr_id), None)
    if not match:
        return None
    return evaluate_pr_personal_flags(match, current_user)
