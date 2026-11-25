"""Windowed work items: completed (ClosedDate) and created (CreatedDate) are separate, persisted, chunked metrics.

They live in ``work_items_window``; the active ``work_items`` cache is never touched."""
import hashlib
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

import testsupport  # noqa: F401  (must precede the project imports)
import activity_jobs
import activity_service
import azure_client
import coverage_ledger
import date_window
import persistence
import project_scope
import work_item_window

ORG = "https://dev.example.invalid/org"
PAT = "SECRET-PAT-VALUE-DO-NOT-LEAK"


def rel(days_ago):
    return (datetime.utcnow().date() - timedelta(days=days_ago)).isoformat()


def window_for(a=20, b=5):
    return date_window.parse_request_window({"startDate": rel(a), "endDate": rel(b)})


def raw_item(item_id, project, created, closed=None, state="Closed", assigned="Fixture Person A"):
    fields = {"System.Id": item_id, "System.TeamProject": project, "System.WorkItemType": "Task",
              "System.State": state, "System.Title": f"item {item_id}", "System.CreatedDate": created,
              "System.ChangedDate": f"{rel(1)}T00:00:00Z", "System.AssignedTo": {"displayName": assigned}}
    if closed:
        fields["Microsoft.VSTS.Common.ClosedDate"] = closed
    return {"id": item_id, "url": f"{ORG}/_apis/wit/workItems/{item_id}", "fields": fields}


class FakeClient:
    """Stands in for AzureClient: records WIQL where-clauses, serves details from a dict (read-only)."""

    def __init__(self, id_map=None, items=None, raise_on_wiql=None, wiql_ids_result=None):
        self.id_map = id_map or {}
        self.items = items or {}
        self.raise_on_wiql = raise_on_wiql
        self.wiql_ids_result = wiql_ids_result
        self.wheres = []
        self.detail_calls = []

    def wiql_ids(self, where, order_by='[System.Id]', top=None):
        self.wheres.append(where)
        if self.raise_on_wiql:
            raise self.raise_on_wiql
        if self.wiql_ids_result is not None:
            return self.wiql_ids_result
        key = "closed" if "ClosedDate" in where else "created"
        return list(self.id_map.get(key, []))

    def get_items(self, ids, expand_relations=True, fields=None, error_policy_omit=False, raise_on_error=False):
        self.detail_calls.append(list(ids))
        result = azure_client.FetchResult()
        for i in ids:
            if i in self.items:
                result.items[i] = self.items[i]
        result.batches = 1
        return result


WI_SCHEMA = """CREATE TABLE work_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
    state TEXT NOT NULL, project TEXT NOT NULL, created_date TEXT, changed_date TEXT, last_synced_at TEXT)"""


def table_checksum(conn, table):
    rows = conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
    return len(rows), hashlib.sha256(repr([tuple(r) for r in rows]).encode()).hexdigest()


class DbCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "w.db")
        self.patch = patch.object(persistence, "DB_PATH", self.db_path)
        self.patch.start()
        conn = sqlite3.connect(self.db_path)
        conn.execute(WI_SCHEMA)
        conn.executemany("INSERT INTO work_items VALUES (?,?,?,?,?,?,?,?)", [
            (100, "active a", "Task", "Active", "Alpha", f"{rel(3)}T00:00:00Z", f"{rel(1)}T00:00:00Z", "x"),
            (101, "active b", "Bug", "New", "Alpha", f"{rel(60)}T00:00:00Z", f"{rel(2)}T00:00:00Z", "x")])
        conn.commit()
        conn.close()

    def tearDown(self):
        self.patch.stop()
        self._tmp.cleanup()

    def conn(self):
        c = sqlite3.connect(self.db_path)
        c.row_factory = sqlite3.Row
        return c


class FetchTests(DbCase):
    def test_table_is_created_idempotently_and_work_items_unchanged(self):
        conn = self.conn()
        before = conn.execute("PRAGMA table_info(work_items)").fetchall()
        work_item_window.init_window_db(conn)
        work_item_window.init_window_db(conn)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(work_items_window)").fetchall()]
        self.assertEqual(cols, ["id", "kind", "project", "type", "state", "title", "assigned_to", "created_date",
                                "closed_date", "changed_date", "url", "last_synced_at"])
        self.assertEqual(before, conn.execute("PRAGMA table_info(work_items)").fetchall())

    def test_completed_wiql_uses_closed_date_and_state_filter_in_utc(self):
        w = window_for()
        client = FakeClient()
        rows, complete = work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha", "O'Brien"], w, "completed", client=client)
        self.assertTrue(complete)
        where = client.wheres[0]
        self.assertIn("[System.TeamProject] IN ('Alpha', 'O''Brien')", where)
        self.assertIn(f"[Microsoft.VSTS.Common.ClosedDate] >= '{w.iso_start()}'", where)
        self.assertIn(f"[Microsoft.VSTS.Common.ClosedDate] < '{w.iso_end()}'", where)
        self.assertIn("[System.State] IN ('Closed', 'Completed', 'Done', 'Resolved')", where)
        self.assertNotIn("ChangedDate", where)
        self.assertTrue(w.iso_start().endswith("T00:00:00Z"))

    def test_created_wiql_uses_created_date_and_no_state_filter(self):
        w = window_for()
        client = FakeClient()
        work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], w, "created", client=client)
        where = client.wheres[0]
        self.assertIn(f"[System.CreatedDate] >= '{w.iso_start()}'", where)
        self.assertIn(f"[System.CreatedDate] < '{w.iso_end()}'", where)
        self.assertNotIn("System.State", where)
        self.assertNotIn("ClosedDate", where)
        self.assertNotIn("ChangedDate", where)

    def test_unknown_kind_rejected_before_any_request(self):
        client = FakeClient(raise_on_wiql=AssertionError("called"))
        with self.assertRaises(ValueError):
            work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], window_for(), "changed", client=client)

    def test_details_are_batched_by_batch_size(self):
        ids = list(range(1, azure_client.BATCH_SIZE + 51))
        items = {i: raw_item(i, "Alpha", f"{rel(30)}T00:00:00Z", f"{rel(10)}T00:00:00Z") for i in ids}
        client = FakeClient(id_map={"closed": ids}, items=items)
        rows, complete = work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], window_for(), "completed", client=client)
        self.assertTrue(complete)
        self.assertEqual(len(rows), len(ids))
        self.assertEqual([len(c) for c in client.detail_calls], [azure_client.BATCH_SIZE, 50])

    def test_result_limit_hit_is_partial(self):
        ids = list(range(1, azure_client.WIQL_RESULT_LIMIT + 1))
        client = FakeClient(wiql_ids_result=ids, items={})
        rows, complete = work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], window_for(), "completed", client=client)
        self.assertFalse(complete)

    def test_size_limit_error_is_partial_not_exception(self):
        err = azure_client.AzureError("too many", status=400)
        err.size_limit = True
        client = FakeClient(raise_on_wiql=err)
        rows, complete = work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], window_for(), "created", client=client)
        self.assertFalse(complete)
        self.assertEqual(rows, [])

    def test_failed_detail_batch_is_partial_but_keeps_rows(self):
        class Flaky(FakeClient):
            def get_items(self, ids, **kw):
                r = super().get_items(ids, **kw)
                r.failed_batches.append([999])
                return r
        items = {1: raw_item(1, "Alpha", f"{rel(30)}T00:00:00Z", f"{rel(10)}T00:00:00Z")}
        client = Flaky(id_map={"closed": [1, 999]}, items=items)
        rows, complete = work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], window_for(), "completed", client=client)
        self.assertFalse(complete)
        self.assertEqual([r["id"] for r in rows], [1])

    def test_upstream_error_other_than_size_limit_propagates(self):
        client = FakeClient(raise_on_wiql=azure_client.AzureError("boom", status=500))
        with self.assertRaises(azure_client.AzureError):
            work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], window_for(), "completed", client=client)

    def test_isolation_between_kinds_and_active_cache_unchanged(self):
        w = window_for()
        closed_old_created = raw_item(1, "Alpha", f"{rel(90)}T00:00:00Z", f"{rel(10)}T00:00:00Z")
        active_new = raw_item(2, "Alpha", f"{rel(12)}T00:00:00Z", None, state="Active")
        client = FakeClient(id_map={"closed": [1], "created": [2]}, items={1: closed_old_created, 2: active_new})
        conn = self.conn()
        before = table_checksum(conn, "work_items")
        conn.close()
        work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], w, "completed", client=client)
        work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], w, "created", client=client)
        conn = self.conn()
        try:
            self.assertEqual(table_checksum(conn, "work_items"), before)
            completed = work_item_window.load_local_work_items_window(conn, ["Alpha"], w, "completed")
            created = work_item_window.load_local_work_items_window(conn, ["Alpha"], w, "created")
            self.assertEqual([r["id"] for r in completed], [1])  # closed in window, created earlier: completed only
            self.assertEqual([r["id"] for r in created], [2])    # created in window, still active: never completed
            self.assertEqual(completed[0]["closedDate"], f"{rel(10)}T00:00:00Z")
        finally:
            conn.close()

    def test_same_item_may_exist_under_both_kinds(self):
        w = window_for()
        both = raw_item(5, "Alpha", f"{rel(15)}T00:00:00Z", f"{rel(10)}T00:00:00Z")
        client = FakeClient(id_map={"closed": [5], "created": [5]}, items={5: both})
        work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], w, "completed", client=client)
        work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], w, "created", client=client)
        conn = self.conn()
        try:
            self.assertEqual(conn.execute("SELECT kind FROM work_items_window WHERE id = 5 ORDER BY kind").fetchall()[0][0], "completed")
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM work_items_window WHERE id = 5").fetchone()[0], 2)
        finally:
            conn.close()

    def test_rows_outside_window_and_other_kind_are_not_deleted_and_complete_fetch_drops_stale_in_window(self):
        w = window_for()
        conn = self.conn()
        work_item_window.init_window_db(conn)
        conn.executemany(
            "INSERT INTO work_items_window (id, kind, project, type, state, title, created_date, closed_date)"
            " VALUES (?,?,?,?,?,?,?,?)", [
                (10, "completed", "Alpha", "Task", "Closed", "old window", "2020-01-01T00:00:00Z", f"{rel(200)}T00:00:00Z"),
                (11, "completed", "Alpha", "Task", "Closed", "reopened", "2020-01-01T00:00:00Z", f"{rel(9)}T00:00:00Z"),
                (12, "created", "Alpha", "Task", "Active", "other kind", f"{rel(9)}T00:00:00Z", None)])
        conn.commit()
        conn.close()
        keep = raw_item(1, "Alpha", f"{rel(30)}T00:00:00Z", f"{rel(10)}T00:00:00Z")
        client = FakeClient(id_map={"closed": [1]}, items={1: keep})
        work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], w, "completed", client=client)
        conn = self.conn()
        try:
            ids = sorted((r[0], r[1]) for r in conn.execute("SELECT id, kind FROM work_items_window"))
        finally:
            conn.close()
        self.assertEqual(ids, [(1, "completed"), (10, "completed"), (12, "created")])  # 11 reopened: gone; others kept

    def test_partial_fetch_deletes_nothing(self):
        w = window_for()
        conn = self.conn()
        work_item_window.init_window_db(conn)
        conn.execute("INSERT INTO work_items_window (id, kind, project, type, state, title, created_date, closed_date)"
                     " VALUES (11,'completed','Alpha','Task','Closed','t','2020-01-01T00:00:00Z',?)", (f"{rel(9)}T00:00:00Z",))
        conn.commit()
        conn.close()
        client = FakeClient(wiql_ids_result=list(range(azure_client.WIQL_RESULT_LIMIT)), items={})
        _, complete = work_item_window.fetch_work_items_window(ORG, PAT, ["Alpha"], w, "completed", client=client)
        self.assertFalse(complete)
        conn = self.conn()
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM work_items_window WHERE id = 11").fetchone()[0], 1)
        finally:
            conn.close()

    def test_wiql_is_the_only_post_and_no_write_verbs(self):
        """The fetch uses AzureClient.wiql_ids / get_items only; check the module source for any other HTTP use."""
        src = open(work_item_window.__file__, encoding="utf-8").read()
        for needle in ("requests.", ".post(", ".put(", ".patch(", ".delete("):
            self.assertNotIn(needle, src)


class ReadAndMetricTests(DbCase):
    def test_load_local_reads_only_window_table_and_projects(self):
        conn = self.conn()
        work_item_window.init_window_db(conn)
        w = window_for()
        conn.executemany(
            "INSERT INTO work_items_window (id, kind, project, type, state, title, created_date, closed_date)"
            " VALUES (?,?,?,?,?,?,?,?)", [
                (1, "completed", "Alpha", "Task", "Closed", "in", f"{rel(40)}T00:00:00Z", f"{rel(10)}T00:00:00Z"),
                (2, "completed", "Beta", "Task", "Closed", "other project", f"{rel(40)}T00:00:00Z", f"{rel(10)}T00:00:00Z"),
                (3, "completed", "Alpha", "Task", "Closed", "outside", f"{rel(40)}T00:00:00Z", f"{rel(2)}T00:00:00Z"),
                (4, "created", "Alpha", "Task", "Active", "created", f"{rel(10)}T00:00:00Z", None)])
        conn.commit()
        self.assertEqual([r["id"] for r in work_item_window.load_local_work_items_window(conn, ["Alpha"], w, "completed")], [1])
        self.assertEqual([r["id"] for r in work_item_window.load_local_work_items_window(conn, ["Alpha"], w, "created")], [4])
        self.assertEqual(work_item_window.load_local_work_items_window(conn, [], w, "created"), [])
        with self.assertRaises(ValueError):
            work_item_window.load_local_work_items_window(conn, ["Alpha"], w, "changed")
        conn.close()

    def test_daily_counts_by_closed_and_created_date(self):
        conn = self.conn()
        work_item_window.init_window_db(conn)
        conn.executemany(
            "INSERT INTO work_items_window (id, kind, project, type, state, title, created_date, closed_date)"
            " VALUES (?,?,?,?,?,?,?,?)", [
                (1, "completed", "Alpha", "Task", "Closed", "a", f"{rel(40)}T00:00:00Z", f"{rel(10)}T00:00:00Z"),
                (2, "created", "Alpha", "Task", "Active", "b", f"{rel(12)}T00:00:00Z", None),
                (1, "created", "Alpha", "Task", "Closed", "a", f"{rel(40)}T00:00:00Z", f"{rel(10)}T00:00:00Z")])
        conn.commit()
        w = window_for()
        self.assertEqual(activity_service.daily_counts(conn, "workitems-completed", ["Alpha"], w), {rel(10): 1})
        self.assertEqual(activity_service.daily_counts(conn, "workitems-created", ["Alpha"], w), {rel(12): 1})
        conn.close()

    def test_build_live_fetchers_binds_projects_and_kind(self):
        calls = []

        def fake(org, pat, projects, window, kind, client=None):
            calls.append((kind, projects))
            return [], True
        with patch.object(work_item_window, "fetch_work_items_window", side_effect=fake):
            fetchers = activity_jobs.build_live_fetchers(ORG, "org", PAT, projects=["Alpha"])
            self.assertTrue(fetchers["workitems-completed"](window_for()))
            self.assertTrue(fetchers["workitems-created"](window_for()))
        self.assertEqual(calls, [("completed", ["Alpha"]), ("created", ["Alpha"])])


class RouteTests(DbCase):
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
        work_item_window.init_window_db(conn)
        conn.executemany(
            "INSERT INTO work_items_window (id, kind, project, type, state, title, created_date, closed_date)"
            " VALUES (?,?,?,?,?,?,?,?)", [
                (1, "completed", "Alpha", "Task", "Closed", "a", f"{rel(60)}T00:00:00Z", f"{rel(10)}T00:00:00Z"),
                (2, "created", "Alpha", "Task", "Active", "b", f"{rel(12)}T00:00:00Z", None)])
        conn.commit()
        conn.close()
        self.window = window_for()
        self.chunks = api_app.activity_chunks.plan_month_chunks(self.window)
        self.scope = coverage_ledger.scope_key(ORG, ["Alpha"])
        self.q = f"startDate={rel(20)}&endDate={rel(5)}"

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

    def get(self, metric, extra=""):
        return self.client.get(f"/api/activity/daily?{self.q}&metric={metric}{extra}")

    def test_cold_cache_mode_is_immediate_and_never_calls_upstream(self):
        r = self.get("workitems-completed", "&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["metric"], "workitems-completed")
        self.assertEqual(body["cacheStatus"]["notCollectedDays"], self.window.days)
        self.assertFalse(body["cacheStatus"]["complete"])
        self.assertEqual(body["job"]["state"], "idle")
        self.assertNotIn(PAT, r.get_data(as_text=True))

    def test_cold_reports_missing_chunk_count_in_ledger(self):
        conn = persistence.get_db_connection(self.db_path)
        keys = [self.api_app.activity_chunks.chunk_key(c) for c in self.chunks]
        cov = coverage_ledger.read_coverage(conn, self.scope, "workitems-completed", keys)
        conn.close()
        self.assertEqual(len(keys) - len(cov), len(self.chunks))  # missing == chunk count

    def test_warm_returns_counts_complete_and_submits_nothing(self):
        self._record("workitems-completed", True)
        self._record("workitems-created", True)
        runner = self._runner_mock()
        with patch.object(self.api_app, "_activity_runner", runner), self._allow_discovery():
            done = self.get("workitems-completed").get_json()
            made = self.get("workitems-created").get_json()
        self.assertTrue(done["cacheStatus"]["complete"])
        self.assertTrue(made["cacheStatus"]["complete"])
        self.assertEqual({d["date"]: d["count"] for d in done["days"]}[rel(10)], 1)
        self.assertEqual({d["date"]: d["count"] for d in made["days"]}[rel(12)], 1)
        self.assertEqual({d["date"]: d["count"] for d in made["days"]}[rel(10)], 0)  # closed-only item is not a created count
        self.assertEqual({d["date"]: d["count"] for d in done["days"]}[rel(12)], 0)  # active item is not a completed count
        runner.submit.assert_not_called()

    def test_partial_chunk_reports_partial(self):
        self._record("workitems-completed", False)
        body = self.get("workitems-completed", "&mode=cache").get_json()
        self.assertFalse(body["cacheStatus"]["complete"])
        self.assertGreaterEqual(body["cacheStatus"]["partialDays"], 1)
        self.assertTrue(all(d["state"] == "partial" for d in body["days"]))

    def test_polling_job_running_with_pending(self):
        runner = self._runner_mock("running", 2)
        with patch.object(self.api_app, "_activity_runner", runner), self._allow_discovery():
            body = self.get("workitems-created").get_json()
        self.assertEqual(body["job"]["state"], "running")
        self.assertEqual(body["job"]["pending"], 2)
        self.assertEqual(runner.submit.call_args_list[0].args[1], "workitems-created")
        self.assertEqual(runner.submit.call_count, len(self.chunks))

    def test_kinds_use_separate_ledger_rows(self):
        self._record("workitems-created", True)
        body = self.get("workitems-completed", "&mode=cache").get_json()
        self.assertFalse(body["cacheStatus"]["complete"])

    def test_refresh_discovers_and_saves_projects(self):
        runner = self._runner_mock()
        with patch.object(self.api_app, "_activity_runner", runner), self._allow_discovery():
            body = self.get("workitems-completed").get_json()
        self.assertEqual(body["projectScope"], "discovered")

    def test_chunk_job_end_to_end_with_fake_upstream_leaves_active_cache_alone(self):
        w = window_for()
        client = FakeClient(
            id_map={"closed": [7]},
            items={7: raw_item(7, "Alpha", f"{rel(90)}T00:00:00Z", f"{rel(9)}T00:00:00Z")})
        patches = [p for p in self.patches if getattr(p, "attribute", "") == "fetch_work_items_window"]
        for p in patches:
            p.stop()
        real = work_item_window.fetch_work_items_window
        conn = self.conn()
        before = table_checksum(conn, "work_items")
        conn.close()
        try:
            with patch.object(work_item_window, "fetch_work_items_window",
                              side_effect=lambda o, pat, projects, win, kind, client_=None: real(o, pat, projects, win, kind, client=client)), \
                    self._allow_discovery():
                fetchers = activity_jobs.build_live_fetchers(ORG, "org", PAT, projects=["Alpha"])
                self.assertTrue(fetchers["workitems-completed"](self.chunks[0]))
        finally:
            for p in patches:
                p.start()
        conn = self.conn()
        try:
            self.assertEqual(table_checksum(conn, "work_items"), before)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM work_items_window WHERE id = 7").fetchone()[0], 1)
        finally:
            conn.close()

    def test_invalid_metric_still_lists_new_metrics(self):
        body = self.client.get(f"/api/activity/daily?{self.q}&metric=nope").get_json()
        self.assertIn("workitems-completed", body["error"])
        self.assertIn("workitems-created", body["error"])


if __name__ == "__main__":
    unittest.main()
