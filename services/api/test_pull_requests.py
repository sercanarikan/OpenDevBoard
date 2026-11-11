"""Unit and integration tests for Pull Requests service and endpoints."""

import unittest
from datetime import datetime, timedelta
import gc
import os
import tempfile
from unittest.mock import patch
import pr_service
import sync_service


class TestPullRequestsService(unittest.TestCase):
    def setUp(self):
        pr_service.init_pr_db()
        self.fixture_prs = pr_service.build_fixture_prs()
        self.user = {
            "id": "00000000-0000-0000-0000-000000000001",
            "displayName": "Fixture User",
            "uniqueName": "fixture.user@devopsflow.local"
        }
        self.other_user = {
            "id": "00000000-0000-0000-0000-000000000002",
            "displayName": "Fixture Person A",
            "uniqueName": "ada@devopsflow.local"
        }

    def test_partial_project_fetch_does_not_delete_unrefreshed_project_cache(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            db_path = os.path.join(temp_dir, 'pr-cache.db')
            with patch.object(sync_service, 'DB_PATH', db_path):
                pr_service.init_pr_db()
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.executemany('INSERT INTO work_items (project, deleted_at) VALUES (?, NULL)', [('Alpha',), ('Beta',)])
                    conn.commit()
                finally:
                    conn.close()
                seed = dict(self.fixture_prs[0])
                seed['project'] = 'Beta'
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('''INSERT INTO pull_requests (
                        id, project, repository, title, status, creation_date,
                        reviewers_json, work_items_json, last_synced_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''', (
                        seed['id'], seed['project'], seed['repository'], seed['title'],
                        seed['status'], seed['creationDate'], '[]', '[]', '2026-11-08T00:00:00'
                    ))
                    conn.commit()
                finally:
                    conn.close()

                alpha_raw = {
                    'pullRequestId': 999, 'title': 'fresh', 'status': 'active',
                    'repository': {'name': 'Alpha.Repo', 'project': {'name': 'Alpha'}},
                    'creationDate': '2026-11-09T00:00:00Z'
                }
                def get(url, **kwargs):
                    status = 200 if '/Alpha/' in url else 500
                    value = {'value': [alpha_raw]} if status == 200 else {}
                    return type('Response', (), {'status_code': status, 'json': lambda self: value})()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', side_effect=get):
                    result = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)

                conn = sync_service.get_db_connection()
                try:
                    rows = conn.execute('SELECT id, project FROM pull_requests').fetchall()
                finally:
                    conn.close()
                self.assertEqual({row['project'] for row in result['items']}, {'Alpha'})
                self.assertEqual(result['cacheStatus']['outcome'], 'partial')
                self.assertFalse(result['cacheStatus']['complete'])
                self.assertEqual(result['cacheStatus']['dateScope'], 'creationDate')
                self.assertEqual(result['cacheStatus']['completenessScope'], 'creationDate-window')
                self.assertFalse(result['cacheStatus']['projectDiscoveryComplete'])
                self.assertFalse(result['cacheStatus']['organizationSnapshotComplete'])
                self.assertFalse(result['cacheStatus']['stale'])
                self.assertIn((seed['id'], seed['project']), [tuple(row) for row in rows])
                conn = sync_service.get_db_connection()
                try:
                    state = conn.execute('SELECT outcome, completed_at FROM pr_cache_state WHERE id=1').fetchone()
                finally:
                    conn.close()
                self.assertEqual(state['outcome'], 'partial')
                self.assertIsNotNone(state['completed_at'])
                gc.collect()

    def test_successful_empty_pr_fetch_is_not_reported_complete_due_to_top_limit(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'empty-pr.db')):
                pr_service.init_pr_db()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', return_value=type('Response', (), {'status_code': 200, 'json': lambda self: {'value': []}})()):
                    result = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(result['items'], [])
                self.assertEqual(result['cacheStatus']['outcome'], 'partial')
                self.assertFalse(result['cacheStatus']['complete'])
                gc.collect()

    def test_pr_fetch_uses_created_time_window_and_paginates_with_skip(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'paged-pr.db')):
                pr_service.init_pr_db()
                page1 = {'pullRequestId': 1, 'title': 'one', 'status': 'active', 'repository': {'name': 'repo', 'project': {'name': 'Alpha'}}, 'creationDate': '2026-11-01T00:00:00Z'}
                page2 = {'pullRequestId': 2, 'title': 'two', 'status': 'completed', 'repository': {'name': 'repo', 'project': {'name': 'Alpha'}}, 'creationDate': '2026-11-02T00:00:00Z'}
                first_page = [dict(page1, pullRequestId=index + 10) for index in range(200)]
                responses = [
                    type('Response', (), {'status_code': 200, 'json': lambda self: {'value': first_page}})(),
                    type('Response', (), {'status_code': 200, 'json': lambda self: {'value': [page2] + [dict(page2, pullRequestId=1000 + index) for index in range(199)]}})(),
                    type('Response', (), {'status_code': 200, 'json': lambda self: {'value': []}})(),
                ]
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', side_effect=responses) as get:
                    result = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(len(result['items']), 400)
                self.assertIn(2, {item['id'] for item in result['items']})
                self.assertEqual([call.kwargs['params']['$skip'] for call in get.call_args_list], [0, 200, 400])
                self.assertTrue(all(call.kwargs['params']['searchCriteria.queryTimeRangeType'] == 'Created' for call in get.call_args_list))
                self.assertEqual(result['cacheStatus']['outcome'], 'partial')
                self.assertFalse(result['cacheStatus']['complete'])
                self.assertEqual(result['cacheStatus']['dateScope'], 'creationDate')
                self.assertEqual(result['cacheStatus']['completenessScope'], 'creationDate-window')
                self.assertFalse(result['cacheStatus']['organizationSnapshotComplete'])

    def test_partial_pr_cache_expires_after_ttl(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pr-ttl.db')):
                pr_service.init_pr_db()
                now = pr_service._utcnow()
                with sync_service.get_db_connection() as conn:
                    conn.execute("INSERT INTO pr_cache_state VALUES (1, ?, ?, 'partial', '[]')", ((now - timedelta(seconds=301)).isoformat(), (now - timedelta(seconds=301)).isoformat()))
                with patch.object(pr_service, '_utcnow', return_value=now), \
                        patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', return_value=type('Response', (), {'status_code': 200, 'json': lambda self: {'value': []}})()) as get:
                    pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', include_cache_status=True)
                self.assertGreaterEqual(get.call_count, 1)
                gc.collect()

    def test_pr_total_failure_keeps_previous_complete_rows(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pr-failure.db')):
                pr_service.init_pr_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    conn.execute("INSERT INTO pull_requests (id, project, repository, title, status, creation_date, reviewers_json, work_items_json, last_synced_at) VALUES (1, 'Alpha', 'repo', 'old', 'active', '2026-11-01', '[]', '[]', '2026-11-01')")
                    conn.commit()
                response = type('Response', (), {'status_code': 500, 'json': lambda self: {}})()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', return_value=response):
                    result = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(result['cacheStatus']['outcome'], 'failed')
                self.assertTrue(result['cacheStatus']['stale'])
                with sync_service.get_db_connection() as conn:
                    rows = conn.execute('SELECT id FROM pull_requests').fetchall()
                self.assertEqual([row['id'] for row in rows], [1])
                gc.collect()

    def test_user_identity_matching(self):
        identity_by_id = {"id": "00000000-0000-0000-0000-000000000001", "displayName": "Different Name"}
        self.assertTrue(pr_service.is_user_match(identity_by_id, self.user))

        identity_by_email = {"id": "other-id", "uniqueName": "FIXTURE.USER@devopsflow.local"}
        self.assertTrue(pr_service.is_user_match(identity_by_email, self.user))

        identity_by_name = {"id": "other-id", "displayName": "Fixture User"}
        self.assertTrue(pr_service.is_user_match(identity_by_name, self.user))

        identity_other = {"id": "999", "displayName": "Unknown Person", "uniqueName": "x@y.com"}
        self.assertFalse(pr_service.is_user_match(identity_other, self.user))

    def test_parse_azure_pr(self):
        raw = {
            "pullRequestId": 42,
            "title": "Fix bug in parser",
            "description": "Details about bug",
            "status": "active",
            "isDraft": True,
            "repository": {
                "name": "DevOpsFlow.Web",
                "project": {"name": "Alpha"}
            },
            "createdBy": {
                "id": "user-1",
                "displayName": "Developer One",
                "imageUrl": "https://avatar/1"
            },
            "creationDate": "2026-11-06T10:00:00Z",
            "sourceRefName": "refs/heads/fix/parser",
            "targetRefName": "refs/heads/main",
            "mergeStatus": "succeeded",
            "reviewers": [
                {"id": "user-2", "displayName": "Reviewer Two", "vote": 10, "isRequired": True},
                {"id": "user-3", "displayName": "Reviewer Three", "vote": -5, "isRequired": False}
            ],
            "workItemRefs": [{"id": "1055"}]
        }

        parsed = pr_service.parse_azure_pr(raw, "https://dev.azure.com/org")
        self.assertEqual(parsed["id"], 42)
        self.assertEqual(parsed["project"], "Alpha")
        self.assertEqual(parsed["repository"], "DevOpsFlow.Web")
        self.assertEqual(parsed["sourceBranch"], "fix/parser")
        self.assertEqual(parsed["targetBranch"], "main")
        self.assertEqual(parsed["isDraft"], 1)
        self.assertEqual(len(parsed["reviewers"]), 2)
        self.assertEqual(parsed["reviewers"][0]["voteKey"], "approved")
        self.assertEqual(parsed["reviewers"][1]["voteKey"], "waitingForAuthor")
        self.assertEqual(parsed["workItems"], [{"id": 1055, "url": ""}])

    def test_parse_azure_pr_uses_repository_web_url_instead_of_rest_api_url(self):
        raw = {
            "pullRequestId": 42,
            "url": "https://dev.azure.com/example/project/_apis/git/repositories/repo-id/pullRequests/42",
            "repository": {
                "name": "sample-repo",
                "webUrl": "https://dev.azure.com/example/project/_git/sample-repo",
                "project": {"name": "project"}
            }
        }

        parsed = pr_service.parse_azure_pr(raw, "https://dev.azure.com/example")

        self.assertEqual(
            parsed["url"],
            "https://dev.azure.com/example/project/_git/sample-repo/pullrequest/42"
        )

    def test_fixture_prs_deterministic_counts(self):
        self.assertGreaterEqual(len(self.fixture_prs), 9)
        active_prs = [p for p in self.fixture_prs if p["status"] == "active"]
        self.assertGreaterEqual(len(active_prs), 7)

    def test_query_pull_requests_pagination(self):
        result_p1 = pr_service.query_pull_requests(
            self.fixture_prs,
            {"limit": "3", "offset": "0", "status": "all"},
            current_user=self.user
        )
        self.assertEqual(len(result_p1["items"]), 3)
        self.assertEqual(result_p1["limit"], 3)
        self.assertEqual(result_p1["offset"], 0)
        self.assertTrue(result_p1["hasMore"])

        result_p2 = pr_service.query_pull_requests(
            self.fixture_prs,
            {"limit": "3", "offset": "3", "status": "all"},
            current_user=self.user
        )
        self.assertEqual(len(result_p2["items"]), 3)
        self.assertEqual(result_p2["offset"], 3)
        # Ensure pages have different PRs
        ids_p1 = {p["id"] for p in result_p1["items"]}
        ids_p2 = {p["id"] for p in result_p2["items"]}
        self.assertEqual(len(ids_p1 & ids_p2), 0)

    def test_query_pull_requests_quick_filters(self):
        # 1. Needs my review
        res_review = pr_service.query_pull_requests(
            self.fixture_prs,
            {"quickFilter": "needs-my-review"},
            current_user=self.user
        )
        for p in res_review["items"]:
            self.assertTrue(p["needsMyReview"])
            self.assertEqual(p["status"], "active")
            self.assertFalse(p["isAuthor"])
            self.assertEqual(p["myVote"], 0)

        # 2. Created by me
        res_created = pr_service.query_pull_requests(
            self.fixture_prs,
            {"quickFilter": "created-by-me"},
            current_user=self.user
        )
        for p in res_created["items"]:
            self.assertTrue(p["isAuthor"])

        # 3. Involved
        res_involved = pr_service.query_pull_requests(
            self.fixture_prs,
            {"quickFilter": "involved"},
            current_user=self.user
        )
        for p in res_involved["items"]:
            self.assertTrue(p["isAuthor"] or p["isReviewer"])

    def test_query_pull_requests_search(self):
        res = pr_service.query_pull_requests(
            self.fixture_prs,
            {"search": "circular dependency"},
            current_user=self.user
        )
        self.assertGreaterEqual(res["total"], 1)
        self.assertIn("circular dependency", res["items"][0]["title"].lower())

    def test_query_pull_requests_project_filter(self):
        res_alpha = pr_service.query_pull_requests(
            self.fixture_prs,
            {"project": "Alpha", "status": "all"},
            current_user=self.user
        )
        for p in res_alpha["items"]:
            self.assertEqual(p["project"], "Alpha")

    def test_pr_summary_counts(self):
        summary = pr_service.get_pr_summary(self.fixture_prs, project="all", current_user=self.user)
        self.assertIn("needsMyReview", summary)
        self.assertIn("createdByMe", summary)
        self.assertIn("involved", summary)
        self.assertIn("totalActive", summary)
        self.assertGreater(summary["totalActive"], 0)
        self.assertGreaterEqual(summary["involved"], summary["createdByMe"])

    def test_get_single_pr_details(self):
        pr = pr_service.get_single_pr_details(self.fixture_prs, 101, current_user=self.user)
        self.assertIsNotNone(pr)
        self.assertEqual(pr["id"], 101)
        self.assertTrue(pr["needsMyReview"])

        missing = pr_service.get_single_pr_details(self.fixture_prs, 999999, current_user=self.user)
        self.assertIsNone(missing)


if __name__ == '__main__':
    unittest.main()
