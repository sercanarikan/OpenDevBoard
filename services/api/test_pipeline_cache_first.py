"""Calendar pipeline requests are cache-first: local rows plus coverage/job state, never blocked on upstream."""
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import testsupport  # noqa: F401  (must precede the project imports)
import activity_jobs
import date_window
import persistence
import pipeline_service
import project_scope

ORG = "https://dev.example.invalid/org"
PAT = "SECRET-PAT-VALUE-DO-NOT-LEAK"


def rel(days_ago):
    return (datetime.utcnow().date() - timedelta(days=days_ago)).isoformat()


SCHEMA = """CREATE TABLE pipeline_runs (
    id INTEGER NOT NULL, project TEXT NOT NULL, pipeline_id INTEGER, pipeline_name TEXT NOT NULL,
    pipeline_type TEXT NOT NULL DEFAULT 'yaml', build_number TEXT, status TEXT NOT NULL, result TEXT,
    source_branch TEXT, source_version TEXT, requested_by TEXT, queue_time TEXT, start_time TEXT,
    finish_time TEXT, duration_seconds INTEGER, url TEXT, last_synced_at TEXT, PRIMARY KEY (id, project))"""


def insert_run(conn, run_id, project, finish):
    conn.execute(
        "INSERT INTO pipeline_runs (id, project, pipeline_id, pipeline_name, build_number, status, result, queue_time, finish_time)"
        " VALUES (?, ?, 1, 'CI', ?, 'completed', 'succeeded', ?, ?)",
        (run_id, project, str(run_id), finish, finish),
    )


class LocalReadTests(unittest.TestCase):
    def test_returns_only_rows_inside_window_and_project_set(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(SCHEMA)
        insert_run(conn, 1, "Alpha", f"{rel(10)}T10:00:00Z")
        insert_run(conn, 2, "Alpha", f"{rel(40)}T10:00:00Z")   # outside window
        insert_run(conn, 3, "Beta", f"{rel(10)}T10:00:00Z")    # outside project set
        window = date_window.parse_request_window({"startDate": rel(20), "endDate": rel(5)})
        rows = pipeline_service.load_local_pipeline_runs(conn, ["Alpha"], window)
        self.assertEqual([r["id"] for r in rows], [1])
        self.assertEqual(pipeline_service.load_local_pipeline_runs(conn, [], window), [])


class CacheFirstRouteTests(unittest.TestCase):
    def setUp(self):
        import app as api_app
        self.api_app = api_app
        self.client = api_app.app.test_client()
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "p.db")
        conn = sqlite3.connect(self.db_path)
        conn.execute(SCHEMA)
        insert_run(conn, 1, "Alpha", f"{rel(10)}T10:00:00Z")
        conn.commit()
        conn.close()
        self.runner = activity_jobs.ChunkJobRunner(db_path=self.db_path, max_workers=2)
        self.patches = [
            patch.object(persistence, "DB_PATH", self.db_path),
            patch.object(api_app, "_activity_runner", self.runner),
            patch.object(api_app.sync_service, "is_fixture_mode", return_value=False),
            patch.object(api_app, "get_devops_org_url", return_value=ORG),
            patch.object(api_app, "get_devops_org_name", return_value="org"),
            patch.object(api_app, "get_devops_pat", return_value=PAT),
            patch.object(api_app, "get_projects_data", side_effect=AssertionError("project discovery called")),
        ]
        for p in self.patches:
            p.start()
        conn = persistence.get_db_connection(self.db_path)
        project_scope.init_project_scope_db(conn)
        project_scope.save_project_set(conn, ORG, ["Alpha"], "2026-11-25T10:00:00Z")
        conn.close()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.runner.shutdown(wait=True)
        self._tmp.cleanup()

    def test_summary_answers_immediately_without_upstream(self):
        with patch.object(pipeline_service, "sync_live_pipeline_runs", side_effect=AssertionError("upstream called")):
            r = self.client.get(f"/api/pipelines/summary?startDate={rel(20)}&endDate={rel(5)}&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["totalRuns"], 1)
        chunks = len(self.api_app.activity_chunks.plan_month_chunks(
            date_window.parse_request_window({"startDate": rel(20), "endDate": rel(5)})))
        self.assertEqual(body["cacheStatus"]["coverage"], {"complete": 0, "partial": 0, "missing": chunks})
        self.assertEqual(body["job"]["state"], "idle")
        self.assertNotIn(PAT, r.get_data(as_text=True))

    def test_default_mode_submits_chunks_and_reports_running_or_failed_but_never_blocks(self):
        with patch.object(self.api_app, "get_projects_data", return_value=[{"name": "Alpha"}]), \
                patch.object(pipeline_service, "sync_live_pipeline_runs", side_effect=RuntimeError("boom")):
            r = self.client.get(f"/api/pipelines/summary?startDate={rel(20)}&endDate={rel(5)}")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertIn(body["job"]["state"], ("running", "failed"))
        for key in ("pending", "completed", "partial", "failed", "deferred", "busy", "retryAfterSeconds"):
            self.assertIn(key, body["job"])

    def test_all_routes_accept_calendar_window_over_120_days(self):
        window = f"startDate={rel(150)}&endDate={rel(1)}&mode=cache"
        for path in ("/api/pipeline-health", "/api/pipelines/summary", "/api/pipelines", "/api/pipelines/runs"):
            r = self.client.get(f"{path}?{window}")
            self.assertEqual(r.status_code, 200, path)
            self.assertIn("coverage", r.get_json()["cacheStatus"], path)
            self.assertIn("job", r.get_json(), path)

    def test_refresh_discovers_and_stores_project_set(self):
        conn = persistence.get_db_connection(self.db_path)
        conn.execute("DELETE FROM activity_project_sets")
        conn.commit()
        conn.close()
        self.patches[-1].stop()
        try:
            with patch.object(self.api_app, "get_projects_data", return_value=[{"name": "Alpha"}, {"name": "Alpha"}]), \
                    patch.object(pipeline_service, "sync_live_pipeline_runs", side_effect=RuntimeError("boom")):
                r = self.client.get(f"/api/pipelines/summary?startDate={rel(20)}&endDate={rel(5)}")
        finally:
            self.patches[-1].start()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["totalRuns"], 1)
        conn = persistence.get_db_connection(self.db_path)
        self.assertEqual(project_scope.load_project_set(conn, ORG), ["Alpha"])
        conn.close()

    def test_refresh_returns_503_when_discovery_fails(self):
        self.patches[-1].stop()
        try:
            with patch.object(self.api_app, "get_projects_data", side_effect=RuntimeError("x")):
                r = self.client.get(f"/api/pipelines/summary?startDate={rel(20)}&endDate={rel(5)}")
        finally:
            self.patches[-1].start()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.get_json()["error"], "project list is unavailable")

    def test_rolling_request_keeps_the_legacy_path(self):
        legacy = {"items": [], "cacheStatus": {"complete": True}}
        with patch.object(self.api_app, "_load_all_pipelines", return_value=legacy) as loader:
            r = self.client.get("/api/pipelines/summary?days=30")
        self.assertEqual(r.status_code, 200)
        loader.assert_called_once()
        self.assertNotIn("job", r.get_json())


if __name__ == "__main__":
    unittest.main()
