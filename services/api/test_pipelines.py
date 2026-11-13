"""Unit and integration tests for Pipeline Health service and endpoints."""

import unittest
from datetime import datetime, timedelta
import os
import tempfile
from unittest.mock import patch
import pipeline_service
import sync_service


class TestPipelineHealthService(unittest.TestCase):
    def setUp(self):
        pipeline_service.init_pipeline_db()
        self.fixture_runs = pipeline_service.build_fixture_pipelines()

    def test_project_fallback_reports_organization_http_failure(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pipeline-fallback.db')):
                pipeline_service.init_pipeline_db()
                with sync_service.get_db_connection() as conn:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                forbidden = type('Response', (), {'status_code': 403})()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.requests, 'get', side_effect=[forbidden, self._ok([])]):
                    result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True)
                self.assertEqual(result['cacheStatus']['outcome'], 'partial')
                self.assertEqual(result['cacheStatus']['organizationQueryError'], {'kind': 'http', 'status': 403})

    def test_pipeline_cache_does_not_serve_a_different_days_window(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pipeline.db')):
                pipeline_service.init_pipeline_db()
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    conn.commit()
                finally:
                    conn.close()
                old_run = dict(self.fixture_runs[0])
                old_run['queueTime'] = '2026-11-01T10:00:00Z'
                old_run['finishTime'] = '2026-11-01T10:05:00Z'
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('''INSERT INTO pipeline_runs (
                        id, project, pipeline_name, pipeline_type, status, queue_time,
                        finish_time, last_synced_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)''', (
                        999, 'Alpha', 'Old', 'yaml', 'completed', old_run['queueTime'],
                        old_run['finishTime'], pipeline_service._utcnow().isoformat()
                    ))
                    conn.commit()
                finally:
                    conn.close()
                with sync_service.get_db_connection() as conn:
                    conn.execute('''INSERT INTO pipeline_cache_state
                        (id, requested_days, attempted_at, completed_at, outcome, successful_projects)
                        VALUES (1, 7, ?, ?, 'partial', '[]')''', (
                            pipeline_service._utcnow().isoformat(), pipeline_service._utcnow().isoformat()
                        ))
                with patch.object(pipeline_service, '_utcnow', return_value=pipeline_service._utcnow()), \
                        patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.requests, 'get', return_value=self._ok([])) as get:
                        first = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', days=7, include_cache_status=True)
                        second = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', days=30, include_cache_status=True)
                self.assertEqual(first['items'], [])
                self.assertEqual(second['items'], [])
                self.assertEqual(first['cacheStatus']['outcome'], 'partial')
                self.assertFalse(first['cacheStatus']['complete'])
                self.assertFalse(first['cacheStatus']['stale'])
                self.assertEqual(get.call_count, 1)
                conn = sync_service.get_db_connection()
                try:
                    persisted = conn.execute('SELECT id FROM pipeline_runs').fetchall()
                finally:
                    conn.close()
                self.assertEqual([row['id'] for row in persisted], [999])

    def test_pipeline_successful_empty_response_is_reported_partial_not_complete(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'empty-pipeline.db')):
                pipeline_service.init_pipeline_db()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.requests, 'get', return_value=self._ok([])):
                    result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', days=30, force_refresh=True, include_cache_status=True)
                self.assertEqual(result['items'], [])
                self.assertEqual(result['cacheStatus']['outcome'], 'partial')
                self.assertFalse(result['cacheStatus']['complete'])

    def test_pipeline_reads_all_continuation_pages_and_tracks_terminal_token(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'paged-pipeline.db')):
                pipeline_service.init_pipeline_db()
                responses = [
                    type('Response', (), {'status_code': 200, 'headers': {'x-ms-continuationtoken': 'next'}, 'json': lambda self: {'value': [{'id': 10, 'project': {'name': 'Alpha'}, 'queueTime': '2026-11-08T00:00:00Z'}]}})(),
                    type('Response', (), {'status_code': 200, 'headers': {}, 'json': lambda self: {'value': [{'id': 11, 'project': {'name': 'Alpha'}, 'queueTime': '2026-11-08T00:00:00Z'}]}})(),
                ]
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.requests, 'get', side_effect=responses) as get:
                    result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual({item['id'] for item in result['items']}, {10, 11})
                self.assertEqual(get.call_count, 2)
                self.assertEqual(get.call_args_list[1].kwargs['params']['continuationToken'], 'next')
                self.assertEqual(result['cacheStatus']['outcome'], 'complete')
                self.assertTrue(result['cacheStatus']['complete'])
                self.assertEqual(result['cacheStatus']['completenessScope'], 'discovered-projects/date-window')
                self.assertFalse(result['cacheStatus']['projectDiscoveryComplete'])
                self.assertFalse(result['cacheStatus']['organizationSnapshotComplete'])

    def test_pipeline_metadata_ttl_expiration_forces_refresh(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'ttl-pipeline.db')):
                pipeline_service.init_pipeline_db()
                now = pipeline_service._utcnow()
                with sync_service.get_db_connection() as conn:
                    conn.execute("INSERT INTO pipeline_cache_state VALUES (1, 30, ?, ?, 'partial', '[]')", (now.isoformat(), (now - timedelta(seconds=301)).isoformat()))
                with patch.object(pipeline_service, '_utcnow', return_value=now), \
                        patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.requests, 'get', return_value=self._ok([])) as get:
                    pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', days=30, include_cache_status=True)
                self.assertEqual(get.call_count, 1)

    def test_pipeline_short_refresh_does_not_replace_long_window_snapshot(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pipeline-window.db')):
                pipeline_service.init_pipeline_db()
                old = pipeline_service._utcnow() - timedelta(days=20)
                old_iso = old.strftime('%Y-%m-%dT%H:%M:%S') + 'Z'
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('''INSERT INTO pipeline_runs (id, project, pipeline_name, pipeline_type, status, queue_time, last_synced_at)
                        VALUES (901, 'Alpha', 'older', 'yaml', 'completed', ?, ?)''', (old_iso, pipeline_service._utcnow().isoformat()))
                    conn.commit()
                finally:
                    conn.close()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.requests, 'get', return_value=self._ok([])):
                    pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', days=7, force_refresh=True, include_cache_status=True)
                conn = sync_service.get_db_connection()
                try:
                    rows = conn.execute('SELECT id FROM pipeline_runs').fetchall()
                finally:
                    conn.close()
                self.assertEqual([row['id'] for row in rows], [901])

    def test_pipeline_total_failure_keeps_previous_rows_and_reports_stale(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(sync_service, 'DB_PATH', os.path.join(temp_dir, 'pipeline-failure.db')):
                pipeline_service.init_pipeline_db()
                conn = sync_service.get_db_connection()
                try:
                    conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
                    conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
                    conn.execute("INSERT INTO pipeline_runs (id, project, pipeline_name, pipeline_type, status, queue_time, last_synced_at) VALUES (1, 'Alpha', 'old', 'yaml', 'completed', '2026-11-01', '2026-11-01')")
                    conn.commit()
                finally:
                    conn.close()
                bad = type('Response', (), {'status_code': 500, 'json': lambda self: {}})()
                with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                        patch.object(sync_service, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.requests, 'get', return_value=bad):
                    result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', force_refresh=True, include_cache_status=True)
                self.assertEqual(result['cacheStatus']['outcome'], 'failed')
                self.assertTrue(result['cacheStatus']['stale'])
                with sync_service.get_db_connection() as conn:
                    rows = conn.execute('SELECT id FROM pipeline_runs').fetchall()
                self.assertEqual([row['id'] for row in rows], [1])

    @staticmethod
    def _ok(value):
        return type('Response', (), {'status_code': 200, 'json': lambda self: {'value': value}})()

    def test_pipeline_health_defaults_to_30_days_for_source_and_summary(self):
        import app as api_app

        with patch.object(api_app, '_load_all_pipelines', return_value=[]) as load_runs, \
                patch.object(api_app.pipeline_service, 'compute_pipeline_summary',
                             return_value=self._empty_pipeline_summary()) as summarize:
            response = api_app.app.test_client().get('/api/pipeline-health')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['period_days'], 30)
        load_runs.assert_called_once_with(days=30, force_refresh=False)
        summarize.assert_called_once_with([], days=30)

    def test_pipeline_health_passes_explicit_7_and_30_day_windows_consistently(self):
        import app as api_app

        for days in (7, 30):
            with self.subTest(days=days), \
                    patch.object(api_app, '_load_all_pipelines', return_value=[]) as load_runs, \
                    patch.object(api_app.pipeline_service, 'compute_pipeline_summary',
                                 return_value=self._empty_pipeline_summary()) as summarize:
                response = api_app.app.test_client().get(f'/api/pipeline-health?days={days}')

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['period_days'], days)
            load_runs.assert_called_once_with(days=days, force_refresh=False)
            summarize.assert_called_once_with([], days=days)

    def test_pipeline_health_rejects_invalid_days_with_400(self):
        import app as api_app

        for value in ('', 'abc', '0', '-7', '8'):
            with self.subTest(days=value), \
                    patch.object(api_app, '_load_all_pipelines') as load_runs:
                response = api_app.app.test_client().get(f'/api/pipeline-health?days={value}')

            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.get_json()['error'], 'days must be one of: 7, 14, 30, 90')
            load_runs.assert_not_called()

    @staticmethod
    def _empty_pipeline_summary():
        return {
            'totalRuns': 0, 'succeeded': 0, 'failed': 0, 'partiallySucceeded': 0,
            'inProgress': 0, 'canceled': 0, 'successRate': 100.0,
            'failedRuns': [], 'dailyStats': [],
        }

    def test_parse_azure_build_separation_of_status_and_result(self):
        raw = {
            "id": 1050,
            "buildNumber": "20261106.1",
            "status": "completed",
            "result": "succeeded",
            "project": {"name": "Alpha"},
            "definition": {"id": 1, "name": "Alpha.CI", "type": "yaml"},
            "sourceBranch": "refs/heads/feature/token",
            "sourceVersion": "abc12345",
            "requestedFor": {"displayName": "Fixture Person A"},
            "queueTime": "2026-11-06T10:00:00Z",
            "startTime": "2026-11-06T10:01:00Z",
            "finishTime": "2026-11-06T10:03:30Z",
            "_links": {"web": {"href": "https://dev.azure.com/org/Alpha/_build/results?buildId=1050"}}
        }

        parsed = pipeline_service.parse_azure_build(raw, "https://dev.azure.com/org")
        self.assertEqual(parsed["id"], 1050)
        self.assertEqual(parsed["project"], "Alpha")
        self.assertEqual(parsed["pipelineName"], "Alpha.CI")
        self.assertEqual(parsed["pipelineType"], "yaml")
        self.assertEqual(parsed["status"], "completed")
        self.assertEqual(parsed["result"], "succeeded")
        self.assertEqual(parsed["sourceBranch"], "feature/token")
        self.assertEqual(parsed["sourceVersion"], "abc12345")
        self.assertEqual(parsed["durationSeconds"], 150)
        self.assertEqual(parsed["url"], "https://dev.azure.com/org/Alpha/_build/results?buildId=1050")

    def test_fixture_pipelines_counts_and_types(self):
        self.assertGreaterEqual(len(self.fixture_runs), 20)
        yaml_runs = [r for r in self.fixture_runs if r["pipelineType"] == "yaml"]
        classic_runs = [r for r in self.fixture_runs if r["pipelineType"] == "classic"]
        self.assertGreater(len(yaml_runs), 0)
        self.assertGreater(len(classic_runs), 0)

        in_progress = [r for r in self.fixture_runs if r["status"] == "inProgress"]
        self.assertGreater(len(in_progress), 0)

    def test_query_pipeline_runs_pagination(self):
        p1 = pipeline_service.query_pipeline_runs(self.fixture_runs, {"limit": "5", "offset": "0"})
        self.assertEqual(len(p1["items"]), 5)
        self.assertEqual(p1["limit"], 5)
        self.assertEqual(p1["offset"], 0)
        self.assertTrue(p1["hasMore"])

        p2 = pipeline_service.query_pipeline_runs(self.fixture_runs, {"limit": "5", "offset": "5"})
        self.assertEqual(len(p2["items"]), 5)
        self.assertEqual(p2["offset"], 5)
        ids1 = {r["id"] for r in p1["items"]}
        ids2 = {r["id"] for r in p2["items"]}
        self.assertEqual(len(ids1 & ids2), 0)

    def test_query_pipeline_runs_filters(self):
        # Project filter
        alpha = pipeline_service.query_pipeline_runs(self.fixture_runs, {"project": "Alpha"})
        for r in alpha["items"]:
            self.assertEqual(r["project"], "Alpha")

        # Result filter
        failed = pipeline_service.query_pipeline_runs(self.fixture_runs, {"result": "failed"})
        for r in failed["items"]:
            self.assertEqual(r["result"], "failed")

        # Search query
        search_res = pipeline_service.query_pipeline_runs(self.fixture_runs, {"search": "alpha.ci"})
        for r in search_res["items"]:
            self.assertIn("alpha.ci", r["pipelineName"].lower())

    def test_compute_pipeline_summary_success_rate_denominator(self):
        # Verify success rate uses completed runs (succeeded / (succeeded + failed + partiallySucceeded))
        summary = pipeline_service.compute_pipeline_summary(self.fixture_runs, days=30)
        self.assertIn("successRate", summary)
        self.assertIn("succeeded", summary)
        self.assertIn("failed", summary)
        self.assertIn("inProgress", summary)
        self.assertGreater(summary["totalRuns"], 0)

        completed = summary["succeeded"] + summary["failed"] + summary["partiallySucceeded"]
        expected_rate = round((summary["succeeded"] / completed * 100), 1) if completed > 0 else 100.0
        self.assertEqual(summary["successRate"], expected_rate)

    def test_get_single_run_details(self):
        run = pipeline_service.get_single_run_details(self.fixture_runs, 101, project="Alpha")
        self.assertIsNotNone(run)
        self.assertEqual(run["id"], 101)
        self.assertEqual(run["project"], "Alpha")

        missing = pipeline_service.get_single_run_details(self.fixture_runs, 999999)
        self.assertIsNone(missing)


if __name__ == '__main__':
    unittest.main()
