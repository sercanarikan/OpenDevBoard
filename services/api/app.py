from flask import Flask, request, jsonify
from datetime import datetime, timedelta, timezone
from dateutil import parser as dtparser
from base64 import b64encode
from flask_cors import CORS
import os
import sys
import logging
import requests
import json
import sqlite3
import re
from urllib.parse import urlparse
from threading import Lock
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor, as_completed

# Azure DevOps SDK imports
from msrest.authentication import BasicAuthentication
from azure.devops.connection import Connection

app = Flask(__name__)


def _team_activity_cache_status(data):
    return data.get("cacheStatus", {"outcome": "complete", "complete": True, "stale": False})


CORS(app)

# Logging ayarları
app.logger.handlers.clear()
app.logger.setLevel(logging.INFO)
stream_handler = logging.StreamHandler(sys.stdout)
stream_handler.setLevel(logging.INFO)
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s [in %(pathname)s:%(lineno)d]')
stream_handler.setFormatter(formatter)
app.logger.addHandler(stream_handler)

AZURE_DEVOPS_ORG_URL = os.getenv('AZURE_DEVOPS_ORG_URL')
AZURE_DEVOPS_PAT = os.getenv('AZURE_DEVOPS_PAT')

DB_PATH = 'devops_cache.db'
db_lock = Lock()

def init_db():
    with db_lock, sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS projects_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cache_key TEXT UNIQUE,
            data TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''')
        conn.commit()

init_db()

def get_cache(cache_key):
    with db_lock, sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        c.execute('SELECT data, updated_at FROM projects_cache WHERE cache_key=?', (cache_key,))
        row = c.fetchone()
        if row:
            return row[0], row[1]
        return None, None

def set_cache(cache_key, data):
    with db_lock, sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        c.execute('''INSERT INTO projects_cache (cache_key, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP''', (cache_key, data))
        conn.commit()

def get_devops_pat():
    pat = os.environ.get('AZURE_DEVOPS_PAT')
    if not pat:
        app.logger.error("AZURE_DEVOPS_PAT environment variable not set.")
        raise ValueError("Azure DevOps PAT not configured in environment.")
    return pat

def get_devops_org_url():
    org_url = os.environ.get('AZURE_DEVOPS_ORG_URL')
    if not org_url:
        app.logger.error("AZURE_DEVOPS_ORG_URL environment variable not set.")
        raise ValueError("Azure DevOps Org URL not configured in environment.")
    return org_url.rstrip('/')

def get_devops_org_name():
    try:
        org_url = get_devops_org_url()
        return org_url.rstrip('/').split('/')[-1]
    except Exception:
        return ""

def get_headers():
    pat = get_devops_pat()
    token = b64encode(f':{pat}'.encode()).decode()
    return {
        'Authorization': f'Basic {token}',
        'Content-Type': 'application/json'
    }

def get_projects_data():
    org_url = get_devops_org_url()
    api_version = '7.1-preview.1'
    url = f'{org_url}/_apis/projects?api-version={api_version}'
    response = requests.get(url, headers=get_headers(), timeout=15)
    response.raise_for_status()
    return response.json().get('value', [])

def get_current_user_info():
    """Gets authenticated user ID and name from Azure DevOps connectionData."""
    try:
        org_url = get_devops_org_url()
        url = f"{org_url}/_apis/connectionData"
        res = requests.get(url, headers=get_headers(), timeout=10)
        if res.status_code == 200:
            data = res.json()
            auth_user = data.get("authenticatedUser", {})
            return {
                "id": auth_user.get("id", ""),
                "displayName": auth_user.get("providerDisplayName") or auth_user.get("customDisplayName", ""),
                "uniqueName": auth_user.get("uniqueName", ""),
                "subjectDescriptor": auth_user.get("subjectDescriptor", "")
            }
    except Exception as e:
        app.logger.warning(f"Could not fetch authenticated user info: {e}")
    return {}

# ------------------------------------------------------------------------------
# API Endpoints
# ------------------------------------------------------------------------------

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({"status": "healthy", "message": "API is running."}), 200

@app.route('/api/env-check', methods=['GET'])
def env_check():
    raw_org_url = os.environ.get('AZURE_DEVOPS_ORG_URL', '')
    org_name = None
    if raw_org_url:
        try:
            parsed_org_url = urlparse(raw_org_url.strip())
            candidate = parsed_org_url.path.strip('/').split('/')[-1]
            if parsed_org_url.scheme == 'https' and parsed_org_url.hostname == 'dev.azure.com' \
                    and not parsed_org_url.username and not parsed_org_url.password \
                    and not parsed_org_url.query and not parsed_org_url.fragment \
                    and len(parsed_org_url.path.strip('/').split('/')) == 1 \
                    and candidate and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,63}', candidate):
                org_name = candidate
        except (AttributeError, ValueError):
            org_name = None
    return jsonify({
        "status": "healthy",
        "organization": org_name,
        "azure_devops_configured": bool(raw_org_url and os.environ.get('AZURE_DEVOPS_PAT'))
    }), 200

@app.route('/api/devops-info', methods=['GET'])
def get_devops_info():
    """Returns all projects with their repositories and build/release pipelines."""
    force_refresh = request.args.get('refresh', '').lower() == 'true'
    cache_key = 'devops-info-v2'
    max_age_sec = 600  # 10 minutes cache
    if not force_refresh:
        cache_data, cache_time = get_cache(cache_key)
        if cache_data:
            try:
                cache_dt = dtparser.parse(cache_time)
                if cache_dt.tzinfo is None:
                    cache_dt = cache_dt.replace(tzinfo=timezone.utc)
                if (datetime.now(timezone.utc) - cache_dt).total_seconds() < max_age_sec:
                    return jsonify(json.loads(cache_data))
            except Exception:
                pass

    org_url = get_devops_org_url()
    org_name = get_devops_org_name()
    pat = get_devops_pat()

    try:
        credentials = BasicAuthentication('', pat)
        connection = Connection(base_url=org_url, creds=credentials)
        core_client = connection.clients.get_core_client()
        git_client = connection.clients.get_git_client()
        release_client = connection.clients.get_release_client()
        build_client = connection.clients.get_build_client()

        projects = core_client.get_projects()

        def fetch_project_details(project):
            project_info = {
                "project_id": project.id,
                "project_name": project.name,
                "repositories": [],
                "build_pipelines": [],
                "release_pipelines": []
            }

            try:
                repos = git_client.get_repositories(project=project.id)
                project_info["repositories"] = [repo.name for repo in repos]
            except Exception as e_repo:
                app.logger.warning(f"Error fetching repos for {project.name}: {e_repo}")

            try:
                build_definitions = build_client.get_definitions(project=project.id)
                project_info["build_pipelines"] = [b.name for b in build_definitions]
            except Exception as e_build:
                app.logger.warning(f"Error fetching builds for {project.name}: {e_build}")

            try:
                release_definitions = release_client.get_release_definitions(project=project.id)
                project_info["release_pipelines"] = [r.name for r in release_definitions]
            except Exception as e_rel:
                app.logger.warning(f"Error fetching releases for {project.name}: {e_rel}")

            return project_info

        projects_data = []
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = executor.map(fetch_project_details, projects)
            for res in results:
                projects_data.append(res)

        response_data = {
            "org_name": org_name,
            "org_url": org_url,
            "projects": projects_data
        }
        set_cache(cache_key, json.dumps(response_data))
        return jsonify(response_data)
    except Exception as e:
        app.logger.error(f"Error in /api/devops-info: {e}", exc_info=True)
        return jsonify({"error": str(e), "org_name": org_name, "org_url": org_url, "projects": []}), 500

@app.route('/api/my-work-items', methods=['GET'])
def get_my_work_items():
    """Fetches open work items (Tasks, Bugs, Stories) assigned to @Me across all projects."""
    try:
        org_url = get_devops_org_url()
        wiql_url = f"{org_url}/_apis/wit/wiql?api-version=7.1"
        query = {
            "query": (
                "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], "
                "[System.TeamProject], [System.AssignedTo], [System.ChangedDate] "
                "FROM WorkItems "
                "WHERE [System.AssignedTo] = @Me "
                "AND [System.State] NOT IN ('Closed', 'Completed', 'Resolved', 'Done', 'Removed') "
                "ORDER BY [System.ChangedDate] DESC"
            )
        }
        resp = requests.post(wiql_url, headers=get_headers(), json=query, timeout=15)
        resp.raise_for_status()
        wi_data = resp.json()
        work_items_refs = wi_data.get("workItems", [])

        if not work_items_refs:
            return jsonify({"work_items": [], "count": 0}), 200

        # Batch get work item details (up to 100 items)
        ids = [str(w["id"]) for w in work_items_refs[:100]]
        ids_str = ",".join(ids)
        details_url = f"{org_url}/_apis/wit/workitems?ids={ids_str}&$expand=fields&api-version=7.1"
        details_resp = requests.get(details_url, headers=get_headers(), timeout=15)
        details_resp.raise_for_status()
        details_data = details_resp.json().get("value", [])

        result = []
        for item in details_data:
            fields = item.get("fields", {})
            item_id = item.get("id")
            project = fields.get("System.TeamProject", "Unknown")
            html_url = item.get("_links", {}).get("html", {}).get("href")
            if not html_url:
                html_url = f"{org_url}/{project}/_workitems/edit/{item_id}"

            assigned_obj = fields.get("System.AssignedTo", {})
            assigned_name = assigned_obj.get("displayName", "") if isinstance(assigned_obj, dict) else str(assigned_obj)

            result.append({
                "id": item_id,
                "title": fields.get("System.Title", ""),
                "type": fields.get("System.WorkItemType", "Task"),
                "state": fields.get("System.State", "Active"),
                "project": project,
                "assignedTo": assigned_name,
                "changedDate": fields.get("System.ChangedDate", ""),
                "url": html_url
            })

        return jsonify({"work_items": result, "count": len(result)}), 200
    except Exception as e:
        app.logger.error(f"Error fetching work items: {e}", exc_info=True)
        return jsonify({"error": str(e), "work_items": [], "count": 0}), 500

def _get_pr_current_user():
    if sync_service.is_fixture_mode():
        return {
            "id": "00000000-0000-0000-0000-000000000001",
            "displayName": "Fixture User",
            "uniqueName": "fixture.user@devopsflow.local"
        }
    user = get_current_user_info() or {}
    subject_descriptor = user.get("subjectDescriptor")
    if subject_descriptor:
        groups = pr_service.fetch_user_group_ids(get_devops_org_name(), subject_descriptor, get_headers())
        user["groupIds"] = groups["groupIds"]
        user["groupMembershipStatus"] = groups["status"]
        if groups.get("error"):
            user["groupMembershipError"] = groups["error"]
    else:
        user["groupIds"] = []
        user["groupMembershipStatus"] = "unavailable"
        user["groupMembershipError"] = {"kind": "identity_unavailable"}
    return user

def _load_all_prs(force_refresh=False):
    if sync_service.is_fixture_mode():
        return pr_service.build_fixture_prs()
    org_url = get_devops_org_url()
    pat = get_devops_pat()
    return pr_service.sync_live_pull_requests(org_url, pat, force_refresh=force_refresh, include_cache_status=True)


def _pr_sync_failed_without_cache(sync_data):
    if not isinstance(sync_data, dict):
        return False
    status = sync_data.get("cacheStatus", {})
    return status.get("outcome") in {"failed", "partial"} and not sync_data.get("items") and not status.get("hasSnapshot", False)

@app.route('/api/my-pull-requests', methods=['GET'])
def get_my_pull_requests():
    """Fetches active pull requests across all projects, identifying PRs where user is reviewer or author (legacy UI compatibility)."""
    try:
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        current_user = _get_pr_current_user()
        sync_data = _load_all_prs(force_refresh=force_refresh)
        if _pr_sync_failed_without_cache(sync_data):
            return jsonify({"error": "Pull requests could not be refreshed", "items": [], "total": 0, "cacheStatus": sync_data.get("cacheStatus")}), 503
        all_prs = sync_data["items"] if isinstance(sync_data, dict) else sync_data

        # Annotate with personal flags
        annotated = [pr_service.evaluate_pr_personal_flags(p, current_user) for p in all_prs]
        active_prs = [p for p in annotated if p.get("status") == "active"]

        pending_my_review = [p for p in active_prs if p["needsMyReview"]]
        reviewed_by_me = [p for p in active_prs if p["hasReviewed"]]
        assigned_to_me = [p for p in active_prs if p["isReviewer"]]
        created_by_me = [p for p in active_prs if p["isAuthor"]]

        return jsonify({
            "all_prs": active_prs,
            "pending_my_review": pending_my_review,
            "reviewed_by_me": reviewed_by_me,
            "assigned_to_me": assigned_to_me,
            "created_by_me": created_by_me,
            "counts": {
                "pending_my_review": len(pending_my_review),
                "reviewed_by_me": len(reviewed_by_me),
                "assigned_to_me": len(assigned_to_me),
                "created_by_me": len(created_by_me),
                "total_active": len(active_prs)
            },
            "current_user": current_user,
            "cacheStatus": sync_data.get("cacheStatus") if isinstance(sync_data, dict) else None
        }), 200
    except Exception as e:
        app.logger.error(f"Error in get_my_pull_requests: {e}", exc_info=True)
        return jsonify({"error": str(e), "all_prs": [], "assigned_to_me": [], "created_by_me": []}), 500

@app.route('/api/pull-requests', methods=['GET'])
def get_pull_requests():
    """Lists pull requests with server-side pagination, filters, and personal status."""
    try:
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        current_user = _get_pr_current_user()
        sync_data = _load_all_prs(force_refresh=force_refresh)
        if _pr_sync_failed_without_cache(sync_data):
            return jsonify({"error": "Pull requests could not be refreshed", "items": [], "total": 0, "cacheStatus": sync_data.get("cacheStatus")}), 503
        all_prs = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        result = pr_service.query_pull_requests(all_prs, request.args, current_user=current_user)
        result["reviewerIdentityStatus"] = {
            "groupMembership": current_user.get("groupMembershipStatus", "unavailable"),
            "error": current_user.get("groupMembershipError")
        }
        if isinstance(sync_data, dict):
            result["cacheStatus"] = sync_data.get("cacheStatus")
            result["lastSyncedAt"] = sync_data.get("cacheStatus", {}).get("lastSyncedAt")
        return jsonify(result), 200
    except Exception as e:
        app.logger.error(f"Error in get_pull_requests: {e}", exc_info=True)
        return jsonify({"error": str(e), "items": [], "total": 0}), 500

@app.route('/api/pull-requests/summary', methods=['GET'])
def get_pull_requests_summary():
    """Lightweight aggregate summary of PR metrics for Dashboard overview."""
    try:
        project = request.args.get('project', 'all')
        current_user = _get_pr_current_user()
        sync_data = _load_all_prs()
        if _pr_sync_failed_without_cache(sync_data):
            return jsonify({"error": "Pull requests could not be refreshed", "needsMyReview": 0, "createdByMe": 0, "involved": 0, "totalActive": 0, "cacheStatus": sync_data.get("cacheStatus")}), 503
        all_prs = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        summary = pr_service.get_pr_summary(all_prs, project=project, current_user=current_user)
        summary["reviewerIdentityStatus"] = {
            "groupMembership": current_user.get("groupMembershipStatus", "unavailable"),
            "error": current_user.get("groupMembershipError")
        }
        if isinstance(sync_data, dict):
            summary["cacheStatus"] = sync_data.get("cacheStatus")
            summary["lastSyncedAt"] = sync_data.get("cacheStatus", {}).get("lastSyncedAt")
            summary["lastSyncedAt"] = sync_data.get("cacheStatus", {}).get("lastSyncedAt") or summary.get("lastSyncedAt")
        return jsonify(summary), 200
    except Exception as e:
        app.logger.error(f"Error in get_pull_requests_summary: {e}", exc_info=True)
        return jsonify({"error": str(e), "needsMyReview": 0, "createdByMe": 0, "involved": 0, "totalActive": 0}), 500

@app.route('/api/pull-requests/<int:pr_id>', methods=['GET'])
def get_pull_request_by_id(pr_id):
    """Detailed view for a single PR."""
    try:
        current_user = _get_pr_current_user()
        sync_data = _load_all_prs()
        if _pr_sync_failed_without_cache(sync_data):
            return jsonify({"error": "Pull requests could not be refreshed", "cacheStatus": sync_data.get("cacheStatus")}), 503
        all_prs = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        pr = pr_service.get_single_pr_details(all_prs, pr_id, current_user=current_user)
        if not pr:
            return jsonify({"error": f"Pull request #{pr_id} not found"}), 404
        return jsonify(pr), 200
    except Exception as e:
        app.logger.error(f"Error in get_pull_request_by_id: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

def _load_all_team_activity(days=30, force_refresh=False):
    if sync_service.is_fixture_mode():
        return team_service.build_fixture_team_activity()
    org_url = get_devops_org_url()
    pat = get_devops_pat()
    return team_service.sync_live_team_activity(org_url, pat, days=days, force_refresh=force_refresh)

def _validated_days():
    """Parse the shared positive-integer days query parameter."""
    try:
        days = int(request.args.get('days', 30))
    except (TypeError, ValueError):
        return None, "days must be a positive integer"
    if days < 1:
        return None, "days must be a positive integer"
    return days, None

@app.route('/api/team-activity', methods=['GET'])
def get_team_activity():
    """Calculates top committers, top PR authors, top reviewers, and project activity (supports legacy & modern UI)."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        data = _load_all_team_activity(days=days, force_refresh=force_refresh)
        commits = data["commits"]
        prs = data["pullRequests"]
        summary = team_service.compute_team_summary(commits, prs, days=days)

        top_committers = [
            {"name": c["name"], "count": c["commitCount"]}
            for c in sorted(summary["contributors"], key=lambda x: x["commitCount"], reverse=True)[:10]
            if c["commitCount"] > 0
        ]
        top_pr_authors = [
            {"name": c["name"], "count": c["authoredPRs"]}
            for c in sorted(summary["contributors"], key=lambda x: x["authoredPRs"], reverse=True)[:10]
            if c["authoredPRs"] > 0
        ]
        top_reviewers = [
            {"name": c["name"], "count": c["reviewsCount"]}
            for c in sorted(summary["contributors"], key=lambda x: x["reviewsCount"], reverse=True)[:10]
            if c["reviewsCount"] > 0
        ]
        project_activity = [
            {"project": r["project"], "commits": r["commitCount"]}
            for r in summary["repositories"][:10]
        ]
        recent_commits = [
            {
                "id": c["commitId"][:8],
                "comment": (c["comment"] or "").split('\n')[0][:80],
                "author": c["author"],
                "date": c["date"],
                "project": c["project"],
                "repository": c["repository"],
                "url": c.get("url", "")
            }
            for c in commits[:15]
        ]

        return jsonify({
            # Legacy UI compatibility
            "period_days": days,
            "total_commits": summary["totalCommits"],
            "total_prs": summary["totalPRs"],
            "contributors_count": summary["activeContributors"],
            "top_committers": top_committers,
            "top_pr_authors": top_pr_authors,
            "top_reviewers": top_reviewers,
            "project_activity": project_activity,
            "recent_commits": recent_commits,
            "daily_stats": summary["dailyStats"],

            # Modern UI enriched fields
            "summary": summary,
            "contributors": summary["contributors"],
            "repositories": summary["repositories"],
            "totalCommits": summary["totalCommits"],
            "totalPRs": summary["totalPRs"],
            "activeContributors": summary["activeContributors"],
            "cacheStatus": _team_activity_cache_status(data)
        }), 200
    except Exception as e:
        app.logger.error(f"Error in get_team_activity: {e}", exc_info=True)
        return jsonify({"error": str(e), "total_commits": 0, "total_prs": 0, "contributors_count": 0}), 500

@app.route('/api/team-activity/summary', methods=['GET'])
def get_team_activity_summary():
    """Returns team activity summary, daily trend and top metrics."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        project = request.args.get('project')
        repository = request.args.get('repository')
        data = _load_all_team_activity(days=days, force_refresh=force_refresh)
        summary = team_service.compute_team_summary(data["commits"], data["pullRequests"], days=days, project=project, repository=repository)
        return jsonify({**summary, "cacheStatus": _team_activity_cache_status(data)}), 200
    except Exception as e:
        app.logger.error(f"Error in get_team_activity_summary: {e}", exc_info=True)
        return jsonify({"error": str(e), "totalCommits": 0, "activeContributors": 0}), 500

@app.route('/api/team-activity/contributors', methods=['GET'])
def get_team_activity_contributors():
    """Returns paginated, searchable and sorted contributors."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        data = _load_all_team_activity(days=days, force_refresh=force_refresh)
        res = team_service.query_contributors(data["commits"], data["pullRequests"], request.args)
        return jsonify({**res, "cacheStatus": _team_activity_cache_status(data)}), 200
    except Exception as e:
        app.logger.error(f"Error in get_team_activity_contributors: {e}", exc_info=True)
        return jsonify({"error": str(e), "items": [], "total": 0}), 500

@app.route('/api/team-activity/commits', methods=['GET'])
def get_team_activity_commits():
    """Returns paginated commit timeline with project, repo and contributor filters."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        data = _load_all_team_activity(days=days, force_refresh=force_refresh)
        res = team_service.query_commits(data["commits"], request.args)
        return jsonify({**res, "cacheStatus": _team_activity_cache_status(data)}), 200
    except Exception as e:
        app.logger.error(f"Error in get_team_activity_commits: {e}", exc_info=True)
        return jsonify({"error": str(e), "items": [], "total": 0}), 500

@app.route('/api/team-activity/repositories', methods=['GET'])
def get_team_activity_repositories():
    """Returns repository-level commit and PR activity."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        project = request.args.get('project')
        data = _load_all_team_activity(days=days, force_refresh=force_refresh)
        repos = team_service.compute_repository_activity(data["commits"], data["pullRequests"], project=project)
        return jsonify({"repositories": repos, "total": len(repos), "cacheStatus": _team_activity_cache_status(data)}), 200
    except Exception as e:
        app.logger.error(f"Error in get_team_activity_repositories: {e}", exc_info=True)
        return jsonify({"error": str(e), "repositories": []}), 500

def _load_all_pipelines(days=30, force_refresh=False):
    if sync_service.is_fixture_mode():
        return pipeline_service.build_fixture_pipelines()
    org_url = get_devops_org_url()
    pat = get_devops_pat()
    return pipeline_service.sync_live_pipeline_runs(org_url, pat, days=days, force_refresh=force_refresh, include_cache_status=True)

def _load_all_deployments(days=30, force_refresh=False):
    if sync_service.is_fixture_mode():
        return deployment_service.build_fixture_deployments()
    org_url = get_devops_org_url()
    org_name = get_devops_org_name()
    pat = get_devops_pat()
    return deployment_service.sync_live_deployments(org_url, org_name, pat, days=days, force_refresh=force_refresh, include_cache_status=True)

@app.route('/api/pipeline-health', methods=['GET'])
def get_pipeline_health():
    """Fetches recent build pipeline runs (legacy UI backward compatibility)."""
    days, days_error = _validated_days()
    if days_error:
        return jsonify({"error": "days must be one of: 7, 14, 30, 90"}), 400
    if days not in {7, 14, 30, 90}:
        return jsonify({"error": "days must be one of: 7, 14, 30, 90"}), 400

    try:
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        sync_data = _load_all_pipelines(days=days, force_refresh=force_refresh)
        all_runs = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        summary = pipeline_service.compute_pipeline_summary(all_runs, days=days)

        recent_builds = [
            {
                "id": r["id"],
                "buildNumber": r["buildNumber"],
                "pipelineName": r["pipelineName"],
                "projectName": r["project"],
                "status": r["status"],
                "result": r["result"],
                "branch": r["sourceBranch"],
                "requestedFor": r["requestedBy"],
                "finishTime": r["finishTime"],
                "url": r["url"]
            }
            for r in all_runs[:15]
        ]

        failed_builds = [
            {
                "id": r["id"],
                "buildNumber": r["buildNumber"],
                "pipelineName": r["pipelineName"],
                "projectName": r["project"],
                "status": r["status"],
                "result": r["result"],
                "branch": r["sourceBranch"],
                "requestedFor": r["requestedBy"],
                "finishTime": r["finishTime"],
                "url": r["url"]
            }
            for r in summary["failedRuns"][:20]
        ]

        return jsonify({
            "period_days": days,
            "total_runs": summary["totalRuns"],
            "succeeded": summary["succeeded"],
            "failed": summary["failed"],
            "partially_succeeded": summary["partiallySucceeded"],
            "in_progress": summary["inProgress"],
            "canceled": summary["canceled"],
            "success_rate": summary["successRate"],
            "failed_builds": failed_builds,
            "recent_builds": recent_builds,
            "daily_stats": summary["dailyStats"],
            "cacheStatus": sync_data.get("cacheStatus") if isinstance(sync_data, dict) else None
        }), 200
    except Exception as e:
        app.logger.error(f"Error in get_pipeline_health: {e}", exc_info=True)
        return jsonify({"error": str(e), "total_runs": 0, "success_rate": 100.0, "failed_builds": [], "daily_stats": []}), 500

@app.route('/api/pipelines', methods=['GET'])
def get_pipelines():
    """Returns pipeline definitions and grouped run status."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        sync_data = _load_all_pipelines(days=days, force_refresh=force_refresh)
        all_runs = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        res = pipeline_service.query_pipeline_runs(all_runs, request.args)
        if isinstance(sync_data, dict):
            res["cacheStatus"] = sync_data.get("cacheStatus")
        return jsonify(res), 200
    except Exception as e:
        app.logger.error(f"Error in get_pipelines: {e}", exc_info=True)
        return jsonify({"error": str(e), "items": [], "total": 0}), 500

@app.route('/api/pipelines/summary', methods=['GET'])
def get_pipelines_summary():
    """Summary metrics (success rate, counts, daily breakdown)."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        sync_data = _load_all_pipelines(days=days, force_refresh=force_refresh)
        all_runs = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        project = request.args.get('project')
        if project and project != 'all':
            all_runs = [r for r in all_runs if r["project"].lower() == project.lower()]
        summary = pipeline_service.compute_pipeline_summary(all_runs, days=days)
        if isinstance(sync_data, dict):
            summary["cacheStatus"] = sync_data.get("cacheStatus")
        return jsonify(summary), 200
    except Exception as e:
        app.logger.error(f"Error in get_pipelines_summary: {e}", exc_info=True)
        return jsonify({"error": str(e), "totalRuns": 0, "successRate": 100.0}), 500

@app.route('/api/pipelines/runs', methods=['GET'])
def get_pipeline_runs():
    """Paginated list of pipeline runs with filters."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        sync_data = _load_all_pipelines(days=days, force_refresh=force_refresh)
        all_runs = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        res = pipeline_service.query_pipeline_runs(all_runs, request.args)
        if isinstance(sync_data, dict):
            res["cacheStatus"] = sync_data.get("cacheStatus")
        return jsonify(res), 200
    except Exception as e:
        app.logger.error(f"Error in get_pipeline_runs: {e}", exc_info=True)
        return jsonify({"error": str(e), "items": [], "total": 0}), 500

@app.route('/api/pipelines/runs/<int:run_id>', methods=['GET'])
def get_pipeline_run_by_id(run_id):
    """Detailed information for a single pipeline run."""
    try:
        all_runs = _load_all_pipelines(days=30)
        project = request.args.get('project')
        run = pipeline_service.get_single_run_details(all_runs, run_id, project=project)
        if not run:
            return jsonify({"error": f"Pipeline run #{run_id} not found"}), 404
        return jsonify(run), 200
    except Exception as e:
        app.logger.error(f"Error in get_pipeline_run_by_id: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/api/deployment-metrics', methods=['GET'])
def get_deployment_metrics():
    """Legacy UI compatibility for deployment metrics."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        sync_data = _load_all_deployments(days=days, force_refresh=force_refresh)
        all_deps = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        summary = deployment_service.compute_deployment_summary(all_deps, days=days)

        env_counts = {
            "Production": {"succeeded": 0, "failed": 0, "total": 0},
            "Staging": {"succeeded": 0, "failed": 0, "total": 0},
            "Test": {"succeeded": 0, "failed": 0, "total": 0},
            "Development": {"succeeded": 0, "failed": 0, "total": 0},
        }
        for e in summary["environments"]:
            name = e["name"]
            matched = "Development"
            lower = name.lower()
            if "prod" in lower or "canlı" in lower:
                matched = "Production"
            elif "stag" in lower or "pre" in lower or "uat" in lower:
                matched = "Staging"
            elif "test" in lower or "qa" in lower:
                matched = "Test"
            env_counts[matched]["succeeded"] += e["succeeded"]
            env_counts[matched]["failed"] += e["failed"]
            env_counts[matched]["total"] += e["total"]

        chart_data = [
            {"environment": "Test", "succeeded": env_counts["Test"]["succeeded"], "failed": env_counts["Test"]["failed"], "total": env_counts["Test"]["total"]},
            {"environment": "Staging", "succeeded": env_counts["Staging"]["succeeded"], "failed": env_counts["Staging"]["failed"], "total": env_counts["Staging"]["total"]},
            {"environment": "Production", "succeeded": env_counts["Production"]["succeeded"], "failed": env_counts["Production"]["failed"], "total": env_counts["Production"]["total"]},
            {"environment": "Development", "succeeded": env_counts["Development"]["succeeded"], "failed": env_counts["Development"]["failed"], "total": env_counts["Development"]["total"]},
        ]

        recent_deployments = [
            {
                "id": d["id"],
                "project": d["project"],
                "release": d["releaseName"],
                "environment": d["environmentName"],
                "targetCategory": "Production" if "prod" in d["environmentName"].lower() else "Staging" if "stag" in d["environmentName"].lower() else "Test" if "test" in d["environmentName"].lower() else "Development",
                "status": d["status"],
                "completedOn": d["completedOn"]
            }
            for d in all_deps[:10]
        ]

        return jsonify({
            "total_deployments": summary["totalDeployments"],
            "deployment_frequency": round(summary["totalDeployments"] / max(1, days), 2),
            "chart_data": chart_data,
            "recent_deployments": recent_deployments,
            "cacheStatus": sync_data.get("cacheStatus") if isinstance(sync_data, dict) else None
        }), 200
    except Exception as e:
        app.logger.error(f"Error in get_deployment_metrics: {e}", exc_info=True)
        return jsonify({"total_deployments": 0, "deployment_frequency": 0, "chart_data": [], "recent_deployments": []}), 500

@app.route('/api/deployments', methods=['GET'])
def get_deployments():
    """List of deployment records with filters and pagination."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        sync_data = _load_all_deployments(days=days, force_refresh=force_refresh)
        all_deps = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        res = deployment_service.query_deployments(all_deps, request.args)
        if isinstance(sync_data, dict):
            res["cacheStatus"] = sync_data.get("cacheStatus")
            res["lastSyncedAt"] = sync_data.get("cacheStatus", {}).get("lastSyncedAt")
        return jsonify(res), 200
    except Exception as e:
        app.logger.error(f"Error in get_deployments: {e}", exc_info=True)
        return jsonify({"error": str(e), "items": [], "total": 0}), 500

@app.route('/api/deployments/summary', methods=['GET'])
def get_deployments_summary():
    """Deployment summary metrics (environment breakdown, success rates)."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        sync_data = _load_all_deployments(days=days, force_refresh=force_refresh)
        all_deps = sync_data["items"] if isinstance(sync_data, dict) else sync_data
        project = request.args.get('project')
        if project and project != 'all':
            all_deps = [d for d in all_deps if d["project"].lower() == project.lower()]
        summary = deployment_service.compute_deployment_summary(all_deps, days=days)
        if isinstance(sync_data, dict):
            summary["cacheStatus"] = sync_data.get("cacheStatus")
            summary["lastSyncedAt"] = sync_data.get("cacheStatus", {}).get("lastSyncedAt")
        return jsonify(summary), 200
    except Exception as e:
        app.logger.error(f"Error in get_deployments_summary: {e}", exc_info=True)
        return jsonify({"error": str(e), "totalDeployments": 0, "successRate": 100.0}), 500

@app.route('/api/deployments/<int:dep_id>', methods=['GET'])
def get_deployment_by_id(dep_id):
    """Details for a single deployment."""
    try:
        all_deps = _load_all_deployments(days=30)
        project = request.args.get('project')
        dep = deployment_service.get_single_deployment_details(all_deps, dep_id, project=project)
        if not dep:
            return jsonify({"error": f"Deployment #{dep_id} not found"}), 404
        return jsonify(dep), 200
    except Exception as e:
        app.logger.error(f"Error in get_deployment_by_id: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/api/project-work-item-stats', methods=['GET'])
def get_project_work_item_stats():
    """Returns active work item counts (Total, Bugs, Tasks) per project across the organization."""
    try:
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        cache_key = 'project-work-items-summary-v1'
        max_age_sec = 600

        if not force_refresh:
            cache_data, cache_time = get_cache(cache_key)
            if cache_data:
                try:
                    cache_dt = dtparser.parse(cache_time)
                    if cache_dt.tzinfo is None:
                        cache_dt = cache_dt.replace(tzinfo=timezone.utc)
                    if (datetime.now(timezone.utc) - cache_dt).total_seconds() < max_age_sec:
                        return jsonify(json.loads(cache_data)), 200
                except Exception:
                    pass

        org_url = get_devops_org_url()
        wiql_url = f"{org_url}/_apis/wit/wiql?api-version=7.1"
        query = {
            "query": (
                "SELECT [System.Id], [System.TeamProject], [System.WorkItemType] "
                "FROM WorkItems "
                "WHERE [System.State] NOT IN ('Closed', 'Completed', 'Resolved', 'Done', 'Removed') "
                "ORDER BY [System.ChangedDate] DESC"
            )
        }
        resp = requests.post(wiql_url, headers=get_headers(), json=query, timeout=15)
        resp.raise_for_status()
        wi_data = resp.json()
        work_items_refs = wi_data.get("workItems", [])

        ids = [str(w["id"]) for w in work_items_refs[:300]]
        stats_by_project = {}

        if ids:
            ids_str = ",".join(ids)
            details_url = f"{org_url}/_apis/wit/workitems?ids={ids_str}&fields=System.TeamProject,System.WorkItemType&api-version=7.1"
            details_resp = requests.get(details_url, headers=get_headers(), timeout=15)
            if details_resp.status_code == 200:
                for item in details_resp.json().get("value", []):
                    fields = item.get("fields", {})
                    proj = fields.get("System.TeamProject", "Unknown")
                    w_type = fields.get("System.WorkItemType", "Task")

                    if proj not in stats_by_project:
                        stats_by_project[proj] = {"total": 0, "bugs": 0, "tasks": 0}

                    stats_by_project[proj]["total"] += 1
                    if "bug" in w_type.lower():
                        stats_by_project[proj]["bugs"] += 1
                    else:
                        stats_by_project[proj]["tasks"] += 1

        res = {
            "total_active_work_items": len(work_items_refs),
            "stats_by_project": stats_by_project
        }
        set_cache(cache_key, json.dumps(res))
        return jsonify(res), 200
    except Exception as e:
        app.logger.error(f"Error in get_project_work_item_stats: {e}", exc_info=True)
        return jsonify({"total_active_work_items": 0, "stats_by_project": {}}), 500

def _load_all_history(days=30, force_refresh=False):
    if sync_service.is_fixture_mode():
        return history_service.build_fixture_history("Fixture User")
    org_url = get_devops_org_url()
    pat = get_devops_pat()
    user_info = get_current_user_info() or {}
    return history_service.sync_live_history(org_url, pat, user_info, days=days, force_refresh=force_refresh)

@app.route('/api/my-history', methods=['GET'])
def get_my_history():
    """Fetches user's historical contributions: completed work items, merged PRs, reviewed PRs, commits, and activity heatmap."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        user_info = get_current_user_info() or {}
        user_name = user_info.get("displayName") or "Fixture User"

        history_data = _load_all_history(days=days, force_refresh=force_refresh)
        events = history_data["events"]
        summary = history_service.compute_history_summary(events, days=days)
        timeline_groups = history_service.group_events_by_timeline(events)

        # Legacy UI compatibility structures
        completed_work_items = [
            {
                "id": e["entity"]["id"],
                "title": e["entity"]["title"],
                "type": "Task",
                "state": "Closed",
                "project": e["project"],
                "closedDate": e["occurredAt"],
                "isBug": "bug" in e["entity"]["title"].lower(),
                "url": e["url"]
            }
            for e in events if e["entity"]["type"] == "workItem"
        ]
        merged_prs = [
            {
                "id": e["entity"]["id"],
                "title": e["entity"]["title"],
                "project": e["project"],
                "repository": e["entity"].get("repository", ""),
                "closedDate": e["occurredAt"],
                "url": e["url"]
            }
            for e in events if e["eventType"] == "git.pullRequest.merged"
        ]
        reviewed_prs = [
            {
                "id": e["entity"]["id"],
                "title": e["entity"]["title"],
                "project": e["project"],
                "repository": e["entity"].get("repository", ""),
                "closedDate": e["occurredAt"],
                "url": e["url"],
                "voteLabel": "Onaylandı"
            }
            for e in events if e["eventType"] == "git.pullRequest.reviewed"
        ]
        user_commits = [
            {
                "id": str(e["entity"]["id"])[:8],
                "comment": e["entity"]["title"],
                "date": e["occurredAt"],
                "project": e["project"],
                "repository": e["entity"].get("repository", ""),
                "url": e["url"]
            }
            for e in events if e["entity"]["type"] == "commit"
        ]

        daily_activity = [
            {"date": d["date"], "count": d["count"], "commits": d["commits"], "work_items": d["workItems"], "prs": d["prs"]}
            for d in summary["dailyHeatmap"]
        ]

        legacy_timeline = [
            {
                "id": e["id"],
                "eventType": "work_item" if e["entity"]["type"] == "workItem" else "commit" if e["entity"]["type"] == "commit" else "pr_merged" if e["eventType"] == "git.pullRequest.merged" else "pr_reviewed",
                "badge": "Tamamlandı" if e["entity"]["type"] == "workItem" else str(e["entity"]["id"])[:8] if e["entity"]["type"] == "commit" else "PR",
                "title": e["entity"]["title"],
                "project": e["project"],
                "subtitle": e["summary"],
                "date": e["occurredAt"],
                "url": e["url"]
            }
            for e in events
        ]

        return jsonify({
            # Legacy fields
            "period_days": days,
            "user_name": user_name,
            "summary": {
                "total_completed_work_items": summary["completedWorkItems"],
                "bugs_resolved": 0,
                "tasks_completed": summary["completedWorkItems"],
                "prs_merged": summary["prsCount"],
                "prs_reviewed": summary["reviewsCount"],
                "total_commits": summary["commitsCount"],
                "active_projects_count": len(summary["projectsTouched"])
            },
            "summary_by_project": {},
            "daily_activity": daily_activity,
            "projects_touched": summary["projectsTouched"],
            "timeline": legacy_timeline[:500],

            # Modern fields
            "events": events,
            "timelineGroups": timeline_groups,
            "metrics": summary
        }), 200
    except Exception as e:
        app.logger.error(f"Error in get_my_history: {e}", exc_info=True)
        return jsonify({"error": str(e), "timeline": [], "daily_activity": []}), 500

@app.route('/api/my-history/summary', methods=['GET'])
def get_my_history_summary():
    """Returns user's contribution metrics and activity heatmap."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        project = request.args.get('project', 'all')
        activity_type = request.args.get('activityType', request.args.get('eventType', 'all'))
        search = request.args.get('search', '')
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        data = _load_all_history(days=days, force_refresh=force_refresh)
        summary = history_service.compute_history_summary(
            data["events"], days=days, project=project, activity_type=activity_type, search=search
        )
        return jsonify(summary), 200
    except Exception as e:
        app.logger.error(f"Error in get_my_history_summary: {e}", exc_info=True)
        return jsonify({"error": str(e), "totalEvents": 0}), 500

@app.route('/api/my-history/timeline', methods=['GET'])
def get_my_history_timeline():
    """Returns paginated and filtered personal timeline events."""
    try:
        days, days_error = _validated_days()
        if days_error:
            return jsonify({"error": days_error}), 400
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        data = _load_all_history(days=days, force_refresh=force_refresh)
        res = history_service.query_history_events(data["events"], request.args)
        return jsonify(res), 200
    except Exception as e:
        app.logger.error(f"Error in get_my_history_timeline: {e}", exc_info=True)
        return jsonify({"error": str(e), "items": [], "total": 0}), 500

@app.route('/api/my-history/<path:event_id>', methods=['GET'])
def get_my_history_event_by_id(event_id):
    """Retrieves details for a single personal activity event."""
    try:
        data = _load_all_history(days=30)
        for e in data["events"]:
            if e["id"] == event_id:
                return jsonify(e), 200
        return jsonify({"error": f"History event {event_id} not found"}), 404
    except Exception as e:
        app.logger.error(f"Error in get_my_history_event_by_id: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/api/work-items-pool', methods=['GET'])
def get_work_items_pool():
    """Fetches all active work items across projects, identifies unassigned items, and organizes them into a hierarchy (PBI / Feature / User Story / Bug -> Child Tasks)."""
    try:
        force_refresh = request.args.get('refresh', '').lower() == 'true'
        project_filter = request.args.get('project', '').strip()
        cache_key = f'work-items-pool-v1-{project_filter or "all"}'
        max_age_sec = 180  # 3 minutes cache

        # Preferred path: serve the complete SQLite cache built by sync_service (no 200-item cut-off)
        if not force_refresh:
            cached_pool = sync_service.build_pool_from_cache(project_filter)
            if cached_pool is not None:
                return jsonify(cached_pool), 200

        if not force_refresh:
            cache_data, cache_time = get_cache(cache_key)
            if cache_data:
                try:
                    cache_dt = dtparser.parse(cache_time)
                    if cache_dt.tzinfo is None:
                        cache_dt = cache_dt.replace(tzinfo=timezone.utc)
                    if (datetime.now(timezone.utc) - cache_dt).total_seconds() < max_age_sec:
                        return jsonify(json.loads(cache_data)), 200
                except Exception:
                    pass

        org_url = get_devops_org_url()
        wiql_url = f"{org_url}/_apis/wit/wiql?api-version=7.1"

        where_clauses = [
            "[System.State] NOT IN ('Closed', 'Completed', 'Resolved', 'Done', 'Removed')"
        ]
        if project_filter:
            clean_proj = project_filter.replace("'", "''")
            where_clauses.append(f"[System.TeamProject] = '{clean_proj}'")

        query_str = (
            "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], "
            "[System.TeamProject], [System.AssignedTo], [System.ChangedDate] "
            "FROM WorkItems "
            f"WHERE {' AND '.join(where_clauses)} "
            "ORDER BY [System.ChangedDate] DESC"
        )

        resp = requests.post(wiql_url, headers=get_headers(), json={"query": query_str}, timeout=15)
        resp.raise_for_status()
        wi_data = resp.json()
        work_items_refs = wi_data.get("workItems", [])

        if not work_items_refs:
            res = {
                "summary": {
                    "total_items": 0,
                    "unassigned_total": 0,
                    "unassigned_tasks": 0,
                    "unassigned_bugs": 0,
                    "assigned_total": 0,
                    "pbi_count": 0,
                },
                "stats_by_project": {},
                "hierarchy": [],
                "flat_items": [],
                "projects": []
            }
            return jsonify(res), 200

        # Batch get work item details (up to 200 items) with relations expanded
        ids = [str(w["id"]) for w in work_items_refs[:200]]
        ids_str = ",".join(ids)
        details_url = (
            f"{org_url}/_apis/wit/workitems?ids={ids_str}"
            "&$expand=relations"
            "&api-version=7.1"
        )
        details_resp = requests.get(details_url, headers=get_headers(), timeout=15)
        details_resp.raise_for_status()
        details_data = details_resp.json().get("value", [])

        all_items_map = {}
        projects_set = set()
        unassigned_total = 0
        unassigned_tasks = 0
        unassigned_bugs = 0
        assigned_total = 0
        stats_by_project = {}

        # 1. First pass: parse all items and their relations
        for item in details_data:
            item_id = item.get("id")
            fields = item.get("fields", {})
            title = fields.get("System.Title", "")
            w_type = fields.get("System.WorkItemType", "Task")
            state = fields.get("System.State", "Active")
            proj = fields.get("System.TeamProject", "Unknown")
            parent_id = fields.get("System.Parent")
            changed_date = fields.get("System.ChangedDate", "")
            created_date = fields.get("System.CreatedDate", "")
            priority = fields.get("Microsoft.VSTS.Common.Priority")
            iteration = fields.get("System.IterationPath", "")

            assigned_obj = fields.get("System.AssignedTo")
            assigned_name = ""
            assigned_avatar = ""
            if assigned_obj:
                if isinstance(assigned_obj, dict):
                    assigned_name = assigned_obj.get("displayName", "")
                    assigned_avatar = assigned_obj.get("_links", {}).get("avatar", {}).get("href", "")
                else:
                    assigned_name = str(assigned_obj)

            is_unassigned = not bool(assigned_name.strip())
            is_bug = "bug" in w_type.lower()
            is_task = "task" in w_type.lower()

            if is_unassigned:
                unassigned_total += 1
                if is_bug:
                    unassigned_bugs += 1
                elif is_task:
                    unassigned_tasks += 1
            else:
                assigned_total += 1

            projects_set.add(proj)
            if proj not in stats_by_project:
                stats_by_project[proj] = {
                    "total": 0,
                    "unassigned": 0,
                    "unassigned_bugs": 0,
                    "unassigned_tasks": 0,
                    "assigned": 0
                }
            stats_by_project[proj]["total"] += 1
            if is_unassigned:
                stats_by_project[proj]["unassigned"] += 1
                if is_bug:
                    stats_by_project[proj]["unassigned_bugs"] += 1
                elif is_task:
                    stats_by_project[proj]["unassigned_tasks"] += 1
            else:
                stats_by_project[proj]["assigned"] += 1

            html_url = item.get("_links", {}).get("html", {}).get("href")
            if not html_url:
                html_url = f"{org_url}/{proj}/_workitems/edit/{item_id}"

            # Parse relations: Predecessor, Successor, Related
            predecessors = []
            successors = []
            related = []

            for rel in item.get("relations") or []:
                rel_type = rel.get("rel", "")
                rel_url = rel.get("url", "")
                attr = rel.get("attributes", {})
                rel_name = attr.get("name") or rel_type
                comment = attr.get("comment") or ""

                if "workItems/" in rel_url:
                    try:
                        target_id = int(rel_url.split("/")[-1])
                    except (ValueError, TypeError):
                        continue

                    rel_entry = {
                        "id": target_id,
                        "relType": "other",
                        "relName": rel_name,
                        "comment": comment,
                        "url": f"{org_url}/_workitems/edit/{target_id}"
                    }

                    if rel_type == "System.LinkTypes.Dependency-Reverse" or rel_name == "Predecessor":
                        rel_entry["relType"] = "predecessor"
                        rel_entry["relName"] = "Predecessor"
                        predecessors.append(rel_entry)
                    elif rel_type == "System.LinkTypes.Dependency-Forward" or rel_name == "Successor":
                        rel_entry["relType"] = "successor"
                        rel_entry["relName"] = "Successor"
                        successors.append(rel_entry)
                    elif rel_type == "System.LinkTypes.Related" or rel_name == "Related":
                        rel_entry["relType"] = "related"
                        rel_entry["relName"] = "Related"
                        related.append(rel_entry)
                    elif (rel_type == "System.LinkTypes.Hierarchy-Reverse" or rel_name == "Parent") and not parent_id:
                        parent_id = target_id

            all_items_map[item_id] = {
                "id": item_id,
                "title": title,
                "type": w_type,
                "state": state,
                "project": proj,
                "assignedTo": assigned_name,
                "assignedAvatar": assigned_avatar,
                "isUnassigned": is_unassigned,
                "isBug": is_bug,
                "isTask": is_task,
                "parentId": parent_id,
                "changedDate": changed_date,
                "createdDate": created_date,
                "priority": priority,
                "iteration": iteration,
                "url": html_url,
                "relations": {
                    "predecessors": predecessors,
                    "successors": successors,
                    "related": related,
                    "total": len(predecessors) + len(successors) + len(related)
                },
                "children": []
            }

        # 2. Enrich relation targets: fetch missing targets (e.g. Closed predecessor items)
        missing_target_ids = set()
        for item_obj in all_items_map.values():
            rels = item_obj.get("relations", {})
            for rel_cat in ["predecessors", "successors", "related"]:
                for r in rels.get(rel_cat, []):
                    tid = r["id"]
                    if tid not in all_items_map:
                        missing_target_ids.add(str(tid))
            pid = item_obj.get("parentId")
            if pid and pid not in all_items_map:
                missing_target_ids.add(str(pid))

        if missing_target_ids:
            try:
                m_ids_slice = list(missing_target_ids)[:100]
                m_url = f"{org_url}/_apis/wit/workitems?ids={','.join(m_ids_slice)}&fields=System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.TeamProject&api-version=7.1"
                m_res = requests.get(m_url, headers=get_headers(), timeout=10)
                if m_res.status_code == 200:
                    for m_item in m_res.json().get("value", []):
                        mid = m_item.get("id")
                        mf = m_item.get("fields", {})
                        m_assignee = mf.get("System.AssignedTo", {})
                        m_name = (m_assignee.get("displayName") if isinstance(m_assignee, dict) else str(m_assignee or "")) or ""
                        all_items_map[mid] = {
                            "id": mid,
                            "title": mf.get("System.Title", f"İş #{mid}"),
                            "type": mf.get("System.WorkItemType", "WorkItem"),
                            "state": mf.get("System.State", "Closed"),
                            "project": mf.get("System.TeamProject", ""),
                            "assignedTo": m_name,
                            "isUnassigned": not bool(m_name.strip()),
                            "url": f"{org_url}/_workitems/edit/{mid}",
                            "relations": {"predecessors": [], "successors": [], "related": [], "total": 0},
                            "children": []
                        }
            except Exception as ex:
                app.logger.warning(f"Error fetching missing relation targets: {ex}")

        # Populate relation metadata
        for item_id, item_obj in all_items_map.items():
            rels = item_obj.get("relations", {})
            for rel_cat in ["predecessors", "successors", "related"]:
                for r in rels.get(rel_cat, []):
                    tid = r["id"]
                    if tid in all_items_map:
                        target = all_items_map[tid]
                        r["title"] = target.get("title")
                        r["type"] = target.get("type")
                        r["state"] = target.get("state")
                        r["assignedTo"] = target.get("assignedTo")
                        r["isUnassigned"] = target.get("isUnassigned")
                        r["project"] = target.get("project")

        # 3. Third pass: organize hierarchy (only for items originally in pool, not pure relation targets)
        parent_items = []
        child_ids = set()

        for item in details_data:
            item_id = item.get("id")
            if item_id in all_items_map:
                item_obj = all_items_map[item_id]
                p_id = item_obj.get("parentId")
                if p_id and p_id in all_items_map:
                    all_items_map[p_id]["children"].append(item_obj)
                    child_ids.add(item_id)

        for item in details_data:
            item_id = item.get("id")
            if item_id in all_items_map and item_id not in child_ids:
                parent_items.append(all_items_map[item_id])

        for p in parent_items:
            p["children"].sort(key=lambda x: (not x["isUnassigned"], x["id"]))

        def get_parent_sort_score(p):
            unassigned_children = sum(1 for c in p.get("children", []) if c.get("isUnassigned"))
            is_self_unassigned = 1 if p.get("isUnassigned") else 0
            return (is_self_unassigned * 10) + unassigned_children

        parent_items.sort(key=get_parent_sort_score, reverse=True)

        # Merge full organization projects list so all 18 projects are available in filter
        try:
            for p in get_projects_data():
                pname = p.get("name")
                if pname:
                    projects_set.add(pname)
        except Exception as e_p:
            app.logger.warning(f"Could not fetch full projects list: {e_p}")

        res = {
            "summary": {
                "total_items": len(details_data),
                "total_active_in_org": len(work_items_refs),
                "unassigned_total": unassigned_total,
                "unassigned_tasks": unassigned_tasks,
                "unassigned_bugs": unassigned_bugs,
                "assigned_total": assigned_total,
                "pbi_count": len(parent_items),
            },
            "stats_by_project": stats_by_project,
            "hierarchy": parent_items,
            "flat_items": list(all_items_map.values()),
            "projects": sorted(list(projects_set))
        }

        set_cache(cache_key, json.dumps(res))
        return jsonify(res), 200
    except Exception as e:
        app.logger.error(f"Error in get_work_items_pool: {e}", exc_info=True)
        return jsonify({
            "error": str(e),
            "summary": {"total_items": 0, "unassigned_total": 0, "unassigned_tasks": 0, "unassigned_bugs": 0, "assigned_total": 0, "pbi_count": 0},
            "stats_by_project": {},
            "hierarchy": [],
            "flat_items": [],
            "projects": []
        }), 500

import sync_service
import fixture_data
import query_service
import pr_service
import pipeline_service
import deployment_service
import team_service
import history_service
from query_service import ParamError

def _no_store(payload, status=200):
    resp = jsonify(payload)
    resp.status_code = status
    resp.headers['Cache-Control'] = 'no-store'
    return resp

def _query_error(e, route):
    if isinstance(e, ParamError):
        return _no_store({"error": str(e)}, 400)
    app.logger.error(f"Error in {route}: {e}", exc_info=True)
    return _no_store({"error": "internal error"}, 500)

@app.errorhandler(ParamError)
def _handle_param_error(e):
    return _no_store({"error": str(e)}, 400)

@app.route('/api/work-items', methods=['GET'])
def get_work_items():
    """Paginated work items endpoint with server-side filtering and sorting (docs/pagination-api.md §1)."""
    try:
        params = query_service.parse_list_params(request.args)
        return _no_store(query_service.list_work_items(params))
    except Exception as e:
        return _query_error(e, 'get_work_items')

@app.route('/api/work-items/counts', methods=['GET'])
def get_work_items_counts():
    """Global organization counts across all work items."""
    try:
        current_user = request.args.get('currentUser', request.args.get('current_user', ''))
        counts = sync_service.get_counts(current_user=current_user)
        return jsonify(counts), 200
    except Exception as e:
        app.logger.error(f"Error in get_work_items_counts: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/api/work-items/summary', methods=['GET'])
def get_work_items_summary():
    """Sidebar/tab counters and facets over the same scope as the list (doc §2)."""
    try:
        result = query_service.summary(
            project=request.args.get('project', 'all'),
            current_user=request.args.get('currentUser', request.args.get('current_user', '')),
        )
        return _no_store(result)
    except Exception as e:
        return _query_error(e, 'get_work_items_summary')

@app.route('/api/work-items/progress', methods=['GET'])
def get_work_items_progress():
    """Canonical progress for the given ids over the full hierarchy (doc §4)."""
    try:
        raw = request.args.get('ids', '')
        ids = []
        for part in raw.split(','):
            part = part.strip()
            if not part:
                continue
            try:
                ids.append(int(part))
            except ValueError:
                raise ParamError('ids must be comma-separated integers')
        if not ids:
            raise ParamError('ids is required')
        return _no_store(query_service.progress_for(ids))
    except Exception as e:
        return _query_error(e, 'get_work_items_progress')

@app.route('/api/kanban', methods=['GET'])
def get_kanban():
    """Kanban board: column totals, swimlanes and first cardLimit cards per lane-column (doc §5)."""
    try:
        params = query_service.parse_list_params(request.args)
        return _no_store(query_service.kanban(params))
    except Exception as e:
        return _query_error(e, 'get_kanban')

@app.route('/api/me', methods=['GET'])
def get_me():
    try:
        if sync_service.is_fixture_mode():
            from fixture_data import FIXTURE_USER
            return _no_store({"displayName": FIXTURE_USER, "source": "fixture"})
        info = get_current_user_info() or {}
        return _no_store({"displayName": info.get("displayName", ""), "source": "live"})
    except Exception as e:
        return _query_error(e, 'get_me')

@app.route('/api/work-items/batch', methods=['GET'])
def get_work_items_batch():
    """Up to 100 alive items by id, in request order; missing ids listed (doc §10)."""
    try:
        return _no_store(query_service.batch(request.args.get('ids', '')))
    except Exception as e:
        return _query_error(e, 'get_work_items_batch')

@app.route('/api/work-items/<int:item_id>/children', methods=['GET'])
def get_work_item_children(item_id):
    """Alive children of a work item, including context and completed rows (doc §9)."""
    try:
        result = query_service.children(item_id)
        if result is None:
            return _no_store({"error": f"Work item #{item_id} not found"}, 404)
        return _no_store(result)
    except Exception as e:
        return _query_error(e, 'get_work_item_children')

@app.route('/api/work-items/<int:item_id>', methods=['GET'])
def get_work_item_by_id(item_id):
    """Fetches a single work item by ID with full metadata."""
    try:
        org_url, pat = _single_item_source()
        item = sync_service.get_single_item(item_id, org_url=org_url, pat=pat)
        if not item:
            return _no_store({"error": f"Work item #{item_id} not found"}, 404)
        return _no_store(item)
    except Exception as e:
        app.logger.error(f"Error in get_work_item_by_id: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

def _single_item_source():
    if sync_service.is_fixture_mode():
        return None, None
    return get_devops_org_url(), get_devops_pat()

@app.route('/api/work-items/<int:item_id>/relations', methods=['GET'])
def get_work_item_relations(item_id):
    """Fetches hydrated relations for a work item."""
    try:
        org_url, pat = _single_item_source()
        item = sync_service.get_single_item(item_id, org_url=org_url, pat=pat)
        if not item:
            return jsonify({"error": f"Work item #{item_id} not found"}), 404
        return jsonify(item.get("relations", {})), 200
    except Exception as e:
        app.logger.error(f"Error in get_work_item_relations: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/api/projects', methods=['GET'])
def get_projects_list():
    """Returns all projects with stats and total active item counts."""
    try:
        org_projects = get_projects_data()
        counts = sync_service.get_counts()
        stats_by_proj = counts.get("stats_by_project", {})

        results = []
        for p in org_projects:
            name = p.get("name")
            if not name:
                continue
            stat = stats_by_proj.get(name, {"total": 0, "unassigned": 0, "assigned": 0})
            results.append({
                "id": p.get("id"),
                "name": name,
                "description": p.get("description", ""),
                "url": p.get("url", ""),
                "state": p.get("state", "wellFormed"),
                "total_items": stat.get("total", 0),
                "unassigned": stat.get("unassigned", 0),
                "assigned": stat.get("assigned", 0)
            })
        results.sort(key=lambda x: x["name"].lower())
        return jsonify({"projects": results, "count": len(results)}), 200
    except Exception as e:
        app.logger.error(f"Error in get_projects_list: {e}", exc_info=True)
        return jsonify({"error": str(e), "projects": [], "count": 0}), 500

@app.route('/api/sync-status', methods=['GET'])
def get_sync_status():
    """Returns current sync state, counters and the last sync report (doc §7)."""
    try:
        counts = sync_service.get_counts()
        report = sync_service.get_sync_report()
        return _no_store({
            "status": report.get("status", "idle"),
            "source": "fixture" if sync_service.is_fixture_mode() else "live",
            "lastSyncedAt": counts.get("last_synced_at"),
            "lastSuccessAt": report.get("last_success_at"),
            "lastFullSyncAt": report.get("last_full_sync_at"),
            "lastIncrementalSyncAt": report.get("last_incremental_sync_at"),
            "lastError": report.get("last_error"),
            "lastResult": report.get("last_result"),
            "totalOrgActive": report.get("total_org_active", 0),
            "totalCached": report.get("total_cached", 0),
            "totalActiveCached": report.get("total_active_cached", 0),
            "deletedCount": report.get("deleted_count", 0),
            "contextCount": report.get("context_count", 0),
            "dataVersion": sync_service.get_data_version(),
            "error": report.get("last_error") or sync_service.get_sync_meta("sync_error") or None,
        }), 200
    except Exception as e:
        return _query_error(e, 'get_sync_status')

@app.route('/api/sync', methods=['POST'])
def trigger_sync():
    """Triggers on-demand incremental or full sync."""
    try:
        data = request.get_json(silent=True) or {}
        mode = data.get("mode", "incremental")
        if sync_service.is_fixture_mode():
            if not fixture_data.ensure_fixture_database():
                return jsonify({"status": "error", "error": "fixture_data_conflict"}), 409
            result = fixture_data.seed_fixture()
            return jsonify({
                "status": "success",
                "mode": mode if mode in ("incremental", "full") else "incremental",
                "fixture": True,
                "fetched": result["total_rows"],
                "upserted": result["rows_written"],
            }), 200

        org_url = get_devops_org_url()
        pat = get_devops_pat()

        force_full = (mode == "full")
        result = sync_service.sync_work_items(org_url, pat, force_full=force_full)
        return jsonify(result), 200
    except Exception as e:
        app.logger.error(f"Error in trigger_sync: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
