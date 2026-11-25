"""Calendar My History is cache-first and identity-isolated: local rows for the verified user only, never blocked on upstream."""
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
import history_service
import persistence

ORG = "https://dev.example.invalid/org"
PAT = "SECRET-PAT-VALUE-DO-NOT-LEAK"
ME = {"id": "AAAA-1111", "displayName": "Fixture Person A", "uniqueName": "a@example.invalid"}
OTHER_ID = "bbbb-2222"


def rel(days_ago):
    return (datetime.utcnow().date() - timedelta(days=days_ago)).isoformat()


def insert_event(conn, eid, actor_id, when, actor_name="Fixture Person A", etype="git.commit", entity="commit"):
    conn.execute(
        "INSERT INTO history_events (id, event_type, occurred_at, project, entity_type, entity_id, title, summary,"
        " actor_name, actor_id, url, verification_status) VALUES (?, ?, ?, 'Alpha', ?, ?, 'title', 'sum', ?, ?, 'u', 'verified')",
        (eid, etype, when, entity, eid, actor_name, actor_id))


def window_for(a=20, b=5):
    return date_window.parse_request_window({"startDate": rel(a), "endDate": rel(b)})


class LocalReadTests(unittest.TestCase):
    def test_filters_by_actor_and_window(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        history_service.ensure_history_schema(conn)
        insert_event(conn, "mine", ME["id"].lower(), f"{rel(10)}T10:00:00Z")
        insert_event(conn, "old", ME["id"].lower(), f"{rel(40)}T10:00:00Z")
        insert_event(conn, "theirs", OTHER_ID, f"{rel(10)}T10:00:00Z", actor_name="Fixture Person A")
        rows = history_service.load_local_history(conn, ME["id"], window_for())
        self.assertEqual([r["id"] for r in rows], ["mine"])
        self.assertEqual(history_service.load_local_history(conn, "", window_for()), [])


class CacheFirstRouteTests(unittest.TestCase):
    def setUp(self):
        import app as api_app
        self.api_app = api_app
        self.client = api_app.app.test_client()
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "p.db")
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        history_service.ensure_history_schema(conn)
        insert_event(conn, "mine-1", ME["id"].lower(), f"{rel(10)}T10:00:00Z")
        insert_event(conn, "theirs-1", OTHER_ID, f"{rel(10)}T11:00:00Z", actor_name="Fixture Person A")
        conn.commit()
        conn.close()
        self.runner = activity_jobs.ChunkJobRunner(db_path=self.db_path, max_workers=2)
        self.patches = [
            patch.object(persistence, "DB_PATH", self.db_path),
            patch.object(api_app, "_activity_runner", self.runner),
            patch.object(api_app.sync_service, "is_fixture_mode", return_value=False),
            patch.object(api_app, "get_devops_org_url", return_value=ORG),
            patch.object(api_app, "get_devops_pat", return_value=PAT),
            patch.object(api_app, "get_current_user_info", return_value=dict(ME)),
        ]
        for p in self.patches:
            p.start()
        self.window = window_for()
        self.chunks = api_app.activity_chunks.plan_month_chunks(self.window)
        self.scope = coverage_ledger.scope_key(ORG, [], actor_id=ME["id"].lower())
        self.q = f"startDate={rel(20)}&endDate={rel(5)}"

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.runner.shutdown(wait=True)
        self._tmp.cleanup()

    def _record(self, coverage, scope=None):
        conn = persistence.get_db_connection(self.db_path)
        coverage_ledger.init_coverage_db(conn)
        ac = self.api_app.activity_chunks
        for chunk in self.chunks:
            coverage_ledger.promote_chunk(conn, scope or self.scope, 'history', ac.chunk_key(chunk), ac.chunk_last_day(chunk),
                                          coverage == coverage_ledger.COVERAGE_COMPLETE)
        conn.close()

    def _mock_runner(self, state="idle", submit=None):
        runner = MagicMock()
        runner.submit.return_value = submit or "queued"
        runner.status.return_value = {"state": state, "pending": 2 if state == "running" else 0, "completed": 0,
                                      "partial": 0, "failed": 0, "deferred": 0, "retryAfterSeconds": 0}
        return runner

    def test_cold_cache_answers_immediately_without_upstream(self):
        with patch.object(history_service, "sync_live_history", side_effect=AssertionError("upstream called")):
            r = self.client.get(f"/api/my-history/timeline?{self.q}&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["cacheStatus"]["coverage"], {"complete": 0, "partial": 0, "missing": len(self.chunks)})
        self.assertFalse(body["cacheStatus"]["complete"])
        self.assertEqual(body["job"]["state"], "idle")
        self.assertNotIn(PAT, r.get_data(as_text=True))

    def test_warm_cache_reports_complete_and_submits_nothing(self):
        self._record(coverage_ledger.COVERAGE_COMPLETE)
        runner = self._mock_runner()
        with patch.object(self.api_app, "_activity_runner", runner):
            r = self.client.get(f"/api/my-history/timeline?{self.q}")
        body = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(body["cacheStatus"]["coverage"], {"complete": len(self.chunks), "partial": 0, "missing": 0})
        self.assertTrue(body["cacheStatus"]["complete"])
        self.assertEqual(body["total"], 1)
        runner.submit.assert_not_called()

    def test_partial_coverage_is_reported(self):
        self._record(coverage_ledger.COVERAGE_PARTIAL)
        r = self.client.get(f"/api/my-history/timeline?{self.q}&mode=cache")
        body = r.get_json()
        self.assertGreaterEqual(body["cacheStatus"]["coverage"]["partial"], 1)
        self.assertFalse(body["cacheStatus"]["complete"])

    def test_polling_state_running_while_runner_pending(self):
        runner = self._mock_runner("running")
        with patch.object(self.api_app, "_activity_runner", runner):
            r = self.client.get(f"/api/my-history/timeline?{self.q}")
        body = r.get_json()
        self.assertEqual(body["job"]["state"], "running")
        self.assertEqual(runner.submit.call_count, len(self.chunks))
        self.assertEqual(runner.submit.call_args[0][1], "history")
        self.assertEqual(runner.submit.call_args[0][0], self.scope)

    def test_identity_isolation_other_actor_rows_never_returned(self):
        for path in ("/api/my-history/timeline", "/api/my-history"):
            r = self.client.get(f"{path}?{self.q}&mode=cache")
            self.assertEqual(r.status_code, 200, path)
            text = r.get_data(as_text=True)
            self.assertIn("mine-1", text)
            self.assertNotIn("theirs-1", text, path)
        r = self.client.get(f"/api/my-history/theirs-1?{self.q}&mode=cache")
        self.assertEqual(r.status_code, 404)

    def test_coverage_of_another_actor_is_not_reused(self):
        other_scope = coverage_ledger.scope_key(ORG, [], actor_id=OTHER_ID)
        self._record(coverage_ledger.COVERAGE_COMPLETE, scope=other_scope)
        r = self.client.get(f"/api/my-history/timeline?{self.q}&mode=cache")
        self.assertEqual(r.get_json()["cacheStatus"]["coverage"]["missing"], len(self.chunks))

    def test_unverifiable_identity_returns_503_without_rows(self):
        for user in ({}, {"id": "", "displayName": "Fixture Person A"}):
            with patch.object(self.api_app, "get_current_user_info", return_value=user):
                for path in ("/api/my-history", "/api/my-history/summary", "/api/my-history/timeline", "/api/my-history/mine-1"):
                    r = self.client.get(f"{path}?{self.q}")
                    self.assertEqual(r.status_code, 503, path)
                    body = r.get_json()
                    self.assertEqual(body, {"error": "identity is unavailable"}, path)

    def test_every_route_returns_200_with_documented_keys(self):
        expected = {
            "/api/my-history": ("period_days", "summary", "timeline", "events", "metrics", "cacheStatus", "job"),
            "/api/my-history/summary": ("totalEvents", "cacheStatus", "job"),
            "/api/my-history/timeline": ("items", "total", "cacheStatus", "job"),
            "/api/my-history/mine-1": ("id", "eventType"),
        }
        for path, keys in expected.items():
            r = self.client.get(f"{path}?{self.q}&mode=cache")
            self.assertEqual(r.status_code, 200, path)
            body = r.get_json()
            for key in keys:
                self.assertIn(key, body, f"{path} missing {key}")
            if path != "/api/my-history/mine-1":
                self.assertIn("coverage", body["cacheStatus"], path)

    def test_fetcher_syncs_chunk_for_the_verified_user(self):
        chunk = self.chunks[0]
        result = {"events": [], "cacheStatus": {"complete": True}}
        with patch.object(history_service, "sync_live_history", return_value=result) as sync:
            fetch = activity_jobs.build_history_fetcher(ORG, PAT, dict(ME))
            self.assertTrue(fetch(chunk))
        self.assertEqual(sync.call_args.kwargs["window"], chunk)
        self.assertEqual(sync.call_args[0][2]["id"], ME["id"])

    def test_rolling_request_keeps_the_legacy_path(self):
        legacy = {"events": []}
        with patch.object(history_service, "sync_live_history", return_value=legacy) as sync:
            r = self.client.get("/api/my-history/timeline?days=30")
        self.assertEqual(r.status_code, 200)
        sync.assert_called_once()
        self.assertNotIn("job", r.get_json())


if __name__ == "__main__":
    unittest.main()
