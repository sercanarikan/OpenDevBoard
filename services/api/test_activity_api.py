import os
import sqlite3
import tempfile
import time
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import patch

import activity_jobs
import persistence

PAT = "SECRET-PAT-VALUE-DO-NOT-LEAK"
ORG = "https://dev.example.invalid/org"


def rel(days_ago: int) -> str:
    """A date relative to the real UTC today, so the windows are always valid and in the past."""
    return (datetime.utcnow().date() - timedelta(days=days_ago)).isoformat()


class ActivityDailyRouteTests(unittest.TestCase):
    def _seed(self, statements):
        conn = sqlite3.connect(self.db_path)
        for sql, args in statements:
            conn.execute(sql, args)
        conn.commit()
        conn.close()

    def _seed_complete(self, source, label, day):
        import coverage_ledger
        scope = {
            "history": coverage_ledger.scope_key(ORG, [], actor_id="me-id"),
            "pipelines": coverage_ledger.scope_key(ORG, ["Alpha", "Beta"] if label == "ALL" else ["Alpha"]),
        }[source]
        conn = sqlite3.connect(self.db_path)
        coverage_ledger.init_coverage_db(conn)
        coverage_ledger.promote_chunk(conn, scope, source, day[:8] + "01", rel(0), True)
        conn.commit()
        conn.close()

    def test_my_history_counts_only_the_verified_actor_rows(self):
        import history_service
        day = rel(5)
        conn = sqlite3.connect(self.db_path)
        history_service.ensure_history_schema(conn)
        conn.close()
        self._seed([
            ("INSERT INTO history_events (id, event_type, occurred_at, project, entity_type, entity_id, title, summary, actor_name, actor_id, url, source_endpoint) VALUES (?, 'commit', ?, 'Alpha', 'commit', ?, 't', '', 'me', ?, '', '')", (f"m{i}", day + "T09:00:00Z", f"m{i}", "ME-ID")) for i in range(2)
        ] + [
            ("INSERT INTO history_events (id, event_type, occurred_at, project, entity_type, entity_id, title, summary, actor_name, actor_id, url, source_endpoint) VALUES ('o1', 'commit', ?, 'Alpha', 'commit', 'o1', 't', '', 'other', 'OTHER-ID', '', '')", (day + "T09:00:00Z",)),
        ])
        self._seed_complete("history", "ME-ID-scope", day)
        with patch.object(self.api_app, "_history_identity", return_value={"id": "me-id"}):
            body = self.get(f"metric=my-history&startDate={day}&endDate={day}&mode=cache").get_json()
        self.assertEqual(body["days"][0]["count"], 2)
        with patch.object(self.api_app, "_history_identity", return_value={}):
            response = self.get(f"metric=my-history&startDate={day}&endDate={day}&mode=cache")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["error"], "identity is unavailable")

    def test_projects_filter_narrows_counts_and_coverage_scope(self):
        import project_scope
        day = rel(5)
        conn = sqlite3.connect(self.db_path)
        project_scope.init_project_scope_db(conn)
        project_scope.save_project_set(conn, ORG, ["Alpha", "Beta"], "2026-01-01T00:00:00Z")
        conn.commit()
        conn.close()
        self._seed([
            ("INSERT INTO pipeline_runs (id, project, queue_time) VALUES (?, ?, ?)", (1, "Alpha", day + "T10:00:00Z")),
            ("INSERT INTO pipeline_runs (id, project, queue_time) VALUES (?, ?, ?)", (2, "Beta", day + "T10:00:00Z")),
            ("INSERT INTO pipeline_runs (id, project, queue_time) VALUES (?, ?, ?)", (3, "Beta", day + "T11:00:00Z")),
        ])
        self._seed_complete("pipelines", "ALL", day)
        everything = self.get(f"metric=pipelines&startDate={day}&endDate={day}&mode=cache").get_json()
        self._seed_complete("pipelines", "ALPHA", day)
        alpha = self.get(f"metric=pipelines&startDate={day}&endDate={day}&mode=cache&projects=Alpha").get_json()
        self.assertEqual(everything["days"][0]["count"], 3)
        self.assertEqual(alpha["days"][0]["count"], 1)

    def test_unavailable_retention_days_never_report_the_window_as_complete(self):
        with patch.dict(os.environ, {"ACTIVITY_RETENTION_DAYS": "30"}):
            body = self.get(f"metric=pipelines&startDate={rel(60)}&endDate={rel(50)}&mode=cache").get_json()
        states = {d["state"] for d in body["days"]}
        self.assertEqual(states, {"unavailable_retention"})
        self.assertFalse(body["cacheStatus"]["complete"])
        self.assertEqual(body["cacheStatus"]["unavailableRetentionDays"], len(body["days"]))

    def setUp(self):
        import app as api_app
        self.api_app = api_app
        self.client = api_app.app.test_client()
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "activity.db")
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE pipeline_runs (id INTEGER, project TEXT, queue_time TEXT)")
        conn.execute("CREATE TABLE deployment_records (id INTEGER, project TEXT, started_on TEXT)")
        conn.execute("CREATE TABLE team_commits (commit_id TEXT, project TEXT, repository TEXT, date TEXT)")
        conn.commit()
        conn.close()
        self.runner = activity_jobs.ChunkJobRunner(db_path=self.db_path, max_workers=2)
        self.patches = [
            patch.object(persistence, "DB_PATH", self.db_path),
            patch.object(api_app, "_activity_runner", self.runner),
            patch.object(api_app.sync_service, "is_fixture_mode", return_value=False),
            patch.object(api_app, "get_projects_data", return_value=[{"name": "Alpha"}]),
            patch.object(api_app, "get_devops_org_url", return_value=ORG),
            patch.object(api_app, "get_devops_org_name", return_value="org"),
            patch.object(api_app, "get_devops_pat", return_value=PAT),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.runner.shutdown(wait=True)
        self._tmp.cleanup()

    def get(self, query):
        return self.client.get(f"/api/activity/daily?{query}")

    def wait_for_jobs(self, query, timeout=5.0):
        deadline = time.time() + timeout
        body = None
        while time.time() < deadline:
            body = self.get(query + "&mode=cache").get_json()
            if body.get("job", {}).get("state") not in (None, "running"):
                return body
            time.sleep(0.02)
        self.fail(f"chunk jobs did not finish: {body}")

    @staticmethod
    def range_query(metric, start_ago, end_ago, mode=None):
        query = f"metric={metric}&startDate={rel(start_ago)}&endDate={rel(end_ago)}"
        return f"{query}&mode={mode}" if mode else query

    # --- validation -------------------------------------------------------

    def test_unknown_metric_is_rejected(self):
        self.assertEqual(self.get(self.range_query("drop", 3, 3)).status_code, 400)

    def test_pull_requests_are_not_a_supported_metric_yet(self):
        self.assertEqual(self.get(self.range_query("pull-requests", 3, 3)).status_code, 400)

    def test_missing_dates_are_rejected(self):
        self.assertEqual(self.get("metric=pipelines").status_code, 400)

    def test_invalid_mode_is_rejected(self):
        self.assertEqual(self.get(self.range_query("pipelines", 3, 3, mode="live")).status_code, 400)

    def test_span_over_three_years_is_rejected(self):
        response = self.get("metric=pipelines&startDate=2025-01-01&endDate=2028-01-02")
        self.assertEqual(response.status_code, 400)
        self.assertIn("1096", response.get_json()["error"])

    def test_start_older_than_the_age_limit_is_rejected(self):
        self.assertEqual(self.get(self.range_query("pipelines", 3651, 3651)).status_code, 400)

    def test_future_end_is_rejected(self):
        future = (date.today() + timedelta(days=2)).isoformat()
        self.assertEqual(self.get(f"metric=pipelines&startDate={future}&endDate={future}").status_code, 400)

    # --- cache mode --------------------------------------------------------

    def test_cache_mode_never_starts_fetches(self):
        with patch.object(activity_jobs, "build_live_fetchers", side_effect=AssertionError("upstream called")):
            response = self.get(self.range_query("pipelines", 20, 18, mode="cache"))
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual({d["state"] for d in body["days"]}, {"not_collected"})
        self.assertEqual(body["job"]["state"], "idle")
        self.assertFalse(body["cacheStatus"]["complete"])

    def test_cache_mode_never_calls_upstream_project_discovery(self):
        from unittest.mock import patch as p2
        with p2.object(self.api_app, "get_projects_data", side_effect=AssertionError("upstream project list called")):
            response = self.get(self.range_query("pipelines", 20, 18, mode="cache"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["projectScope"], "unknown")

    def test_cache_mode_uses_the_project_set_stored_by_refresh(self):
        import project_scope as ps
        conn = persistence.get_db_connection(self.db_path)
        ps.init_project_scope_db(conn)
        ps.save_project_set(conn, ORG, ["Alpha"], "2026-11-25T10:00:00Z")
        conn.close()
        from unittest.mock import patch as p2
        with p2.object(self.api_app, "get_projects_data", side_effect=AssertionError("upstream project list called")):
            body = self.get(self.range_query("pipelines", 20, 18, mode="cache")).get_json()
        self.assertEqual(body["projectScope"], "stored")

    def test_response_never_contains_the_pat(self):
        response = self.get(self.range_query("pipelines", 20, 18, mode="cache"))
        self.assertNotIn(PAT, response.get_data(as_text=True))

    # --- refresh mode ------------------------------------------------------

    @staticmethod
    def fake_fetchers(complete: bool):
        return {"pipelines": lambda chunk: complete, "deployments": lambda c: True, "commits": lambda c: True}

    def test_refresh_fetches_missing_months_then_reports_zero_activity(self):
        query = self.range_query("pipelines", 20, 5)
        with patch.object(activity_jobs, "build_live_fetchers", return_value=self.fake_fetchers(True)):
            first = self.get(query + "&mode=refresh")
            self.assertEqual(first.status_code, 200)
            body = self.wait_for_jobs(query)
        self.assertEqual(len(body["days"]), 16)
        self.assertEqual({d["state"] for d in body["days"]}, {"covered_zero"})
        self.assertTrue(body["cacheStatus"]["complete"])
        self.assertEqual(body["job"]["state"], "done")

    def test_partial_fetch_reports_partial_days_never_zero(self):
        query = self.range_query("pipelines", 20, 16)
        with patch.object(activity_jobs, "build_live_fetchers", return_value=self.fake_fetchers(False)):
            self.get(query + "&mode=refresh")
            body = self.wait_for_jobs(query)
        self.assertEqual({d["state"] for d in body["days"]}, {"partial"})
        self.assertEqual(body["job"]["state"], "partial")
        self.assertFalse(body["cacheStatus"]["complete"])

    def test_counts_come_from_source_rows_on_covered_days(self):
        day = rel(10)
        conn = sqlite3.connect(self.db_path)
        conn.executemany(
            "INSERT INTO pipeline_runs VALUES (?, ?, ?)",
            [(1, "Alpha", f"{day}T10:00:00Z"), (2, "Alpha", f"{day}T11:00:00Z"), (3, "Other", f"{day}T11:00:00Z")],
        )
        conn.commit()
        conn.close()
        query = self.range_query("pipelines", 12, 8)
        with patch.object(activity_jobs, "build_live_fetchers", return_value=self.fake_fetchers(True)):
            self.get(query + "&mode=refresh")
            body = self.wait_for_jobs(query)
        by_day = {d["date"]: d for d in body["days"]}
        self.assertEqual((by_day[day]["state"], by_day[day]["count"]), ("covered_active", 2))
        other = rel(9)
        self.assertEqual((by_day[other]["state"], by_day[other]["count"]), ("covered_zero", 0))

    def test_refused_submissions_are_reported_as_busy(self):
        class FullRunner:
            def submit(self, scope, metric, chunk, fetch):
                return activity_jobs.BUSY

            def status(self, scope, metric, chunk_keys):
                return {"state": "idle", "pending": 0, "completed": 0, "partial": 0, "failed": 0,
                        "deferred": 0, "busy": 0, "retryAfterSeconds": 0.0}

        query = self.range_query("pipelines", 20, 5)
        with patch.object(self.api_app, "_activity_runner", FullRunner()), \
                patch.object(activity_jobs, "build_live_fetchers", return_value=self.fake_fetchers(True)):
            body = self.get(query + "&mode=refresh").get_json()
        self.assertGreaterEqual(body["job"]["busy"], 1)

    def test_response_shape_contract(self):
        body = self.get(self.range_query("commits", 3, 2, mode="cache")).get_json()
        # projectScope is an additive field: stored / discovered / unknown.
        self.assertEqual(set(body), {"metric", "window", "days", "job", "cacheStatus", "projectScope"})
        self.assertEqual(body["window"]["timezone"], "UTC")
        self.assertEqual(set(body["days"][0]), {"date", "count", "state", "stale"})


if __name__ == "__main__":
    unittest.main()
