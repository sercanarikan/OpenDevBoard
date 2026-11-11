"""Unit and integration tests for Team Activity analytics service and endpoints."""

import unittest
import json
import gc
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta
from unittest.mock import patch
import requests
import team_service
import sync_service


class TestTeamActivityService(unittest.TestCase):
    def setUp(self):
        team_service.init_team_db()
        self.fixture_data = team_service.build_fixture_team_activity()

    def test_env_check_returns_only_minimal_secret_free_diagnostics(self):
        import app as api_app

        with patch.dict(os.environ, {
            'AZURE_DEVOPS_ORG_URL': 'https://dev.azure.com/acme-private-org',
            'AZURE_DEVOPS_PAT': 'must-never-be-returned',
        }, clear=False):
            response = api_app.app.test_client().get('/api/env-check')

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body, {
            'status': 'healthy',
            'organization': 'acme-private-org',
            'azure_devops_configured': True,
        })
        self.assertNotIn('must-never-be-returned', response.get_data(as_text=True))

    def test_env_check_uses_safe_defaults_when_configuration_missing(self):
        import app as api_app

        with patch.dict(os.environ, {}, clear=True):
            response = api_app.app.test_client().get('/api/env-check')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            'status': 'healthy',
            'organization': None,
            'azure_devops_configured': False,
        })

    def test_env_check_does_not_echo_malformed_organization_url(self):
        import app as api_app

        with patch.dict(os.environ, {
            'AZURE_DEVOPS_ORG_URL': 'https://user:password@dev.azure.com/acme?token=hidden',
            'AZURE_DEVOPS_PAT': '',
        }, clear=False):
            response = api_app.app.test_client().get('/api/env-check')

        self.assertEqual(response.get_json(), {
            'status': 'healthy',
            'organization': None,
            'azure_devops_configured': False,
        })
        body = response.get_data(as_text=True)
        self.assertNotIn('password', body)
        self.assertNotIn('hidden', body)

    def _isolated_cache(self):
        temp_dir = tempfile.TemporaryDirectory()
        db_path = os.path.join(temp_dir.name, 'team.db')
        old_db_path = sync_service.DB_PATH
        sync_service.DB_PATH = db_path
        team_service.init_team_db()
        self.addCleanup(self._restore_db_path, old_db_path, temp_dir)
        return db_path

    @staticmethod
    def _restore_db_path(old_db_path, temp_dir):
        sync_service.DB_PATH = old_db_path
        gc.collect()
        temp_dir.cleanup()

    def test_cache_metadata_migration_preserves_existing_commits(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            old_db_path = sync_service.DB_PATH
            db_path = os.path.join(temp_dir, 'existing.db')
            try:
                with sqlite3.connect(db_path) as conn:
                    conn.execute('''CREATE TABLE team_commits (
                        commit_id TEXT NOT NULL, project TEXT NOT NULL, repository TEXT NOT NULL,
                        author_name TEXT NOT NULL, author_email TEXT, date TEXT NOT NULL,
                        comment TEXT, change_counts TEXT, url TEXT, last_synced_at TEXT,
                        PRIMARY KEY (commit_id, repository))''')
                    conn.execute('''INSERT INTO team_commits VALUES (
                        'preserve-me', 'Alpha', 'Alpha.Web', 'Ada', 'ada@example.test',
                        '2026-11-07T12:00:00Z', 'existing', '', 'https://example.test/c/1',
                        '2026-11-08T12:00:00')''')
                with patch.object(sync_service, 'DB_PATH', db_path):
                    team_service.init_team_db()
                    conn = sync_service.get_db_connection()
                    try:
                        row = conn.execute("SELECT commit_id, project FROM team_commits").fetchone()
                        metadata = conn.execute(
                            "SELECT name FROM sqlite_master WHERE type='table' AND name='team_activity_cache_state'"
                        ).fetchone()
                    finally:
                        conn.close()
                self.assertEqual(tuple(row), ('preserve-me', 'Alpha'))
                self.assertIsNotNone(metadata)
            finally:
                sync_service.DB_PATH = old_db_path
                gc.collect()

    @staticmethod
    def _azure_repo(name, project, repo_id):
        return {"id": repo_id, "name": name, "project": {"name": project}}

    @staticmethod
    def _azure_commit(commit_id, date, comment='commit'):
        return {
            "commitId": commit_id,
            "author": {"name": "Ada", "email": "ada@example.test", "date": date},
            "date": date,
            "comment": comment,
        }

    def _mock_azure(self, repos, by_repo, now):
        def get(url, **kwargs):
            if url.endswith('/_apis/git/repositories?api-version=7.1'):
                response = type('Response', (), {"status_code": 200, "json": lambda self: {"value": repos}})()
                return response
            repo_id = next((str(r["id"]) for r in repos if f"/repositories/{r['id']}/commits?" in url), None)
            if repo_id is None:
                raise AssertionError(f"unexpected Azure URL: {url}")
            action = by_repo[repo_id]
            if isinstance(action, Exception):
                raise action
            if isinstance(action, int):
                return type('Response', (), {"status_code": action, "json": lambda self: {"value": []}})()
            return type('Response', (), {"status_code": 200, "json": lambda self: {"value": action}})()

        pr_response = type('Response', (), {"status_code": 200, "json": lambda self: {"value": []}})()
        return patch.object(team_service.sync_service, 'get_devops_headers', return_value={}), \
            patch.object(team_service.requests, 'get', side_effect=get), \
            patch.object(team_service, '_load_live_prs_summary_only', return_value=[]), \
            patch.object(team_service, '_utcnow', return_value=now), pr_response

    @staticmethod
    def _cached_ids():
        with sync_service.get_db_connection() as conn:
            return {row['commit_id'] for row in conn.execute('SELECT commit_id FROM team_commits')}

    def test_complete_short_then_long_window_retains_older_commits(self):
        self._isolated_cache()
        now = datetime(2026, 11, 8, 12)
        repos = [self._azure_repo('Alpha.Web', 'Alpha', 1)]
        old = self._azure_commit('older', (now - timedelta(days=20)).isoformat() + 'Z')
        recent = self._azure_commit('recent', (now - timedelta(days=2)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [old, recent]}, now)
        with context[0], context[1], context[2], context[3]:
            short = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
            long = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=30, force_refresh=True)
        self.assertEqual({c['commitId'] for c in short['commits']}, {'recent'})
        self.assertEqual({c['commitId'] for c in long['commits']}, {'older', 'recent'})

    def test_complete_long_then_short_window_retains_cache_outside_window(self):
        self._isolated_cache()
        now = datetime(2026, 11, 8, 12)
        repos = [self._azure_repo('Alpha.Web', 'Alpha', 1)]
        old = self._azure_commit('older', (now - timedelta(days=20)).isoformat() + 'Z')
        recent = self._azure_commit('recent', (now - timedelta(days=2)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [old, recent]}, now)
        with context[0], context[1], context[2], context[3]:
            long = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=30, force_refresh=True)
            short = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        self.assertEqual({c['commitId'] for c in long['commits']}, {'older', 'recent'})
        self.assertEqual({c['commitId'] for c in short['commits']}, {'recent'})
        self.assertEqual(self._cached_ids(), {'older', 'recent'})

    def test_complete_empty_window_is_not_a_failed_fetch(self):
        self._isolated_cache()
        now = datetime(2026, 11, 8, 12)
        repos = [self._azure_repo('Alpha.Web', 'Alpha', 1)]
        old = self._azure_commit('older', (now - timedelta(days=20)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [old]}, now)
        with context[0], context[1], context[2], context[3]:
            team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=30, force_refresh=True)
        context = self._mock_azure(repos, {'1': []}, now)
        with context[0], context[1], context[2], context[3]:
            result = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        self.assertEqual(result['cacheStatus']['outcome'], 'complete')
        self.assertTrue(result['cacheStatus']['complete'])
        self.assertEqual({c['commitId'] for c in result['commits']}, set())
        self.assertEqual(self._cached_ids(), {'older'})

    def test_failed_fetch_after_populated_cache_returns_stale_data(self):
        self._isolated_cache()
        now = datetime(2026, 11, 8, 12)
        repos = [self._azure_repo('Alpha.Web', 'Alpha', 1)]
        commit = self._azure_commit('cached', (now - timedelta(days=2)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [commit]}, now)
        with context[0], context[1], context[2], context[3]:
            team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        context = self._mock_azure(repos, {'1': requests.Timeout('timeout')}, now + timedelta(minutes=6))
        with context[0], context[1], context[2], context[3]:
            result = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        self.assertEqual({c['commitId'] for c in result['commits']}, {'cached'})
        self.assertEqual(result['cacheStatus']['outcome'], 'failed')
        self.assertTrue(result['cacheStatus']['stale'])

    def test_partial_project_fetch_is_incomplete_and_keeps_other_project_cache(self):
        self._isolated_cache()
        now = datetime(2026, 11, 8, 12)
        repos = [self._azure_repo('Alpha.Web', 'Alpha', 1), self._azure_repo('Beta.Api', 'Beta', 2)]
        alpha = self._azure_commit('alpha', (now - timedelta(days=2)).isoformat() + 'Z')
        beta = self._azure_commit('beta', (now - timedelta(days=2)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [alpha], '2': [beta]}, now)
        with context[0], context[1], context[2], context[3]:
            team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        updated_alpha = self._azure_commit('alpha-new', (now - timedelta(days=1)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [updated_alpha], '2': requests.Timeout('timeout')}, now + timedelta(minutes=6))
        with context[0], context[1], context[2], context[3]:
            result = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')
        self.assertFalse(result['cacheStatus']['complete'])
        self.assertTrue(result['cacheStatus']['stale'])
        self.assertEqual(set(result['cacheStatus']['successfulProjects']), {'Alpha'})
        self.assertEqual({c['commitId'] for c in result['commits']}, {'alpha-new', 'beta'})

    def test_cache_ttl_requires_matching_complete_window(self):
        self._isolated_cache()
        now = datetime(2026, 11, 8, 12)
        repos = [self._azure_repo('Alpha.Web', 'Alpha', 1)]
        first = self._azure_commit('first', (now - timedelta(days=2)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [first]}, now)
        with context[0], context[1], context[2], context[3]:
            team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        refresh = self._azure_commit('refresh', (now - timedelta(days=1)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [refresh]}, now + timedelta(seconds=299))
        with context[0], context[1] as get_mock, context[2], context[3]:
            fresh = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7)
        self.assertEqual({c['commitId'] for c in fresh['commits']}, {'first'})
        self.assertEqual(get_mock.call_count, 0)
        context = self._mock_azure(repos, {'1': [refresh]}, now + timedelta(seconds=301))
        with context[0], context[1] as get_mock, context[2], context[3]:
            expired = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7)
        self.assertEqual({c['commitId'] for c in expired['commits']}, {'refresh'})
        self.assertEqual(get_mock.call_count, 2)

    def test_failed_repository_discovery_keeps_complete_metadata_and_cache(self):
        self._isolated_cache()
        now = datetime(2026, 11, 8, 12)
        repos = [self._azure_repo('Alpha.Web', 'Alpha', 1)]
        commit = self._azure_commit('cached', (now - timedelta(days=2)).isoformat() + 'Z')
        context = self._mock_azure(repos, {'1': [commit]}, now)
        with context[0], context[1], context[2], context[3]:
            team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        failed_get = patch.object(team_service.requests, 'get', side_effect=requests.Timeout('repository timeout'))
        with patch.object(team_service.sync_service, 'get_devops_headers', return_value={}), failed_get, \
                patch.object(team_service, '_load_live_prs_summary_only', return_value=[]), \
                patch.object(team_service, '_utcnow', return_value=now + timedelta(minutes=6)):
            result = team_service.sync_live_team_activity('https://dev.azure.com/org', 'unused', days=7, force_refresh=True)
        self.assertEqual({c['commitId'] for c in result['commits']}, {'cached'})
        self.assertEqual(result['cacheStatus']['outcome'], 'failed')
        self.assertTrue(result['cacheStatus']['stale'])
        with sync_service.get_db_connection() as conn:
            state = conn.execute('SELECT outcome, completed_at FROM team_activity_cache_state WHERE id=1').fetchone()
        self.assertEqual(state['outcome'], 'failed')
        self.assertEqual(state['completed_at'], now.isoformat())

    def test_project_and_date_scope_totals_agree_across_team_queries(self):
        now = datetime(2026, 11, 8, 12)
        commits = [
            {**self._azure_commit('alpha-recent', (now - timedelta(days=2)).isoformat() + 'Z'),
             'author': 'Ada', 'authorEmail': 'ada@example.test', 'project': 'Alpha', 'repository': 'Alpha.Web'},
            {**self._azure_commit('alpha-old', (now - timedelta(days=20)).isoformat() + 'Z'),
             'author': 'Ada', 'authorEmail': 'ada@example.test', 'project': 'Alpha', 'repository': 'Alpha.Web'},
            {**self._azure_commit('beta-recent', (now - timedelta(days=1)).isoformat() + 'Z'),
             'author': 'Bea', 'authorEmail': 'bea@example.test',
             'project': 'Beta', 'repository': 'Beta.Api'},
        ]
        with patch.object(team_service, '_utcnow', return_value=now):
            summary = team_service.compute_team_summary(commits, [], days=7, project='Alpha')
        with patch.object(team_service, '_utcnow', return_value=now):
            contributors = team_service.query_contributors(commits, [], {'days': '7', 'project': 'Alpha', 'limit': '50'})
            commit_list = team_service.query_commits(commits, {'days': '7', 'project': 'Alpha', 'limit': '50'})
        repositories = summary['repositories']
        self.assertEqual(summary['totalCommits'], 1)
        self.assertEqual(sum(c['commitCount'] for c in contributors['items']), 1)
        self.assertEqual(commit_list['total'], 1)
        self.assertEqual(sum(r['commitCount'] for r in repositories), 1)

    def test_team_activity_routes_expose_cache_status_additively(self):
        import app as api_app

        payload = {
            'commits': self.fixture_data['commits'],
            'pullRequests': self.fixture_data['pullRequests'],
            'cacheStatus': {'outcome': 'partial', 'complete': False, 'stale': True,
                            'requestedDays': 7, 'successfulProjects': ['Alpha']},
        }
        client = api_app.app.test_client()
        with patch.object(api_app, '_load_all_team_activity', return_value=payload):
            responses = [
                client.get('/api/team-activity?days=7'),
                client.get('/api/team-activity/summary?days=7'),
                client.get('/api/team-activity/contributors?days=7'),
                client.get('/api/team-activity/commits?days=7'),
                client.get('/api/team-activity/repositories?days=7'),
            ]
        for response in responses:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['cacheStatus'], payload['cacheStatus'])

    def test_fixture_team_activity_structure(self):
        self.assertIn("commits", self.fixture_data)
        self.assertIn("pullRequests", self.fixture_data)
        self.assertGreaterEqual(len(self.fixture_data["commits"]), 20)
        self.assertGreaterEqual(len(self.fixture_data["pullRequests"]), 10)

        # Check commit fields
        c0 = self.fixture_data["commits"][0]
        self.assertIn("commitId", c0)
        self.assertIn("author", c0)
        self.assertIn("authorEmail", c0)
        self.assertIn("project", c0)
        self.assertIn("repository", c0)
        self.assertIn("date", c0)
        self.assertIn("comment", c0)

    def test_compute_team_summary_and_metrics(self):
        summary = team_service.compute_team_summary(
            self.fixture_data["commits"],
            self.fixture_data["pullRequests"],
            days=30
        )

        self.assertIn("totalCommits", summary)
        self.assertIn("totalPRs", summary)
        self.assertIn("activeContributors", summary)
        self.assertIn("dailyStats", summary)
        self.assertIn("repositories", summary)
        self.assertIn("contributors", summary)

        self.assertGreater(summary["totalCommits"], 0)
        self.assertGreater(summary["activeContributors"], 0)
        self.assertEqual(len(summary["dailyStats"]), 30)

        # Check contributor aggregation
        ada = next((c for c in summary["contributors"] if "Fixture Person A" in c["name"]), None)
        self.assertIsNotNone(ada)
        self.assertGreater(ada["commitCount"], 0)
        self.assertIn("lastActivity", ada)

    def test_query_contributors_pagination_and_sorting(self):
        res1 = team_service.query_contributors(
            self.fixture_data["commits"],
            self.fixture_data["pullRequests"],
            {"limit": "2", "offset": "0", "sortBy": "commits", "sortOrder": "desc"}
        )

        self.assertEqual(len(res1["items"]), 2)
        self.assertEqual(res1["limit"], 2)
        self.assertEqual(res1["offset"], 0)
        self.assertTrue(res1["hasMore"])
        # First contributor should have >= commits than second
        self.assertGreaterEqual(res1["items"][0]["commitCount"], res1["items"][1]["commitCount"])

        res2 = team_service.query_contributors(
            self.fixture_data["commits"],
            self.fixture_data["pullRequests"],
            {"limit": "2", "offset": "2", "sortBy": "commits", "sortOrder": "desc"}
        )
        self.assertEqual(len(res2["items"]), 2)
        names1 = {c["name"] for c in res1["items"]}
        names2 = {c["name"] for c in res2["items"]}
        self.assertEqual(len(names1 & names2), 0)

    def test_query_commits_timeline_filters(self):
        # Project filter
        alpha_res = team_service.query_commits(
            self.fixture_data["commits"],
            {"project": "Alpha", "limit": "50"}
        )
        for c in alpha_res["items"]:
            self.assertEqual(c["project"], "Alpha")

        # Contributor filter
        grace_res = team_service.query_commits(
            self.fixture_data["commits"],
            {"contributor": "Fixture Person B", "limit": "50"}
        )
        self.assertGreater(len(grace_res["items"]), 0)
        for c in grace_res["items"]:
            self.assertIn("Fixture Person B", c["author"])

        # Search query
        search_res = team_service.query_commits(
            self.fixture_data["commits"],
            {"search": "fix", "limit": "50"}
        )
        for c in search_res["items"]:
            self.assertIn("fix", (c["comment"] + c["author"]).lower())

    def test_repository_activity_breakdown(self):
        repos = team_service.compute_repository_activity(
            self.fixture_data["commits"],
            self.fixture_data["pullRequests"]
        )
        self.assertGreater(len(repos), 0)
        r0 = repos[0]
        self.assertIn("repository", r0)
        self.assertIn("project", r0)
        self.assertIn("commitCount", r0)
        self.assertIn("prCount", r0)
        self.assertIn("lastActivity", r0)

    def test_scope_consistency_summary_and_contributors(self):
        # 1. Compare 7-day vs 30-day scope
        s7 = team_service.compute_team_summary(
            self.fixture_data["commits"], self.fixture_data["pullRequests"], days=7
        )
        s30 = team_service.compute_team_summary(
            self.fixture_data["commits"], self.fixture_data["pullRequests"], days=30
        )
        self.assertLessEqual(s7["totalCommits"], s30["totalCommits"])
        self.assertEqual(s7["periodDays"], 7)
        self.assertEqual(s30["periodDays"], 30)

        # 2. Scope by project
        s_alpha = team_service.compute_team_summary(
            self.fixture_data["commits"], self.fixture_data["pullRequests"], days=30, project="Alpha"
        )
        self.assertEqual(s_alpha["project"], "Alpha")
        # All commits in s_alpha must be for Alpha
        for r in s_alpha["repositories"]:
            self.assertEqual(r["project"], "Alpha")
        total_contrib_commits = sum(c["commitCount"] for c in s_alpha["contributors"])
        self.assertEqual(total_contrib_commits, s_alpha["totalCommits"])

        # 3. Contributors query with project filter must match summary
        contrib_query = team_service.query_contributors(
            self.fixture_data["commits"], self.fixture_data["pullRequests"],
            {"project": "Alpha", "days": "30", "limit": "50"}
        )
        query_commit_sum = sum(c["commitCount"] for c in contrib_query["items"])
        self.assertEqual(query_commit_sum, s_alpha["totalCommits"])


if __name__ == '__main__':
    unittest.main()
