"""GET /api/work-items/window: windowed Work Item rows (completed by ClosedDate, created by CreatedDate).

Rows come only from ``work_items_window``; the active ``work_items`` cache is never read or written."""
import unittest
from unittest.mock import patch, MagicMock

import testsupport  # noqa: F401  (must precede the project imports)
import activity_jobs
import azure_client
import coverage_ledger
import persistence
import project_scope
import work_item_window
from test_work_item_window import ORG, PAT, rel, window_for, DbCase


class ListRouteTests(DbCase):
    def setUp(self):
        super().setUp()
        import app as api_app
        self.api_app = api_app
        self.client = api_app.app.test_client()
        self.runner = activity_jobs.ChunkJobRunner(db_path=self.db_path, max_workers=2)
        self.patches = [
            patch.object(api_app, "_activity_runner", self.runner),
            patch.object(api_app.sync_service, "is_fixture_mode", return_value=False),
            patch.object(api_app, "get_devops_org_url", return_value=ORG),
            patch.object(api_app, "get_devops_org_name", return_value="org"),
            patch.object(api_app, "get_devops_pat", return_value=PAT),
            patch.object(work_item_window, "fetch_work_items_window", side_effect=AssertionError("upstream WIQL called")),
            patch.object(azure_client.AzureClient, "wiql_ids", side_effect=AssertionError("upstream WIQL called")),
            patch.object(api_app, "get_projects_data", side_effect=AssertionError("project discovery called")),
        ]
        for p in self.patches:
            p.start()
        conn = persistence.get_db_connection(self.db_path)
        project_scope.init_project_scope_db(conn)
        project_scope.save_project_set(conn, ORG, ["Alpha"], "2026-11-25T10:00:00Z")
        conn.close()
        self.chunks = api_app.activity_chunks.plan_month_chunks(window_for())
        self.scope = coverage_ledger.scope_key(ORG, ["Alpha"])
        self.q = f"startDate={rel(20)}&endDate={rel(5)}"
        conn = persistence.get_db_connection(self.db_path)
        work_item_window.init_window_db(conn)
        rows = []
        rows.append((2, "created", "Alpha", "Task", "Active", "b", "", f"{rel(12)}T00:00:00Z", None, None, None))
        for i in range(10, 16):  # six completed rows, two share a closed timestamp
            closed = f"{rel(8 if i < 12 else 9)}T00:00:00Z" if i < 12 else f"{rel(i - 5)}T00:00:00Z"
            rows.append((i, "completed", "Alpha", "Task", "Closed", f"c{i}", "Person A", f"{rel(60)}T00:00:00Z", closed, f"{rel(1)}T00:00:00Z", f"{ORG}/{i}"))
        rows.append((30, "completed", "Alpha", "Task", "Closed", "outside", "", f"{rel(60)}T00:00:00Z", f"{rel(50)}T00:00:00Z", None, None))
        conn.executemany(
            "INSERT INTO work_items_window (id, kind, project, type, state, title, assigned_to, created_date, closed_date, changed_date, url)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
        # Active cache row that matches the window; it must never be returned.
        conn.execute("INSERT INTO work_items VALUES (?,?,?,?,?,?,?,?)",
                     (500, "active match", "Task", "Closed", "Alpha", f"{rel(12)}T00:00:00Z", f"{rel(10)}T00:00:00Z", "x"))
        conn.commit()
        conn.close()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.runner.shutdown(wait=True)
        super().tearDown()

    def _allow_discovery(self):
        self.patches[-1].stop()
        self.patches.pop()
        return patch.object(self.api_app, "get_projects_data", return_value=[{"name": "Alpha"}])

    def _record(self, metric, complete):
        conn = persistence.get_db_connection(self.db_path)
        coverage_ledger.init_coverage_db(conn)
        for chunk in self.chunks:
            coverage_ledger.promote_chunk(conn, self.scope, metric, self.api_app.activity_chunks.chunk_key(chunk),
                                          self.api_app.activity_chunks.chunk_last_day(chunk), complete)
        conn.close()

    def _runner_mock(self, state="idle", pending=0):
        runner = MagicMock()
        runner.submit.return_value = "running"
        runner.status.return_value = {"state": state, "pending": pending, "completed": 0, "partial": 0, "failed": 0,
                                      "deferred": 0, "retryAfterSeconds": 0}
        return runner

    def lst(self, kind="completed", extra=""):
        return self.client.get(f"/api/work-items/window?kind={kind}&{self.q}{extra}")

    def test_cold_cache_reports_missing_and_never_calls_upstream(self):
        r = self.lst(extra="&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["cacheStatus"]["coverage"]["missing"], len(self.chunks))
        self.assertFalse(body["cacheStatus"]["complete"])
        self.assertEqual(body["cacheStatus"]["source"], "local-cache")
        self.assertEqual(body["projectScope"], "stored")
        for key in ("items", "total", "limit", "offset", "window", "job"):
            self.assertIn(key, body)

    def test_warm_returns_window_items_only_with_fields(self):
        self._record("workitems-completed", True)
        body = self.lst(extra="&mode=cache").get_json()
        self.assertTrue(body["cacheStatus"]["complete"])
        self.assertEqual(body["cacheStatus"]["coverage"]["complete"], len(self.chunks))
        ids = [i["id"] for i in body["items"]]
        self.assertEqual(body["total"], 6)
        self.assertNotIn(30, ids)
        first = body["items"][0]
        for key in ("id", "title", "type", "state", "project", "assignedTo", "createdDate", "closedDate", "changedDate", "url"):
            self.assertIn(key, first)

    def test_created_kind_returns_created_rows(self):
        body = self.lst("created", "&mode=cache").get_json()
        self.assertEqual([i["id"] for i in body["items"]], [2])

    def test_partial_coverage(self):
        self._record("workitems-completed", False)
        body = self.lst(extra="&mode=cache").get_json()
        self.assertGreaterEqual(body["cacheStatus"]["coverage"]["partial"], 1)
        self.assertFalse(body["cacheStatus"]["complete"])

    def test_polling_job_running_with_pending(self):
        runner = self._runner_mock("running", 2)
        with patch.object(self.api_app, "_activity_runner", runner), self._allow_discovery():
            body = self.lst().get_json()
        self.assertEqual(body["job"]["state"], "running")
        self.assertEqual(body["job"]["pending"], 2)
        self.assertEqual(runner.submit.call_args_list[0].args[1], "workitems-completed")
        self.assertEqual(body["projectScope"], "discovered")

    def test_refresh_discovery_failure_is_503(self):
        r = self.lst()  # discovery patched to raise
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.get_json(), {"error": "project list is unavailable"})

    def test_stable_pagination_and_order(self):
        full = self.lst(extra="&mode=cache&limit=200").get_json()["items"]
        keys = [(i["closedDate"], -i["id"]) for i in full]
        self.assertEqual(keys, sorted(keys, reverse=True))
        seen = []
        for offset in (0, 2, 4):
            page = self.lst(extra=f"&mode=cache&limit=2&offset={offset}").get_json()
            self.assertEqual(page["limit"], 2)
            self.assertEqual(page["offset"], offset)
            self.assertEqual(page["total"], 6)
            seen += [i["id"] for i in page["items"]]
        self.assertEqual(seen, [i["id"] for i in full])
        self.assertEqual(len(set(seen)), 6)

    def test_active_cache_is_isolated(self):
        ids = [i["id"] for i in self.lst(extra="&mode=cache&limit=200").get_json()["items"]]
        self.assertNotIn(500, ids)

    def test_invalid_inputs_are_400(self):
        for url in ("/api/work-items/window?kind=bogus&" + self.q,
                    "/api/work-items/window?" + self.q,
                    f"/api/work-items/window?kind=completed&{self.q}&limit=0",
                    f"/api/work-items/window?kind=completed&{self.q}&limit=201",
                    f"/api/work-items/window?kind=completed&{self.q}&limit=x",
                    f"/api/work-items/window?kind=completed&{self.q}&offset=-1",
                    "/api/work-items/window?kind=completed",
                    "/api/work-items/window?kind=completed&startDate=nope&endDate=nope"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 400, url)
            self.assertIn("error", r.get_json())

    def test_default_limit_and_no_stored_project_set(self):
        conn = persistence.get_db_connection(self.db_path)
        conn.close()
        body = self.lst(extra="&mode=cache").get_json()
        self.assertEqual(body["limit"], 50)
        self.assertEqual(body["offset"], 0)


class NoStoredScopeTests(DbCase):
    def test_unknown_scope_without_upstream(self):
        import app as api_app
        with patch.object(api_app.sync_service, "is_fixture_mode", return_value=False), \
                patch.object(api_app, "get_devops_org_url", return_value=ORG), \
                patch.object(api_app, "get_projects_data", side_effect=AssertionError("discovery")), \
                patch.object(work_item_window, "fetch_work_items_window", side_effect=AssertionError("upstream")):
            r = api_app.app.test_client().get(
                f"/api/work-items/window?kind=completed&startDate={rel(20)}&endDate={rel(5)}&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["projectScope"], "unknown")
        self.assertEqual(body["items"], [])


if __name__ == "__main__":
    unittest.main()
