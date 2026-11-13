"""Unit and integration tests for Deployment Metrics service and endpoints."""

import unittest
from datetime import datetime, timedelta
import os
import tempfile
from unittest.mock import patch
import deployment_service
import sync_service


class TestDeploymentMetricsService(unittest.TestCase):
    def setUp(self):
        deployment_service.init_deployment_db()
        self.fixture_deps = deployment_service.build_fixture_deployments()

    def test_deployment_cache_does_not_serve_a_different_days_window(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'deployment.db')):
                deployment_service.init_deployment_db()
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    seed = dict(self.fixture_deps[0])
                    conn.execute('''INSERT INTO deployment_records (
                        id, project, release_name, definition_name, environment_name,
                        status, started_on, last_synced_at
                    ) VALUES (999, 'Alpha', 'old', 'old', 'Production', 'succeeded', ?, ?)''', (
                        (deployment_service._utcnow() - timedelta(days=10)).strftime('%Y-%m-%dT%H:%M:%S') + 'Z', deployment_service._utcnow().isoformat()
                    ))
                    conn.commit()
                finally:
                    conn.close()
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('''INSERT INTO deployment_cache_state
                        (id, requested_days, attempted_at, completed_at, outcome, successful_projects)
                        VALUES (1, 7, ?, ?, 'partial', '[]')''', (
                        deployment_service._utcnow().isoformat(), deployment_service._utcnow().isoformat()
                        ))
                    conn.commit()
                finally:
                    conn.close()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', return_value=self._ok([])) as get:
                        first = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', days=7, include_cache_status=True)
                        second = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', days=30)
                self.assertEqual(first['items'], [])
                self.assertEqual(first['cacheStatus']['outcome'], 'partial')
                self.assertFalse(first['cacheStatus']['complete'])
                self.assertTrue(first['cacheStatus']['stale'])
                self.assertEqual(second, [])
                self.assertEqual(get.call_count, 1)
                conn = sync_service.get_db_connection()
                try:
                    persisted = conn.execute('SELECT id FROM deployment_records').fetchall()
                finally:
                    conn.close()
                self.assertEqual(persisted, [])

    @staticmethod
    def _ok(value):
        return type('Response', (), {'status_code': 200, 'json': lambda self: {'value': value}})()

    def test_project_requests_do_not_wait_for_each_other(self):
        import threading
        barrier = threading.Barrier(2, timeout=2)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'parallel.db')):
                deployment_service.init_deployment_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.executemany('INSERT INTO work_items (project, deleted_at) VALUES (?, NULL)', [('Alpha',), ('Beta',)])
                def fetch(*args, **kwargs):
                    barrier.wait()
                    return self._ok([])
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', side_effect=fetch):
                    result = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'synthetic', force_refresh=True, include_cache_status=True)
                self.assertEqual(result['cacheStatus']['outcome'], 'complete')

    def test_deployment_successful_empty_response_is_reported_complete(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'empty-deployment.db')):
                deployment_service.init_deployment_db()
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    conn.execute("INSERT INTO deployment_records (id, project, release_name, definition_name, environment_name, status, started_on, last_synced_at) VALUES (7, 'Alpha', 'cached', 'cached', 'Production', 'succeeded', datetime('now'), datetime('now'))")
                    conn.commit()
                finally:
                    conn.close()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', return_value=self._ok([])) as get:
                    result = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', force_refresh=True, include_cache_status=True)
                    cached = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', include_cache_status=True)
                self.assertEqual(result['items'], [])
                self.assertEqual(result['cacheStatus']['outcome'], 'complete')
                self.assertTrue(result['cacheStatus']['complete'])
                self.assertEqual(cached['items'], [])
                with sync_service.get_db_connection() as conn:
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM deployment_records WHERE project = ?', ('Alpha',)).fetchone()[0], 0)
                self.assertEqual(cached['cacheStatus']['outcome'], 'complete')
                self.assertIsNotNone(cached['cacheStatus']['lastSyncedAt'])
                self.assertEqual(get.call_count, 1)

    def test_failed_refresh_preserves_last_successful_empty_deployment_timestamp(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'empty-deployment-recovery.db')):
                deployment_service.init_deployment_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                responses = [self._ok([]), type('Response', (), {'status_code': 403, 'json': lambda self: {}})()]
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', side_effect=responses):
                    first = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', force_refresh=True, include_cache_status=True)
                    failed = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(first['cacheStatus']['outcome'], 'complete')
                self.assertEqual(failed['cacheStatus']['outcome'], 'failed')
                self.assertEqual(failed['cacheStatus']['lastSyncedAt'], first['cacheStatus']['lastSyncedAt'])

    def test_deployment_reads_all_continuation_pages_for_each_project(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'paged-deployment.db')):
                deployment_service.init_deployment_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                raw1 = {'id': 1, 'release': {'id': 1, 'name': 'R1'}, 'releaseDefinition': {'id': 1, 'name': 'D'}, 'releaseEnvironment': {'id': 1, 'name': 'Prod'}, 'deploymentStatus': 'succeeded', 'startedOn': '2026-11-08T00:00:00Z'}
                raw2 = dict(raw1, id=2)
                responses = [
                    type('Response', (), {'status_code': 200, 'headers': {'x-ms-continuationtoken': 'next'}, 'json': lambda self: {'value': [raw1]}})(),
                    type('Response', (), {'status_code': 200, 'headers': {}, 'json': lambda self: {'value': [raw2]}})(),
                ]
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', side_effect=responses) as get:
                    result = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual({item['id'] for item in result['items']}, {1, 2})
                self.assertEqual(get.call_count, 2)
                self.assertEqual(get.call_args_list[1].kwargs['params']['continuationToken'], 'next')
                self.assertEqual(result['cacheStatus']['outcome'], 'complete')
                self.assertTrue(result['cacheStatus']['complete'])
                self.assertEqual(result['cacheStatus']['completenessScope'], 'discovered-projects/date-window')
                self.assertFalse(result['cacheStatus']['projectDiscoveryComplete'])
                self.assertFalse(result['cacheStatus']['organizationSnapshotComplete'])

    def test_deployment_partial_cache_ttl_expiration_forces_refresh(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'ttl-deployment.db')):
                deployment_service.init_deployment_db()
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    conn.commit()
                finally:
                    conn.close()
                now = deployment_service._utcnow()
                with sync_service.get_db_connection() as conn:
                    conn.execute("INSERT INTO deployment_cache_state (id, requested_days, attempted_at, completed_at, outcome, successful_projects) VALUES (1, 30, ?, ?, 'partial', '[]')", ((now - timedelta(seconds=301)).isoformat(), (now - timedelta(seconds=301)).isoformat()))
                with patch.object(deployment_service, '_utcnow', return_value=now), \
                        patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', return_value=self._ok([])) as get:
                    deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', days=30, include_cache_status=True)
                self.assertEqual(get.call_count, 1)

    def test_deployment_total_failure_keeps_previous_rows_and_reports_stale(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'deployment-failure.db')):
                deployment_service.init_deployment_db()
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    conn.execute("INSERT INTO deployment_records (id, project, release_name, definition_name, environment_name, status, started_on, last_synced_at) VALUES (1, 'Alpha', 'old', 'old', 'Production', 'succeeded', '2026-11-01', '2026-11-01')")
                    conn.commit()
                finally:
                    conn.close()
                bad = type('Response', (), {'status_code': 500, 'json': lambda self: {}})()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', return_value=bad):
                    result = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(result['cacheStatus']['outcome'], 'failed')
                self.assertTrue(result['cacheStatus']['stale'])
                self.assertEqual([item['id'] for item in result['items']], [1])
                self.assertEqual(result['cacheStatus']['errors'], [{'kind': 'upstream_http', 'status': 500}])
                with sync_service.get_db_connection() as conn:
                    rows = conn.execute('SELECT id FROM deployment_records').fetchall()
                self.assertEqual([row['id'] for row in rows], [1])

    def test_deployment_upstream_failure_categories_are_not_connection_refusals_by_default(self):
        import requests
        cases = [
            (type('Response', (), {'status_code': 401, 'json': lambda self: {}})(), {'kind': 'auth', 'status': 401}),
            (type('Response', (), {'status_code': 403, 'json': lambda self: {}})(), {'kind': 'auth', 'status': 403}),
            (type('Response', (), {'status_code': 429, 'json': lambda self: {}})(), {'kind': 'rate_limited', 'status': 429}),
            (type('Response', (), {'status_code': 503, 'json': lambda self: {}})(), {'kind': 'upstream_http', 'status': 503}),
            (requests.Timeout('synthetic timeout'), {'kind': 'timeout'}),
            (requests.ConnectionError('synthetic refusal'), {'kind': 'connection_refused'}),
        ]
        for index, (failure, expected) in enumerate(cases):
            with self.subTest(error=expected['kind']), tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
                with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, f'deployment-error-{index}.db')):
                    deployment_service.init_deployment_db()
                    with sync_service.get_db_connection() as conn:
                        conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                        conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    request_patch = patch.object(deployment_service.requests, 'get', side_effect=failure) if isinstance(failure, BaseException) else patch.object(deployment_service.requests, 'get', return_value=failure)
                    with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                            patch.object(sync_service, 'get_devops_headers', return_value={}), \
                            request_patch:
                        result = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(result['items'], [])
                self.assertEqual(result['cacheStatus']['errors'], [expected])

    def test_partial_deployment_failure_returns_stale_cache_and_recovers_on_next_success(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'deployment-recovery.db')):
                deployment_service.init_deployment_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.executemany('INSERT INTO work_items (project, deleted_at) VALUES (?, NULL)', [('Alpha',), ('Beta',)])
                    conn.execute("INSERT INTO deployment_records (id, project, release_name, definition_name, environment_name, status, started_on, last_synced_at) VALUES (1, 'Beta', 'cached', 'cached', 'Production', 'succeeded', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')")
                alpha = {'id': 2, 'release': {'id': 2, 'name': 'fresh'}, 'releaseDefinition': {'id': 2, 'name': 'fresh'}, 'releaseEnvironment': {'id': 2, 'name': 'Production'}, 'deploymentStatus': 'succeeded', 'startedOn': '2026-11-10T00:00:00Z'}
                good = self._ok([alpha])
                forbidden = type('Response', (), {'status_code': 403, 'json': lambda self: {}})()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', side_effect=[good, forbidden]) as get:
                    partial = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', force_refresh=True, include_cache_status=True)
                    cached_partial = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', include_cache_status=True)
                self.assertEqual(partial['cacheStatus']['outcome'], 'partial')
                self.assertTrue(partial['cacheStatus']['stale'])
                self.assertEqual({item['id'] for item in partial['items']}, {1, 2})
                self.assertEqual(partial['cacheStatus']['errors'], [{'kind': 'auth', 'status': 403}])
                self.assertEqual(cached_partial['cacheStatus']['errors'], partial['cacheStatus']['errors'])
                self.assertEqual(get.call_count, 2)

                with patch.object(deployment_service, '_utcnow', return_value=deployment_service._utcnow() + timedelta(minutes=6)), \
                        patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.requests, 'get', side_effect=[good, good]):
                    recovered = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(recovered['cacheStatus']['outcome'], 'complete')
                self.assertFalse(recovered['cacheStatus']['stale'])

    def test_parse_azure_deployment(self):
        raw = {
            "id": 999,
            "release": {"id": 100, "name": "Release-100"},
            "releaseDefinition": {"id": 1, "name": "Alpha.CD"},
            "releaseEnvironment": {"id": 10, "name": "Production"},
            "deploymentStatus": "succeeded",
            "attempt": 1,
            "startedOn": "2026-11-06T12:00:00Z",
            "completedOn": "2026-11-06T12:05:00Z",
            "requestedBy": {"displayName": "Fixture User"}
        }

        parsed = deployment_service.parse_azure_deployment(raw, "org", "Alpha")
        self.assertEqual(parsed["id"], 999)
        self.assertEqual(parsed["project"], "Alpha")
        self.assertEqual(parsed["releaseName"], "Release-100")
        self.assertEqual(parsed["definitionName"], "Alpha.CD")
        self.assertEqual(parsed["environmentName"], "Production")
        self.assertEqual(parsed["status"], "succeeded")
        self.assertEqual(parsed["durationSeconds"], 300)
        self.assertEqual(parsed["requestedBy"], "Fixture User")

    def test_fixture_deployments_counts_and_environments(self):
        self.assertGreaterEqual(len(self.fixture_deps), 20)
        envs = {d["environmentName"] for d in self.fixture_deps}
        self.assertIn("Production", envs)
        self.assertIn("Staging", envs)
        self.assertIn("Test", envs)
        self.assertIn("Development", envs)

        in_progress = [d for d in self.fixture_deps if d["status"] == "inProgress"]
        self.assertGreater(len(in_progress), 0)

    def test_query_deployments_pagination(self):
        p1 = deployment_service.query_deployments(self.fixture_deps, {"limit": "5", "offset": "0"})
        self.assertEqual(len(p1["items"]), 5)
        self.assertEqual(p1["limit"], 5)
        self.assertEqual(p1["offset"], 0)
        self.assertTrue(p1["hasMore"])

        p2 = deployment_service.query_deployments(self.fixture_deps, {"limit": "5", "offset": "5"})
        self.assertEqual(len(p2["items"]), 5)
        self.assertEqual(p2["offset"], 5)
        ids1 = {d["id"] for d in p1["items"]}
        ids2 = {d["id"] for d in p2["items"]}
        self.assertEqual(len(ids1 & ids2), 0)

    def test_query_deployments_filters(self):
        # Environment filter
        prod = deployment_service.query_deployments(self.fixture_deps, {"environment": "Production"})
        for d in prod["items"]:
            self.assertEqual(d["environmentName"], "Production")

        # Project filter
        alpha = deployment_service.query_deployments(self.fixture_deps, {"project": "Alpha"})
        for d in alpha["items"]:
            self.assertEqual(d["project"], "Alpha")

        # Status filter
        succeeded = deployment_service.query_deployments(self.fixture_deps, {"status": "succeeded"})
        for d in succeeded["items"]:
            self.assertEqual(d["status"], "succeeded")

    def test_compute_deployment_summary(self):
        summary = deployment_service.compute_deployment_summary(self.fixture_deps, days=30)
        self.assertIn("totalDeployments", summary)
        self.assertIn("succeeded", summary)
        self.assertIn("failed", summary)
        self.assertIn("environments", summary)
        self.assertGreater(len(summary["environments"]), 0)

        # Check completed success rate calculation
        completed = summary["succeeded"] + summary["failed"]
        expected_rate = round((summary["succeeded"] / completed * 100), 1) if completed > 0 else 100.0
        self.assertEqual(summary["successRate"], expected_rate)

        # Check project breakdown
        self.assertIn("projects", summary)
        self.assertGreater(len(summary["projects"]), 0)
        proj_names = {p["project"] for p in summary["projects"]}
        self.assertIn("Alpha", proj_names)
        alpha_stat = next(p for p in summary["projects"] if p["project"] == "Alpha")
        self.assertIn("total", alpha_stat)
        self.assertIn("succeeded", alpha_stat)
        self.assertIn("failed", alpha_stat)
        self.assertIn("successRate", alpha_stat)

    def test_get_single_deployment_details(self):
        dep = deployment_service.get_single_deployment_details(self.fixture_deps, 501, project="Alpha")
        self.assertIsNotNone(dep)
        self.assertEqual(dep["id"], 501)
        self.assertEqual(dep["environmentName"], "Production")

        missing = deployment_service.get_single_deployment_details(self.fixture_deps, 999999)
        self.assertIsNone(missing)


if __name__ == '__main__':
    unittest.main()
