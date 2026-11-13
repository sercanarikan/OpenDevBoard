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
        pr_service._user_group_cache.clear()
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
                self.assertEqual({row['project'] for row in result['items']}, {'Alpha', 'Beta'})
                self.assertEqual(result['cacheStatus']['outcome'], 'partial')
                self.assertFalse(result['cacheStatus']['complete'])
                self.assertEqual(result['cacheStatus']['dateScope'], 'all')
                self.assertEqual(result['cacheStatus']['completenessScope'], 'organization-pr-query')
                self.assertFalse(result['cacheStatus']['projectDiscoveryComplete'])
                self.assertFalse(result['cacheStatus']['organizationSnapshotComplete'])
                self.assertTrue(result['cacheStatus']['stale'])
                self.assertEqual(result['cacheStatus']['errors'], [{'kind': 'upstream_http', 'status': 500}])
                self.assertIn((seed['id'], seed['project']), [tuple(row) for row in rows])
                conn = sync_service.get_db_connection()
                try:
                    state = conn.execute('SELECT outcome, completed_at FROM pr_cache_state WHERE id=1').fetchone()
                finally:
                    conn.close()
                self.assertEqual(state['outcome'], 'partial')
                self.assertIsNotNone(state['completed_at'])
                gc.collect()

    def test_successful_empty_pr_fetch_is_reported_as_empty_not_failed(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'empty-pr.db')):
                pr_service.init_pr_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute("INSERT INTO pull_requests (id, project, repository, title, status, creation_date, reviewers_json, work_items_json, last_synced_at) VALUES (7, 'Alpha', 'repo', 'cached', 'active', '2026-11-01', '[]', '[]', '2026-11-01')")
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', return_value=type('Response', (), {'status_code': 200, 'json': lambda self: {'value': []}})()):
                    result = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(result['items'], [])
                self.assertEqual(result['cacheStatus']['outcome'], 'complete')
                self.assertTrue(result['cacheStatus']['complete'])
                with sync_service.get_db_connection() as conn:
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM pull_requests').fetchone()[0], 0)
                gc.collect()

    def test_failed_refresh_preserves_last_successful_empty_pr_timestamp(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'empty-pr-recovery.db')):
                pr_service.init_pr_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                responses = [
                    type('Response', (), {'status_code': 200, 'json': lambda self: {'value': []}})(),
                    type('Response', (), {'status_code': 403, 'json': lambda self: {}})(),
                ]
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', side_effect=responses):
                    first = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                    failed = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(failed['cacheStatus']['outcome'], 'failed')
                self.assertEqual(failed['cacheStatus']['lastSyncedAt'], first['cacheStatus']['lastSyncedAt'])
                self.assertTrue(failed['cacheStatus']['hasSnapshot'])

    def test_pr_fetch_includes_old_active_prs_and_paginates_without_date_window(self):
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
                self.assertTrue(all('searchCriteria.minTime' not in call.kwargs['params'] for call in get.call_args_list))
                self.assertTrue(all('searchCriteria.maxTime' not in call.kwargs['params'] for call in get.call_args_list))
                self.assertEqual(result['cacheStatus']['outcome'], 'complete')
                self.assertTrue(result['cacheStatus']['complete'])
                self.assertEqual(result['cacheStatus']['completenessScope'], 'organization-pr-query')
                self.assertFalse(result['cacheStatus']['organizationSnapshotComplete'])

    def test_partial_pr_cache_expires_after_ttl(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pr-ttl.db')):
                pr_service.init_pr_db()
                now = pr_service._utcnow()
                with sync_service.get_db_connection() as conn:
                    conn.execute("INSERT INTO pr_cache_state (id, attempted_at, completed_at, outcome, successful_projects) VALUES (1, ?, ?, 'partial', '[]')", ((now - timedelta(seconds=301)).isoformat(), (now - timedelta(seconds=301)).isoformat()))
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
                self.assertEqual([item['id'] for item in result['items']], [1])
                with sync_service.get_db_connection() as conn:
                    rows = conn.execute('SELECT id FROM pull_requests').fetchall()
                self.assertEqual([row['id'] for row in rows], [1])
                gc.collect()

    def test_project_fallback_empty_result_does_not_clear_organization_cache(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pr-fallback-empty.db')):
                pr_service.init_pr_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    conn.execute("INSERT INTO pull_requests (id, project, repository, title, status, creation_date, reviewers_json, work_items_json, last_synced_at) VALUES (1, 'Alpha', 'repo', 'cached', 'active', '2026-11-01', '[]', '[]', '2026-11-01')")
                responses = [
                    type('Response', (), {'status_code': 500, 'json': lambda self: {}})(),
                    type('Response', (), {'status_code': 200, 'json': lambda self: {'value': []}})(),
                ]
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', side_effect=responses):
                    result = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual([item['id'] for item in result['items']], [1])
                self.assertEqual(result['cacheStatus']['outcome'], 'partial')
                self.assertTrue(result['cacheStatus']['stale'])

    def test_partial_pr_cache_keeps_failure_reason_until_refresh(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'partial-pr-reason.db')):
                pr_service.init_pr_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.executemany('INSERT INTO work_items (project, deleted_at) VALUES (?, NULL)', [('Alpha',), ('Beta',)])
                alpha = {'pullRequestId': 1, 'title': 'fixture', 'status': 'active', 'repository': {'name': 'repo', 'project': {'name': 'Alpha'}}}
                responses = [
                    type('Response', (), {'status_code': 500, 'json': lambda self: {}})(),
                    type('Response', (), {'status_code': 200, 'json': lambda self: {'value': [alpha]}})(),
                    type('Response', (), {'status_code': 403, 'json': lambda self: {}})(),
                ]
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', side_effect=responses) as get:
                    first = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                    cached = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', include_cache_status=True)
                self.assertEqual(first['cacheStatus']['errors'], [{'kind': 'upstream_http', 'status': 500}, {'kind': 'auth', 'status': 403}])
                self.assertEqual(cached['cacheStatus']['errors'], first['cacheStatus']['errors'])
                self.assertTrue(cached['cacheStatus']['stale'])
                self.assertEqual(get.call_count, 3)

    def test_pr_refresh_clears_failure_status_after_connection_recovers(self):
        import requests
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pr-recovery.db')):
                pr_service.init_pr_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                recovered_pr = {'pullRequestId': 12, 'title': 'fixture', 'status': 'active', 'repository': {'name': 'repo', 'project': {'name': 'Alpha'}}}
                responses = [
                    type('Response', (), {'status_code': 500, 'json': lambda self: {}})(),
                    requests.ConnectionError('synthetic refusal'),
                    type('Response', (), {'status_code': 200, 'json': lambda self: {'value': [recovered_pr]}})(),
                ]
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pr_service.requests, 'get', side_effect=responses):
                    failed = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                    recovered = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(failed['cacheStatus']['outcome'], 'failed')
                self.assertEqual(failed['cacheStatus']['errors'][0]['kind'], 'upstream_http')
                self.assertEqual([item['id'] for item in recovered['items']], [12])
                self.assertEqual(recovered['cacheStatus']['outcome'], 'complete')
                self.assertFalse(recovered['cacheStatus']['stale'])
                self.assertEqual(recovered['cacheStatus']['errors'], [])

    def test_user_identity_matching(self):
        identity_by_id = {"id": "00000000-0000-0000-0000-000000000001", "displayName": "Different Name"}
        self.assertTrue(pr_service.is_user_match(identity_by_id, self.user))

        identity_by_email = {"id": "other-id", "uniqueName": "FIXTURE.USER@devopsflow.local"}
        self.assertTrue(pr_service.is_user_match(identity_by_email, self.user))

        identity_by_name = {"id": "other-id", "displayName": "Fixture User"}
        self.assertTrue(pr_service.is_user_match(identity_by_name, self.user))

        identity_name_prefix = {"id": "other-id", "displayName": "Fixture User Assistant"}
        self.assertFalse(pr_service.is_user_match(identity_name_prefix, self.user))

        identity_other = {"id": "999", "displayName": "Unknown Person", "uniqueName": "x@y.com"}
        self.assertFalse(pr_service.is_user_match(identity_other, self.user))

    def test_team_reviewer_matches_current_user_group_membership(self):
        user = {**self.user, "groupIds": ["group-guid"]}
        pr = {
            "id": 42, "status": "active", "authorId": "author", "authorName": "Author",
            "reviewers": [{"id": "group-guid", "displayName": "Review Team", "isContainer": True, "vote": 0}]
        }
        flags = pr_service.evaluate_pr_personal_flags(pr, user)
        self.assertTrue(flags["isReviewer"])
        self.assertTrue(flags["needsMyReview"])

    def test_group_membership_lookup_resolves_team_origin_id_read_only(self):
        responses = [
            type('Response', (), {'status_code': 200, 'json': lambda self: {'value': [{'containerDescriptor': 'group-descriptor'}]}})(),
            type('Response', (), {'status_code': 200, 'json': lambda self: {'originId': 'group-guid'}})(),
        ]
        with patch.object(pr_service.requests, 'get', side_effect=responses) as get:
            result = pr_service.fetch_user_group_ids('sample-org', 'user-descriptor', {})
        self.assertEqual(result['groupIds'], ['group-guid'])
        self.assertEqual(result['status'], 'available')
        self.assertTrue(all(call.kwargs.get('timeout') for call in get.call_args_list))
        self.assertTrue(all(call.args[0].startswith('https://vssps.dev.azure.com/') for call in get.call_args_list))

    def test_group_membership_auth_failure_is_reported_as_unavailable(self):
        response = type('Response', (), {'status_code': 403, 'json': lambda self: {}})()
        with patch.object(pr_service.requests, 'get', return_value=response):
            result = pr_service.fetch_user_group_ids('sample-org', 'user-descriptor', {})
        self.assertEqual(result, {'groupIds': [], 'status': 'unavailable', 'error': {'kind': 'auth', 'status': 403}})

    def test_group_details_failure_does_not_claim_complete_membership(self):
        responses = [
            type('Response', (), {'status_code': 200, 'json': lambda self: {'value': [{'containerDescriptor': 'group-descriptor'}]}})(),
            type('Response', (), {'status_code': 403, 'json': lambda self: {}})(),
        ]
        with patch.object(pr_service.requests, 'get', side_effect=responses):
            result = pr_service.fetch_user_group_ids('sample-org', 'user-descriptor', {})
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['error']['kind'], 'group_lookup_incomplete')

    def test_missing_reviewer_data_does_not_create_a_pending_assignment(self):
        pr = {"id": 7, "status": "active", "authorId": "someone-else", "authorName": "Other", "reviewers": []}
        flags = pr_service.evaluate_pr_personal_flags(pr, self.user)
        self.assertFalse(flags["isReviewer"])
        self.assertFalse(flags["needsMyReview"])

    def test_pr_upstream_failures_keep_categories_for_auth_rate_limit_timeout_and_refusal(self):
        cases = [
            (type('Response', (), {'status_code': 403, 'json': lambda self: {}})(), 'auth'),
            (type('Response', (), {'status_code': 429, 'json': lambda self: {}})(), 'rate_limited'),
            (type('Response', (), {'status_code': 500, 'json': lambda self: {}})(), 'upstream_http'),
            (RuntimeError('timeout fixture'), 'upstream_error'),
        ]
        import requests
        cases[3] = (requests.Timeout('synthetic timeout'), 'timeout')
        cases.append((requests.ConnectionError('synthetic refusal'), 'connection_refused'))
        for index, (failure, expected_kind) in enumerate(cases):
            with self.subTest(kind=expected_kind), tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
                with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, f'pr-error-{index}.db')):
                    pr_service.init_pr_db()
                    with sync_service.get_db_connection() as conn:
                        conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                        conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                            patch.object(sync_service, 'get_devops_headers', return_value={}), \
                            patch.object(pr_service.requests, 'get', side_effect=[failure, failure]):
                        result = pr_service.sync_live_pull_requests('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                    self.assertEqual(result['items'], [])
                    self.assertEqual(result['cacheStatus']['errors'][0]['kind'], expected_kind)

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
