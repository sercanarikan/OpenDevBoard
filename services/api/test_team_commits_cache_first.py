"""Calendar team commits are cache-first: local rows plus coverage/job state, never blocked on upstream."""
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

import testsupport  # noqa: F401  (must precede the project imports)
import activity_jobs
import coverage_ledger
import date_window
import persistence
import project_scope
import team_service

ORG = "https://dev.example.invalid/org"
PAT = "SECRET-PAT-VALUE-DO-NOT-LEAK"


def rel(days_ago):
    return (datetime.utcnow().date() - timedelta(days=days_ago)).isoformat()


SCHEMA = """CREATE TABLE team_commits (
    commit_id TEXT NOT NULL, project TEXT NOT NULL, repository TEXT NOT NULL, author_name TEXT NOT NULL,
    author_email TEXT, date TEXT NOT NULL, comment TEXT, change_counts TEXT, url TEXT, last_synced_at TEXT,
    PRIMARY KEY (commit_id, repository))"""


def insert_commit(conn, cid, project, date, author="Fixture Person A"):
    conn.execute(
        "INSERT INTO team_commits (commit_id, project, repository, author_name, author_email, date, comment, url)"
        " VALUES (?, ?, ?, ?, '', ?, 'msg', 'u')", (cid, project, project + ".Repo", author, date))


def window_for(a=20, b=5):
    return date_window.parse_request_window({"startDate": rel(a), "endDate": rel(b)})


class LocalReadTests(unittest.TestCase):
    def test_returns_only_rows_inside_window_and_project_set(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(SCHEMA)
        insert_commit(conn, "a", "Alpha", f"{rel(10)}T10:00:00Z")
        insert_commit(conn, "b", "Alpha", f"{rel(40)}T10:00:00Z")   # outside window
        insert_commit(conn, "c", "Beta", f"{rel(10)}T10:00:00Z")    # outside project set
        rows = team_service.load_local_team_commits(conn, ["Alpha"], window_for())
        self.assertEqual([r["commitId"] for r in rows], ["a"])
        self.assertIn("author", rows[0])
        self.assertEqual(team_service.load_local_team_commits(conn, [], window_for()), [])


class CacheFirstRouteTests(unittest.TestCase):
    def setUp(self):
        import app as api_app
        self.api_app = api_app
        self.client = api_app.app.test_client()
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "p.db")
        conn = sqlite3.connect(self.db_path)
        conn.execute(SCHEMA)
        insert_commit(conn, "a", "Alpha", f"{rel(10)}T10:00:00Z")
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
            patch.object(team_service, "_load_live_prs_summary_only", return_value=[]),
            patch.object(api_app, "get_projects_data", side_effect=AssertionError("project discovery called")),
        ]
        for p in self.patches:
            p.start()
        conn = persistence.get_db_connection(self.db_path)
        project_scope.init_project_scope_db(conn)
        project_scope.save_project_set(conn, ORG, ["Alpha"], "2026-11-25T10:00:00Z")
        conn.close()
        self.window = window_for()
        self.chunks = self.api_app.activity_chunks.plan_month_chunks(self.window)
        self.keys = [self.api_app.activity_chunks.chunk_key(c) for c in self.chunks]
        self.scope = coverage_ledger.scope_key(ORG, ["Alpha"])
        self.q = f"startDate={rel(20)}&endDate={rel(5)}"

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.runner.shutdown(wait=True)
        self._tmp.cleanup()

    def _stop_discovery_guard(self):
        self.patches[-1].stop()

    def _record(self, coverage):
        conn = persistence.get_db_connection(self.db_path)
        coverage_ledger.init_coverage_db(conn)
        for chunk in self.chunks:
            coverage_ledger.promote_chunk(conn, self.scope, 'commits', self.api_app.activity_chunks.chunk_key(chunk), self.api_app.activity_chunks.chunk_last_day(chunk),
                                          coverage == coverage_ledger.COVERAGE_COMPLETE)
        conn.close()

    def test_cold_cache_answers_immediately_without_upstream(self):
        with patch.object(team_service, "sync_live_team_activity", side_effect=AssertionError("upstream called")):
            r = self.client.get(f"/api/team-activity/commits?{self.q}&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["cacheStatus"]["coverage"], {"complete": 0, "partial": 0, "missing": len(self.chunks)})
        self.assertFalse(body["cacheStatus"]["complete"])
        self.assertEqual(body["job"]["state"], "idle")
        self.assertNotIn(PAT, r.get_data(as_text=True))

    def test_warm_cache_reports_complete_and_submits_nothing(self):
        self._record(coverage_ledger.COVERAGE_COMPLETE)
        runner = MagicMock()
        runner.status.return_value = {"state": "idle", "pending": 0, "completed": 0, "partial": 0, "failed": 0,
                                      "deferred": 0, "retryAfterSeconds": 0}
        with patch.object(self.api_app, "_activity_runner", runner), \
                patch.object(self.api_app, "get_projects_data", return_value=[{"name": "Alpha"}]):
            r = self.client.get(f"/api/team-activity/commits?{self.q}")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["cacheStatus"]["coverage"], {"complete": len(self.chunks), "partial": 0, "missing": 0})
        self.assertTrue(body["cacheStatus"]["complete"])
        self.assertEqual(body["total"], 1)
        self.assertIn(body["job"]["state"], ("done", "idle"))
        runner.submit.assert_not_called()

    def test_partial_coverage_is_reported(self):
        self._record(coverage_ledger.COVERAGE_PARTIAL)
        r = self.client.get(f"/api/team-activity/commits?{self.q}&mode=cache")
        body = r.get_json()
        self.assertGreaterEqual(body["cacheStatus"]["coverage"]["partial"], 1)
        self.assertFalse(body["cacheStatus"]["complete"])

    def test_polling_state_running_while_runner_pending(self):
        runner = MagicMock()
        runner.submit.return_value = "queued"
        runner.status.return_value = {"state": "running", "pending": 2, "completed": 0, "partial": 0, "failed": 0,
                                      "deferred": 0, "retryAfterSeconds": 2}
        with patch.object(self.api_app, "_activity_runner", runner), \
                patch.object(self.api_app, "get_projects_data", return_value=[{"name": "Alpha"}]):
            r = self.client.get(f"/api/team-activity/commits?{self.q}")
        body = r.get_json()
        self.assertEqual(body["job"]["state"], "running")
        self.assertEqual(body["job"]["busy"], 0)
        self.assertEqual(runner.submit.call_count, len(self.chunks))
        self.assertEqual(runner.submit.call_args[0][1], "commits")

    def test_busy_refusals_are_counted(self):
        runner = MagicMock()
        runner.submit.return_value = activity_jobs.BUSY
        runner.status.return_value = {"state": "running", "pending": 1}
        with patch.object(self.api_app, "_activity_runner", runner), \
                patch.object(self.api_app, "get_projects_data", return_value=[{"name": "Alpha"}]):
            r = self.client.get(f"/api/team-activity/commits?{self.q}")
        self.assertEqual(r.get_json()["job"]["busy"], len(self.chunks))

    def test_every_route_returns_200_with_documented_keys(self):
        expected = {
            "/api/team-activity": ("total_commits", "summary", "contributors", "repositories", "cacheStatus", "job"),
            "/api/team-activity/commits": ("items", "total", "cacheStatus", "window", "job"),
            "/api/team-activity/summary": ("totalCommits", "contributors", "cacheStatus", "window", "job"),
            "/api/team-activity/repositories": ("repositories", "total", "cacheStatus", "window", "job"),
            "/api/team-activity/contributors": ("items", "total", "cacheStatus", "window", "job"),
        }
        for path, keys in expected.items():
            r = self.client.get(f"{path}?{self.q}&mode=cache")
            self.assertEqual(r.status_code, 200, path)
            body = r.get_json()
            for key in keys:
                self.assertIn(key, body, f"{path} missing {key}")
            self.assertIn("coverage", body["cacheStatus"], path)
        r = self.client.get(f"/api/team-activity/summary?{self.q}&mode=cache")
        self.assertEqual(r.get_json()["totalCommits"], 1)

    def test_pull_requests_stay_live(self):
        pr = {"id": 1, "project": "Alpha", "repository": "Alpha.Repo", "title": "t", "author": "Fixture Person A",
              "reviewers": [], "status": "active", "creationDate": f"{rel(10)}T10:00:00Z", "url": "u"}
        with patch.object(team_service, "_load_live_prs_summary_only", return_value=[pr]) as live:
            r = self.client.get(f"/api/team-activity/summary?{self.q}&mode=cache")
        live.assert_called_once()
        self.assertEqual(r.get_json()["totalPRs"], 1)

    def test_refresh_discovers_and_stores_project_set(self):
        conn = persistence.get_db_connection(self.db_path)
        conn.execute("DELETE FROM activity_project_sets")
        conn.commit()
        conn.close()
        self._stop_discovery_guard()
        try:
            with patch.object(self.api_app, "get_projects_data", return_value=[{"name": "Alpha"}, {"name": "Alpha"}]), \
                    patch.object(team_service, "sync_live_team_activity", side_effect=RuntimeError("boom")):
                r = self.client.get(f"/api/team-activity/commits?{self.q}")
        finally:
            self.patches[-1].start()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["total"], 1)
        conn = persistence.get_db_connection(self.db_path)
        self.assertEqual(project_scope.load_project_set(conn, ORG), ["Alpha"])
        conn.close()

    def test_refresh_returns_503_when_discovery_fails_on_every_route(self):
        self._stop_discovery_guard()
        try:
            with patch.object(self.api_app, "get_projects_data", side_effect=RuntimeError("x")):
                for path in ("/api/team-activity", "/api/team-activity/commits", "/api/team-activity/summary",
                             "/api/team-activity/repositories", "/api/team-activity/contributors"):
                    r = self.client.get(f"{path}?{self.q}")
                    self.assertEqual(r.status_code, 503, path)
                    self.assertEqual(r.get_json()["error"], "project list is unavailable", path)
        finally:
            self.patches[-1].start()

    def test_rolling_request_keeps_the_legacy_path(self):
        legacy = {"commits": [], "pullRequests": [], "cacheStatus": {"complete": True}}
        with patch.object(self.api_app.team_service, "sync_live_team_activity", return_value=legacy) as sync:
            r = self.client.get("/api/team-activity/commits?days=30")
        self.assertEqual(r.status_code, 200)
        sync.assert_called_once()
        self.assertNotIn("job", r.get_json())


if __name__ == "__main__":
    unittest.main()
