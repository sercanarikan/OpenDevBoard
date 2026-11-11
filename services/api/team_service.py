"""Team Activity service for DevOpsFlow.

Provides read-only aggregation of commits, pull requests, repository activity,
contributor performance analytics, SQLite caching, and deterministic offline fixtures.
"""

import json
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
from concurrent.futures import ThreadPoolExecutor
import requests

import sync_service

logger = logging.getLogger("team_service")

CACHE_TTL_SECONDS = 300  # 5 minutes


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def init_team_db():
    """Initializes the team_commits cache table in SQLite."""
    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS team_commits (
                commit_id TEXT NOT NULL,
                project TEXT NOT NULL,
                repository TEXT NOT NULL,
                author_name TEXT NOT NULL,
                author_email TEXT,
                date TEXT NOT NULL,
                comment TEXT,
                change_counts TEXT,
                url TEXT,
                last_synced_at TEXT,
                PRIMARY KEY (commit_id, repository)
            )
        ''')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_team_commit_author ON team_commits(author_name, project, date)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_team_commit_repo ON team_commits(repository, date)')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS team_activity_cache_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                requested_days INTEGER NOT NULL,
                attempted_at TEXT NOT NULL,
                completed_at TEXT,
                outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed')),
                successful_projects TEXT NOT NULL DEFAULT '[]'
            )
        ''')
        conn.commit()


try:
    init_team_db()
except Exception as e:
    logger.warning("Could not initialize team db: %s", e)


# -----------------------------------------------------------------------------
# Deterministic Offline Fixture Team Activity
# -----------------------------------------------------------------------------

def build_fixture_team_activity() -> Dict[str, Any]:
    """Generates deterministic commit and PR activity across Alpha, Beta, Gamma."""
    base = datetime(2026, 11, 1, 10, 0, 0)
    commits = []
    pull_requests = []

    commit_configs = [
        # (id, project, repo, author, email, comment, day_offset, hour)
        ("c01a1", "Alpha", "Alpha.Web", "Fixture Person A", "ada@devopsflow.local", "feat(auth): Add multi-tenant JWT middleware", 6, 11),
        ("c01a2", "Alpha", "Alpha.Web", "Fixture Person A", "ada@devopsflow.local", "fix(session): Resolve cookie expiration race", 5, 14),
        ("c01a3", "Alpha", "Alpha.Web", "Fixture Person A", "ada@devopsflow.local", "test(auth): Unit tests for token refresh flow", 4, 16),
        ("c01a4", "Alpha", "Alpha.Web", "Fixture User", "fixture.user@devopsflow.local", "style(nav): Align sidebar items with tokens", 5, 9),
        ("c01a5", "Alpha", "Alpha.Web", "Fixture User", "fixture.user@devopsflow.local", "refactor(i18n): Migrate language bundle loader", 3, 10),
        ("c01a6", "Alpha", "Alpha.Core", "Fixture Person B", "grace@devopsflow.local", "perf(db): Index foreign keys on audit log table", 6, 15),
        ("c01a7", "Alpha", "Alpha.Core", "Fixture Person B", "grace@devopsflow.local", "fix(conn): Handle transient pool disconnects", 4, 11),
        ("c01a8", "Alpha", "Alpha.Core", "Fixture Person B", "grace@devopsflow.local", "chore(deps): Bump cryptography to 43.0.1", 2, 13),

        ("c02b1", "Beta", "Beta.Api", "Fixture Person B", "grace@devopsflow.local", "feat(api): Implement batch item fetch endpoint", 5, 12),
        ("c02b2", "Beta", "Beta.Api", "Fixture Person B", "grace@devopsflow.local", "fix(paging): Honor max limit parameter", 4, 17),
        ("c02b3", "Beta", "Beta.Api", "Fixture User", "fixture.user@devopsflow.local", "docs(openapi): Refresh schema references", 4, 14),
        ("c02b4", "Beta", "Beta.Api", "Fixture User", "fixture.user@devopsflow.local", "test(api): Add e2e suite for batch queries", 3, 16),
        ("c02b5", "Beta", "Beta.Worker", "Fixture Person A", "ada@devopsflow.local", "feat(queue): Add retry policy for dead letters", 3, 11),
        ("c02b6", "Beta", "Beta.Worker", "Fixture Person A", "ada@devopsflow.local", "refactor(worker): Decouple telemetry exporter", 2, 15),

        ("c03g1", "Gamma", "Gamma.Gateway", "Fixture User", "fixture.user@devopsflow.local", "feat(gw): Add rate limiter header verification", 5, 18),
        ("c03g2", "Gamma", "Gamma.Gateway", "Fixture User", "fixture.user@devopsflow.local", "fix(cors): Allow preflight on health checks", 4, 8),
        ("c03g3", "Gamma", "Gamma.Gateway", "Fixture Person A", "ada@devopsflow.local", "security(tls): Enforce TLS 1.3 ciphers", 3, 13),
        ("c03g4", "Gamma", "Gamma.Edge", "Fixture Person B", "grace@devopsflow.local", "feat(edge): Geo-DNS routing configuration", 6, 10),
        ("c03g5", "Gamma", "Gamma.Edge", "Fixture Person B", "grace@devopsflow.local", "chore(ci): Add matrix build for arm64 runtime", 2, 9),
        ("c03g6", "Gamma", "Gamma.Edge", "Fixture User", "fixture.user@devopsflow.local", "test(edge): Load simulation benchmark suite", 1, 14),
        ("c03g7", "Alpha", "Alpha.Web", "Fixture Person C", "alan@devopsflow.local", "fix(theme): Retain user theme preference on reboot", 1, 16),
        ("c03g8", "Beta", "Beta.Api", "Fixture Person D", "margaret@devopsflow.local", "perf(query): Cache parsed parameter dictionaries", 1, 10),
    ]

    for c_id, proj, repo, author, email, comment, day_offset, hour in commit_configs:
        dt = base + timedelta(days=day_offset, hours=hour)
        commits.append({
            "commitId": c_id,
            "project": proj,
            "repository": repo,
            "author": author,
            "authorEmail": email,
            "date": dt.isoformat() + "Z",
            "comment": comment,
            "url": f"https://dev.azure.com/fixture-org/{proj}/_git/{repo}/commit/{c_id}"
        })

    pr_configs = [
        # (id, proj, repo, title, author, reviewers, status, day_offset)
        (101, "Alpha", "Alpha.Web", "Add multi-tenant JWT middleware", "Fixture Person A", ["Fixture User", "Fixture Person B"], "completed", 5),
        (102, "Alpha", "Alpha.Web", "Migrate language bundle loader", "Fixture User", ["Fixture Person A"], "completed", 3),
        (103, "Alpha", "Alpha.Core", "Index foreign keys on audit log table", "Fixture Person B", ["Fixture User"], "completed", 4),
        (104, "Alpha", "Alpha.Core", "Handle transient pool disconnects", "Fixture Person B", ["Fixture Person A"], "active", 1),
        (201, "Beta", "Beta.Api", "Implement batch item fetch endpoint", "Fixture Person B", ["Fixture Person A", "Fixture User"], "completed", 4),
        (202, "Beta", "Beta.Api", "Refresh schema references", "Fixture User", ["Fixture Person B"], "completed", 3),
        (203, "Beta", "Beta.Worker", "Add retry policy for dead letters", "Fixture Person A", ["Fixture Person B"], "completed", 2),
        (301, "Gamma", "Gamma.Gateway", "Add rate limiter header verification", "Fixture User", ["Fixture Person A"], "completed", 4),
        (302, "Gamma", "Gamma.Gateway", "Enforce TLS 1.3 ciphers", "Fixture Person A", ["Fixture User", "Fixture Person B"], "completed", 3),
        (303, "Gamma", "Gamma.Edge", "Geo-DNS routing configuration", "Fixture Person B", ["Fixture User"], "completed", 5),
        (304, "Gamma", "Gamma.Edge", "Load simulation benchmark suite", "Fixture User", ["Fixture Person B"], "active", 1),
    ]

    for pr_id, proj, repo, title, author, reviewers, status, day_offset in pr_configs:
        dt = base + timedelta(days=day_offset, hours=10)
        pull_requests.append({
            "id": pr_id,
            "project": proj,
            "repository": repo,
            "title": title,
            "author": author,
            "reviewers": reviewers,
            "status": status,
            "creationDate": dt.isoformat() + "Z",
            "url": f"https://dev.azure.com/fixture-org/{proj}/_git/{repo}/pullrequest/{pr_id}"
        })

    return {
        "commits": commits,
        "pullRequests": pull_requests
    }


# -----------------------------------------------------------------------------
# Live Sync & SQLite Caching
# -----------------------------------------------------------------------------

def sync_live_team_activity(org_url: str, pat: str, days: int = 30, force_refresh: bool = False) -> Dict[str, Any]:
    """Synchronizes Git commits and PR activities across all repositories."""
    if sync_service.is_fixture_mode():
        return {**build_fixture_team_activity(), "cacheStatus": {
            "outcome": "complete", "complete": True, "stale": False,
            "requestedDays": days, "successfulProjects": []
        }}

    now = _utcnow()
    now_iso = now.isoformat()
    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        metadata_row = conn.execute("SELECT * FROM team_activity_cache_state WHERE id = 1").fetchone()
        cached_commits = [_row_to_commit_dict(row) for row in conn.execute(
            "SELECT * FROM team_commits ORDER BY date DESC"
        ).fetchall()]

    if not force_refresh and metadata_row and metadata_row["outcome"] == "complete" \
            and metadata_row["requested_days"] == days and metadata_row["completed_at"]:
        try:
            completed_at = datetime.fromisoformat(metadata_row["completed_at"])
            age_seconds = (now - completed_at).total_seconds()
            if 0 <= age_seconds < CACHE_TTL_SECONDS:
                prs = _load_live_prs_summary_only(org_url, pat, days)
                return {
                    "commits": _filter_commits_to_window(cached_commits, now, days),
                    "pullRequests": prs,
                    "cacheStatus": {
                        "outcome": "complete", "complete": True, "stale": False,
                        "requestedDays": days,
                        "successfulProjects": json.loads(metadata_row["successful_projects"])
                    }
                }
        except (TypeError, ValueError, json.JSONDecodeError):
            pass

    start_utc = now - timedelta(days=days)
    start_date_iso = start_utc.isoformat() + "Z"
    attempted_at = now_iso
    repo_fetch_ok = False
    repos = []
    try:
        headers = sync_service.get_devops_headers(pat)
        r_url = f"{org_url.rstrip('/')}/_apis/git/repositories?api-version=7.1"
        res = requests.get(r_url, headers=headers, timeout=15)
        if res.status_code == 200:
            repos = res.json().get("value", [])
            repo_fetch_ok = True
        else:
            logger.warning("Failed to fetch repositories for team activity: HTTP %s", res.status_code)
    except Exception as e:
        logger.warning("Failed to fetch repositories for team activity: %s", e)

    project_repos: Dict[str, List[Dict[str, Any]]] = {}
    invalid_repo_projects = set()
    for repo in repos:
        project_name = repo.get("project", {}).get("name", "")
        if project_name:
            project_repos.setdefault(project_name, []).append(repo)
            if not repo.get("id"):
                invalid_repo_projects.add(project_name)

    project_results: Dict[str, List[Dict[str, Any]]] = {}
    failed_projects = set()

    def fetch_repo_commits(repo):
        project_name = repo.get("project", {}).get("name", "")
        repo_id = repo.get("id")
        repo_name = repo.get("name")
        if not project_name or not repo_id:
            return project_name, False, []
        try:
            url = f"{org_url.rstrip('/')}/{project_name}/_apis/git/repositories/{repo_id}/commits?searchCriteria.fromDate={start_date_iso}&$top=100&api-version=7.1"
            r = requests.get(url, headers=headers, timeout=8)
            if r.status_code == 200:
                items = r.json().get("value", [])
                out = []
                for c in items:
                    c_id = c.get("commitId", "")
                    author_obj = c.get("author", {})
                    author_name = author_obj.get("name") or "Unknown"
                    author_email = author_obj.get("email") or ""
                    date_str = author_obj.get("date") or ""
                    comment = (c.get("comment") or "").strip()
                    web_url = f"{org_url.rstrip('/')}/{project_name}/_git/{repo_name}/commit/{c_id}"
                    out.append({
                        "commitId": c_id,
                        "project": project_name,
                        "repository": repo_name,
                        "author": author_name,
                        "authorEmail": author_email,
                        "date": date_str,
                        "comment": comment,
                        "url": web_url
                    })
                return project_name, True, out
            logger.warning("Failed to fetch team commits for project %s: HTTP %s", project_name, r.status_code)
        except Exception:
            logger.warning("Failed to fetch team commits for project %s", project_name)
        return project_name, False, []

    if repo_fetch_ok:
        with ThreadPoolExecutor(max_workers=10) as executor:
            for project_name, succeeded, rows in executor.map(fetch_repo_commits, repos):
                if succeeded:
                    project_results.setdefault(project_name, []).extend(rows)
                else:
                    failed_projects.add(project_name)

    successful_projects = sorted(
        project for project, project_repo_list in project_repos.items()
        if project not in failed_projects and project not in invalid_repo_projects
    )
    if repo_fetch_ok and not project_repos:
        successful_projects = []
    complete = repo_fetch_ok and not failed_projects and not invalid_repo_projects
    if invalid_repo_projects:
        complete = False
    outcome = "complete" if complete else (
        "partial" if repo_fetch_ok and successful_projects else "failed"
    )

    fresh_commits = [row for project in successful_projects for row in project_results.get(project, [])]
    success_keys = {(c["commitId"], c["repository"]): c for c in fresh_commits}
    if complete:
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            # A completed range is authoritative only for that range. Preserve all cached history outside it.
            conn.execute("DELETE FROM team_commits WHERE date >= ?", (start_date_iso,))
            conn.executemany('''
                INSERT OR REPLACE INTO team_commits (
                    commit_id, project, repository, author_name, author_email,
                    date, comment, change_counts, url, last_synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', [(
                c["commitId"], c["project"], c["repository"], c["author"], c["authorEmail"],
                c["date"], c["comment"], "", c["url"], now_iso
            ) for c in fresh_commits])
            conn.execute('''
                INSERT INTO team_activity_cache_state
                    (id, requested_days, attempted_at, completed_at, outcome, successful_projects)
                VALUES (1, ?, ?, ?, 'complete', ?)
                ON CONFLICT(id) DO UPDATE SET requested_days=excluded.requested_days,
                    attempted_at=excluded.attempted_at, completed_at=excluded.completed_at,
                    outcome='complete', successful_projects=excluded.successful_projects
            ''', (days, attempted_at, now_iso, json.dumps(successful_projects)))
    else:
        # Partial successful projects are useful, but must not overwrite completeness/freshness metadata.
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            for project in successful_projects:
                conn.execute("DELETE FROM team_commits WHERE project = ? AND date >= ?", (project, start_date_iso))
            conn.executemany('''
                INSERT OR REPLACE INTO team_commits (
                    commit_id, project, repository, author_name, author_email,
                    date, comment, change_counts, url, last_synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', [(
                c["commitId"], c["project"], c["repository"], c["author"], c["authorEmail"],
                c["date"], c["comment"], "", c["url"], now_iso
            ) for c in fresh_commits])
            conn.execute('''
            INSERT INTO team_activity_cache_state
                    (id, requested_days, attempted_at, completed_at, outcome, successful_projects)
                VALUES (1, ?, ?, NULL, ?, ?)
                ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,
                    outcome=excluded.outcome
            ''', (days, attempted_at, outcome, json.dumps(successful_projects)))

    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        commits = [_row_to_commit_dict(row) for row in conn.execute(
                "SELECT * FROM team_commits ORDER BY date DESC"
        ).fetchall()]

    # Replace cached copies of successfully refreshed project commits in the requested window.
    if not complete and successful_projects:
        commits = [
            c for c in commits
            if c["project"] not in successful_projects or not _is_within_window(c.get("date"), start_utc)
        ]
        commits.extend(success_keys.values())

    # 3. Pull requests
    prs = _load_live_prs_summary_only(org_url, pat, days)

    return {
        "commits": _filter_commits_to_window(commits, now, days),
        "pullRequests": prs,
        "cacheStatus": {
            "outcome": outcome,
            "complete": complete,
            "stale": not complete,
            "requestedDays": days,
            "successfulProjects": successful_projects
        }
    }


def _filter_commits_to_window(commits: List[Dict[str, Any]], now: datetime, days: int) -> List[Dict[str, Any]]:
    min_date = now - timedelta(days=days)
    return [commit for commit in commits if _is_within_window(commit.get("date"), min_date)]


def _load_live_prs_summary_only(org_url: str, pat: str, days: int) -> List[Dict[str, Any]]:
    """Fetches PRs across projects for team activity aggregation."""
    headers = sync_service.get_devops_headers(pat)
    now_utc = _utcnow()
    start_utc = now_utc - timedelta(days=days)

    prs = []
    try:
        url = f"{org_url.rstrip('/')}/_apis/git/pullrequests?searchCriteria.status=all&$top=200&api-version=7.1"
        res = requests.get(url, headers=headers, timeout=12)
        if res.status_code == 200:
            for pr in res.json().get("value", []):
                c_date = pr.get("creationDate", "")
                if c_date:
                    try:
                        dt = datetime.fromisoformat(c_date.replace("Z", "+00:00")).replace(tzinfo=None)
                        if dt < start_utc:
                            continue
                    except Exception:
                        pass
                author = pr.get("createdBy", {}).get("displayName") or "Unknown"
                reviewers = [
                    r.get("displayName") for r in pr.get("reviewers", [])
                    if r.get("displayName") and r.get("vote", 0) != 0
                ]
                proj = pr.get("repository", {}).get("project", {}).get("name") or "General"
                repo = pr.get("repository", {}).get("name") or "repo"
                prs.append({
                    "id": pr.get("pullRequestId"),
                    "project": proj,
                    "repository": repo,
                    "title": pr.get("title") or "PR",
                    "author": author,
                    "reviewers": reviewers,
                    "status": pr.get("status") or "active",
                    "creationDate": c_date,
                    "url": f"{org_url.rstrip('/')}/{proj}/_git/{repo}/pullrequest/{pr.get('pullRequestId')}"
                })
    except Exception as e:
        logger.warning("Failed to query live PRs for team activity: %s", e)
    return prs


def _row_to_commit_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "commitId": row["commit_id"],
        "project": row["project"],
        "repository": row["repository"],
        "author": row["author_name"],
        "authorEmail": row["author_email"] or "",
        "date": row["date"],
        "comment": row["comment"] or "",
        "url": row["url"] or ""
    }


# -----------------------------------------------------------------------------
# Metrics and Query Aggregations
# -----------------------------------------------------------------------------

def compute_team_summary(commits: List[Dict[str, Any]], prs: List[Dict[str, Any]], days: int = 30, project: Optional[str] = None, repository: Optional[str] = None) -> Dict[str, Any]:
    """Computes overall team metrics, daily activity trend, contributor stats and repository breakdown."""
    now_utc = _utcnow()
    min_date = now_utc - timedelta(days=days)

    proj_clean = (project or "").strip().lower()
    repo_clean = (repository or "").strip().lower()

    filtered_commits = [
        c for c in commits
        if _is_within_window(c.get("date"), min_date)
        and (not proj_clean or proj_clean == "all" or c.get("project", "").lower() == proj_clean)
        and (not repo_clean or repo_clean == "all" or c.get("repository", "").lower() == repo_clean)
    ]
    filtered_prs = [
        p for p in prs
        if _is_within_window(p.get("creationDate"), min_date)
        and (not proj_clean or proj_clean == "all" or p.get("project", "").lower() == proj_clean)
        and (not repo_clean or repo_clean == "all" or p.get("repository", "").lower() == repo_clean)
    ]

    total_commits = len(filtered_commits)
    total_prs = len(filtered_prs)

    # 1. Daily Activity Trend
    daily_map = {}
    for i in range(days - 1, -1, -1):
        d_key = (now_utc - timedelta(days=i)).strftime('%Y-%m-%d')
        daily_map[d_key] = {
            "date": (now_utc - timedelta(days=i)).strftime('%d %b'),
            "commits": 0,
            "prs": 0,
            "total": 0
        }

    for c in filtered_commits:
        d_str = (c.get("date") or "")[:10]
        if d_str in daily_map:
            daily_map[d_str]["commits"] += 1
            daily_map[d_str]["total"] += 1

    for p in filtered_prs:
        d_str = (p.get("creationDate") or "")[:10]
        if d_str in daily_map:
            daily_map[d_str]["prs"] += 1
            daily_map[d_str]["total"] += 1

    # 2. Contributors aggregation
    contrib_map: Dict[str, Dict[str, Any]] = {}

    for c in filtered_commits:
        name = c["author"]
        if name not in contrib_map:
            contrib_map[name] = {
                "name": name,
                "email": c.get("authorEmail") or "",
                "commitCount": 0,
                "authoredPRs": 0,
                "reviewsCount": 0,
                "lastActivity": c.get("date") or ""
            }
        contrib_map[name]["commitCount"] += 1
        if (c.get("date") or "") > contrib_map[name]["lastActivity"]:
            contrib_map[name]["lastActivity"] = c.get("date") or ""

    for p in filtered_prs:
        author = p["author"]
        if author not in contrib_map:
            contrib_map[author] = {
                "name": author,
                "email": "",
                "commitCount": 0,
                "authoredPRs": 0,
                "reviewsCount": 0,
                "lastActivity": p.get("creationDate") or ""
            }
        contrib_map[author]["authoredPRs"] += 1
        if (p.get("creationDate") or "") > contrib_map[author]["lastActivity"]:
            contrib_map[author]["lastActivity"] = p.get("creationDate") or ""

        for r in p.get("reviewers", []):
            if r != author:
                if r not in contrib_map:
                    contrib_map[r] = {
                        "name": r,
                        "email": "",
                        "commitCount": 0,
                        "authoredPRs": 0,
                        "reviewsCount": 0,
                        "lastActivity": p.get("creationDate") or ""
                    }
                contrib_map[r]["reviewsCount"] += 1

    contributors = sorted(
        contrib_map.values(),
        key=lambda x: (x["commitCount"] + x["authoredPRs"] + x["reviewsCount"]),
        reverse=True
    )
    active_contributors = len(contributors)

    # 3. Repository activity
    repositories = compute_repository_activity(filtered_commits, filtered_prs, project=project)

    return {
        "periodDays": days,
        "project": project or "all",
        "repository": repository or "all",
        "totalCommits": total_commits,
        "totalPRs": total_prs,
        "activeContributors": active_contributors,
        "dailyStats": list(daily_map.values()),
        "contributors": contributors,
        "repositories": repositories,
        "lastSyncedAt": _utcnow().isoformat()
    }


def compute_repository_activity(commits: List[Dict[str, Any]], prs: List[Dict[str, Any]], project: Optional[str] = None) -> List[Dict[str, Any]]:
    """Calculates commit count, PR count and last activity per repository."""
    proj_clean = (project or "").strip().lower()
    repo_map: Dict[str, Dict[str, Any]] = {}

    for c in commits:
        repo = c["repository"]
        proj = c["project"]
        if proj_clean and proj_clean != "all" and proj.lower() != proj_clean:
            continue
        key = f"{proj}/{repo}"
        if key not in repo_map:
            repo_map[key] = {
                "project": proj,
                "repository": repo,
                "commitCount": 0,
                "prCount": 0,
                "lastActivity": c.get("date") or ""
            }
        repo_map[key]["commitCount"] += 1
        if (c.get("date") or "") > repo_map[key]["lastActivity"]:
            repo_map[key]["lastActivity"] = c.get("date") or ""

    for p in prs:
        repo = p["repository"]
        proj = p["project"]
        if proj_clean and proj_clean != "all" and proj.lower() != proj_clean:
            continue
        key = f"{proj}/{repo}"
        if key not in repo_map:
            repo_map[key] = {
                "project": proj,
                "repository": repo,
                "commitCount": 0,
                "prCount": 0,
                "lastActivity": p.get("creationDate") or ""
            }
        repo_map[key]["prCount"] += 1
        if (p.get("creationDate") or "") > repo_map[key]["lastActivity"]:
            repo_map[key]["lastActivity"] = p.get("creationDate") or ""

    return sorted(repo_map.values(), key=lambda r: (r["commitCount"] + r["prCount"]), reverse=True)


def query_contributors(commits: List[Dict[str, Any]], prs: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    """Filters, sorts, and paginates contributors."""
    days = max(1, int(params.get("days") or 30))
    limit = max(1, min(100, int(params.get("limit") or 25)))
    offset = max(0, int(params.get("offset") or 0))
    search = (params.get("search") or "").strip().lower()
    sort_by = (params.get("sortBy") or "commits").lower()
    sort_order = (params.get("sortOrder") or "desc").lower()
    project = params.get("project")
    repository = params.get("repository")

    summary = compute_team_summary(commits, prs, days=days, project=project, repository=repository)
    items = summary["contributors"]

    if search:
        items = [c for c in items if search in c["name"].lower() or search in c["email"].lower()]

    reverse = (sort_order == "desc")
    if sort_by == "commits":
        items.sort(key=lambda x: x["commitCount"], reverse=reverse)
    elif sort_by == "prs":
        items.sort(key=lambda x: x["authoredPRs"], reverse=reverse)
    elif sort_by == "reviews":
        items.sort(key=lambda x: x["reviewsCount"], reverse=reverse)
    elif sort_by == "name":
        items.sort(key=lambda x: x["name"].lower(), reverse=reverse)
    elif sort_by == "date" or sort_by == "activity":
        items.sort(key=lambda x: x["lastActivity"], reverse=reverse)

    total = len(items)
    page_items = items[offset:offset + limit]

    return {
        "items": page_items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": (offset + len(page_items) < total),
        "lastSyncedAt": _utcnow().isoformat()
    }


def query_commits(commits: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    """Filters, searches, and paginates commits."""
    project = (params.get("project") or "").strip().lower()
    repository = (params.get("repository") or "").strip().lower()
    contributor = (params.get("contributor") or "").strip().lower()
    search = (params.get("search") or "").strip().lower()
    days = max(1, int(params.get("days") or 30))
    limit = max(1, min(100, int(params.get("limit") or 25)))
    offset = max(0, int(params.get("offset") or 0))

    now_utc = _utcnow()
    min_date = now_utc - timedelta(days=days)

    filtered = []
    for c in commits:
        if not _is_within_window(c.get("date"), min_date):
            continue
        if project and project != "all" and c["project"].lower() != project:
            continue
        if repository and repository != "all" and c["repository"].lower() != repository:
            continue
        if contributor and contributor != "all" and contributor not in c["author"].lower() and contributor not in c["authorEmail"].lower():
            continue
        if search:
            text = (c["comment"] + " " + c["author"] + " " + c["commitId"] + " " + c["repository"]).lower()
            if search not in text:
                continue
        filtered.append(c)

    filtered.sort(key=lambda c: c.get("date") or "", reverse=True)
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


def _is_within_window(date_str: Optional[str], min_date: datetime) -> bool:
    if not date_str:
        return True
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00")).replace(tzinfo=None)
        return dt >= min_date
    except Exception:
        return True
