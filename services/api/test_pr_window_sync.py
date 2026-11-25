"""Window-aware pull request sync: created and completed are separate, persisted, chunked metrics."""
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

import testsupport  # noqa: F401  (must precede the project imports)
import activity_jobs
import activity_service
import coverage_ledger
import date_window
import persistence
import pr_service
import project_scope
import team_service

ORG = "https://dev.example.invalid/org"
PAT = "SECRET-PAT-VALUE-DO-NOT-LEAK"


def rel(days_ago):
    return (datetime.utcnow().date() - timedelta(days=days_ago)).isoformat()


def window_for(a=20, b=5):
    return date_window.parse_request_window({"startDate": rel(a), "endDate": rel(b)})


PR_SCHEMA = """CREATE TABLE pull_requests (
    id INTEGER NOT NULL, project TEXT NOT NULL, repository TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL, is_draft INTEGER DEFAULT 0, author_id TEXT, author_name TEXT, author_avatar TEXT,
    source_branch TEXT, target_branch TEXT, merge_status TEXT, creation_date TEXT, closed_date TEXT, url TEXT,
    reviewers_json TEXT, work_items_json TEXT, last_synced_at TEXT, PRIMARY KEY (id, project, repository))"""
COMMIT_SCHEMA = """CREATE TABLE team_commits (
    commit_id TEXT NOT NULL, project TEXT NOT NULL, repository TEXT NOT NULL, author_name TEXT NOT NULL,
    author_email TEXT, date TEXT NOT NULL, comment TEXT, change_counts TEXT, url TEXT, last_synced_at TEXT,
    PRIMARY KEY (commit_id, repository))"""


def insert_pr(conn, pr_id, project, created, closed, status):
    conn.execute(
        "INSERT INTO pull_requests (id, project, repository, title, status, author_name, creation_date, closed_date,"
        " url, reviewers_json, work_items_json) VALUES (?, ?, 'Repo', 't', ?, 'Fixture Person A', ?, ?, 'u', '[]', '[]')",
        (pr_id, project, status, created, closed))


def seed_prs(conn):
    # 1: created in window, completed AFTER the window  -> created only
    insert_pr(conn, 1, "Alpha", f"{rel(10)}T10:00:00Z", f"{rel(2)}T10:00:00Z", "completed")
    # 2: created BEFORE the window, completed inside    -> closed only
    insert_pr(conn, 2, "Alpha", f"{rel(40)}T10:00:00Z", f"{rel(8)}T10:00:00Z", "completed")
    # 3: created and abandoned inside the window        -> created only (not completed)
    insert_pr(conn, 3, "Alpha", f"{rel(12)}T10:00:00Z", f"{rel(11)}T10:00:00Z", "abandoned")
    # 4: other project                                  -> never
    insert_pr(conn, 4, "Beta", f"{rel(10)}T10:00:00Z", f"{rel(9)}T10:00:00Z", "completed")


def raw_pr(pr_id, project, created, closed="", status="completed"):
    return {"pullRequestId": pr_id, "title": "t", "status": status, "creationDate": created, "closedDate": closed,
            "createdBy": {"id": "u1", "displayName": "Fixture Person A"}, "reviewers": [],
            "repository": {"name": "Repo", "project": {"name": project}}}


class FakeResponse:
    def __init__(self, status_code, value):
        self.status_code = status_code
        self._value = value

    def json(self):
        return {"value": self._value}


class LocalReadTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(PR_SCHEMA)
        seed_prs(self.conn)

    def ids(self, kind):
        return sorted(p["id"] for p in pr_service.load_local_pull_requests(self.conn, ["Alpha"], window_for(), kind))

    def test_created_and_closed_are_not_mixed(self):
        self.assertEqual(self.ids("created"), [1, 3])
        self.assertEqual(self.ids("closed"), [2])

    def test_unknown_kind_and_empty_projects(self):
        with self.assertRaises(ValueError):
            pr_service.load_local_pull_requests(self.conn, ["Alpha"], window_for(), "updated")
        self.assertEqual(pr_service.load_local_pull_requests(self.conn, [], window_for(), "created"), [])

    def test_team_shape_has_names_not_dicts(self):
        pr = pr_service.load_local_pull_requests(self.conn, ["Alpha"], window_for(), "created")[0]
        team = pr_service.to_team_pull_request(pr)
        for key in ("id", "project", "repository", "title", "author", "reviewers", "status", "creationDate", "url"):
            self.assertIn(key, team)
        self.assertEqual(team["author"], "Fixture Person A")


class ActivityMetricTests(unittest.TestCase):
    def test_daily_counts_keep_semantics_separate(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(PR_SCHEMA)
        seed_prs(conn)
        created = activity_service.daily_counts(conn, "pull-requests-created", ["Alpha"], window_for())
        closed = activity_service.daily_counts(conn, "pull-requests-closed", ["Alpha"], window_for())
        self.assertEqual(sum(created.values()), 2)
        self.assertEqual(created.get(rel(10)), 1)
        self.assertEqual(created.get(rel(12)), 1)
        self.assertEqual(closed, {rel(8): 1})  # abandoned PR 3 (closed in window) is not "completed"

    def test_build_live_fetchers_uses_window_fetch_per_kind(self):
        calls = []

        def fake(org, pat, projects, window, kind):
            calls.append((kind, projects))
            return [], True

        with patch.object(pr_service, "fetch_prs_window", side_effect=fake):
            fetchers = activity_jobs.build_live_fetchers(ORG, "org", PAT, projects=["Alpha"])
            self.assertTrue(fetchers["pull-requests-created"](window_for()))
            self.assertTrue(fetchers["pull-requests-closed"](window_for()))
        self.assertEqual(calls, [("created", ["Alpha"]), ("closed", ["Alpha"])])


class FetchWindowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "p.db")
        self.patch = patch.object(persistence, "DB_PATH", self.db_path)
        self.patch.start()
        conn = sqlite3.connect(self.db_path)
        conn.execute(PR_SCHEMA)
        conn.commit()
        conn.close()

    def tearDown(self):
        self.patch.stop()
        self._tmp.cleanup()

    def stored_ids(self):
        conn = sqlite3.connect(self.db_path)
        try:
            return sorted(r[0] for r in conn.execute("SELECT id FROM pull_requests"))
        finally:
            conn.close()

    def test_created_kind_query_and_upsert_keeps_rows_outside_window(self):
        seen = []

        def fake_get(url, stage, **kwargs):
            seen.append((url, kwargs.get("params")))
            page = [raw_pr(1, "Alpha", f"{rel(10)}T10:00:00Z"), raw_pr(9, "Alpha", f"{rel(60)}T10:00:00Z")] \
                if kwargs["params"]["$skip"] == 0 else []
            return FakeResponse(200, page)

        with patch.object(pr_service, "_pr_get", side_effect=fake_get):
            rows, complete = pr_service.fetch_prs_window(ORG, PAT, ["Alpha"], window_for(), "created")
        self.assertTrue(complete)
        self.assertEqual(sorted(r["id"] for r in rows), [1, 9])
        self.assertEqual(self.stored_ids(), [1, 9])  # nothing dropped for being outside the window
        params = seen[0][1]
        self.assertEqual(params["searchCriteria.status"], "all")
        self.assertEqual(params["searchCriteria.queryTimeRangeType"], "created")
        self.assertEqual(params["searchCriteria.minTime"], window_for().iso_start())
        self.assertEqual(params["searchCriteria.maxTime"], window_for().iso_end())

    def test_closed_kind_asks_for_completed_by_closed_time(self):
        seen = []

        def fake_get(url, stage, **kwargs):
            seen.append(kwargs["params"])
            return FakeResponse(200, [])

        with patch.object(pr_service, "_pr_get", side_effect=fake_get):
            rows, complete = pr_service.fetch_prs_window(ORG, PAT, ["Alpha"], window_for(), "closed")
        self.assertTrue(complete)
        self.assertEqual(seen[0]["searchCriteria.status"], "completed")
        self.assertEqual(seen[0]["searchCriteria.queryTimeRangeType"], "closed")

    def test_unknown_kind_is_rejected_before_any_request(self):
        with patch.object(pr_service, "_pr_get", side_effect=AssertionError("called")):
            with self.assertRaises(ValueError):
                pr_service.fetch_prs_window(ORG, PAT, ["Alpha"], window_for(), "updated")

    def test_page_budget_hit_is_partial(self):
        full = [raw_pr(i, "Alpha", f"{rel(10)}T10:00:00Z") for i in range(pr_service.PR_PAGE_SIZE)]
        with patch.object(pr_service, "PR_PROJECT_MAX_PAGES", 1), \
                patch.object(pr_service, "_pr_get", return_value=FakeResponse(200, full)):
            rows, complete = pr_service.fetch_prs_window(ORG, PAT, ["Alpha"], window_for(), "created")
        self.assertFalse(complete)
        self.assertEqual(len(rows), pr_service.PR_PAGE_SIZE)

    def test_failure_in_one_project_is_partial_and_keeps_other_rows(self):
        def fake_get(url, stage, **kwargs):
            if "/Beta/" in url:
                return FakeResponse(500, [])
            return FakeResponse(200, [raw_pr(1, "Alpha", f"{rel(10)}T10:00:00Z")] if kwargs["params"]["$skip"] == 0 else [])

        with patch.object(pr_service, "_pr_get", side_effect=fake_get):
            rows, complete = pr_service.fetch_prs_window(ORG, PAT, ["Alpha", "Beta"], window_for(), "created")
        self.assertFalse(complete)
        self.assertEqual(self.stored_ids(), [1])

    def test_exception_is_partial(self):
        with patch.object(pr_service, "_pr_get", side_effect=RuntimeError("boom " + PAT)):
            rows, complete = pr_service.fetch_prs_window(ORG, PAT, ["Alpha"], window_for(), "created")
        self.assertFalse(complete)
        self.assertEqual(rows, [])


class RouteTests(unittest.TestCase):
    def setUp(self):
        import app as api_app
        self.api_app = api_app
        self.client = api_app.app.test_client()
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "p.db")
        conn = sqlite3.connect(self.db_path)
        conn.execute(PR_SCHEMA)
        conn.execute(COMMIT_SCHEMA)
        seed_prs(conn)
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
            patch.object(api_app, "_get_pr_current_user", return_value={"groupIds": []}),
            patch.object(pr_service, "fetch_prs_window", side_effect=AssertionError("upstream PR list called")),
            patch.object(team_service, "_load_live_prs_summary_only", side_effect=AssertionError("live team PR fetch")),
            patch.object(team_service, "sync_live_team_activity", side_effect=AssertionError("upstream team sync")),
            patch.object(api_app, "get_projects_data", side_effect=AssertionError("project discovery called")),
        ]
        for p in self.patches:
            p.start()
        conn = persistence.get_db_connection(self.db_path)
        project_scope.init_project_scope_db(conn)
        project_scope.save_project_set(conn, ORG, ["Alpha"], "2026-11-25T10:00:00Z")
        conn.close()
        self.window = window_for()
        self.chunks = api_app.activity_chunks.plan_month_chunks(self.window)
        self.keys = [api_app.activity_chunks.chunk_key(c) for c in self.chunks]
        self.scope = coverage_ledger.scope_key(ORG, ["Alpha"])
        self.q = f"startDate={rel(20)}&endDate={rel(5)}"

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.runner.shutdown(wait=True)
        self._tmp.cleanup()

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

    def test_cold_answers_immediately_without_upstream(self):
        r = self.client.get(f"/api/pull-requests?{self.q}&mode=cache&status=all")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["cacheStatus"]["coverage"], {"complete": 0, "partial": 0, "missing": len(self.chunks)})
        self.assertFalse(body["cacheStatus"]["complete"])
        self.assertEqual(sorted(i["id"] for i in body["items"]), [1, 3])
        self.assertNotIn(PAT, r.get_data(as_text=True))

    def test_warm_returns_rows_complete_and_submits_nothing(self):
        self._record("pull-requests-created", True)
        runner = self._runner_mock()
        with patch.object(self.api_app, "_activity_runner", runner), self._allow_discovery():
            r = self.client.get(f"/api/pull-requests?{self.q}&status=all")
        body = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(body["cacheStatus"]["coverage"], {"complete": len(self.chunks), "partial": 0, "missing": 0})
        self.assertTrue(body["cacheStatus"]["complete"])
        self.assertEqual(sorted(i["id"] for i in body["items"]), [1, 3])
        runner.submit.assert_not_called()

    def test_partial_coverage_is_reported(self):
        self._record("pull-requests-created", False)
        r = self.client.get(f"/api/pull-requests?{self.q}&mode=cache&status=all")
        body = r.get_json()
        self.assertGreaterEqual(body["cacheStatus"]["coverage"]["partial"], 1)
        self.assertFalse(body["cacheStatus"]["complete"])

    def test_polling_job_running_with_pending(self):
        runner = self._runner_mock("running", 2)
        with patch.object(self.api_app, "_activity_runner", runner), self._allow_discovery():
            r = self.client.get(f"/api/pull-requests?{self.q}&status=all")
        body = r.get_json()
        self.assertEqual(body["job"]["state"], "running")
        self.assertEqual(body["job"]["pending"], 2)
        self.assertTrue(runner.submit.called)
        self.assertEqual(runner.submit.call_args_list[0].args[1], "pull-requests-created")

    def test_created_and_closed_are_not_mixed_through_the_route(self):
        created = self.client.get(f"/api/pull-requests?{self.q}&mode=cache&status=all&dateField=created").get_json()
        closed = self.client.get(f"/api/pull-requests?{self.q}&mode=cache&status=all&dateField=closed").get_json()
        self.assertEqual(sorted(i["id"] for i in created["items"]), [1, 3])
        self.assertEqual([i["id"] for i in closed["items"]], [2])

    def test_closed_kind_uses_its_own_ledger_rows(self):
        self._record("pull-requests-created", True)
        body = self.client.get(f"/api/pull-requests?{self.q}&mode=cache&status=all&dateField=closed").get_json()
        self.assertEqual(body["cacheStatus"]["coverage"]["missing"], len(self.chunks))

    def test_invalid_date_field_is_400(self):
        r = self.client.get(f"/api/pull-requests?{self.q}&mode=cache&dateField=updated")
        self.assertEqual(r.status_code, 400)

    def test_summary_route(self):
        r = self.client.get(f"/api/pull-requests/summary?{self.q}&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        for key in ("needsMyReview", "createdByMe", "involved", "totalActive", "cacheStatus", "job"):
            self.assertIn(key, body)

    def test_team_activity_calendar_never_calls_live_pr_list(self):
        r = self.client.get(f"/api/team-activity?{self.q}&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["totalPRs"], 2)  # created semantics: PRs 1 and 3
        for key in ("summary", "contributors", "repositories", "totalCommits", "totalPRs", "cacheStatus"):
            self.assertIn(key, body)
        self.assertEqual(body["cacheStatus"]["pullRequestCoverage"],
                         {"complete": 0, "partial": 0, "missing": len(self.chunks)})
        self.assertFalse(body["cacheStatus"]["complete"])

    def test_team_activity_summary_route_pr_counts(self):
        r = self.client.get(f"/api/team-activity/summary?{self.q}&mode=cache")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["totalPRs"], 2)
        self.assertIn("pullRequestCoverage", body["cacheStatus"])

    def test_team_refresh_submits_pr_chunks_and_complete_when_both_covered(self):
        self._record("pull-requests-created", True)
        self._record("commits", True)
        runner = self._runner_mock()
        with patch.object(self.api_app, "_activity_runner", runner), self._allow_discovery():
            body = self.client.get(f"/api/team-activity?{self.q}").get_json()
        self.assertTrue(body["cacheStatus"]["complete"])
        runner.submit.assert_not_called()

    def test_team_polling_reports_running_when_pr_chunks_pending(self):
        runner = self._runner_mock("running", 1)
        with patch.object(self.api_app, "_activity_runner", runner), self._allow_discovery():
            body = self.client.get(f"/api/team-activity?{self.q}").get_json()
        self.assertEqual(body["job"]["state"], "running")
        metrics = {c.args[1] for c in runner.submit.call_args_list}
        self.assertIn("pull-requests-created", metrics)
        self.assertIn("commits", metrics)

    def test_rolling_team_request_keeps_live_path(self):
        with patch.object(team_service, "sync_live_team_activity",
                          return_value={"commits": [], "pullRequests": [],
                                        "cacheStatus": {"outcome": "complete", "complete": True, "stale": False}}) as live:
            r = self.client.get("/api/team-activity?days=30")
        self.assertEqual(r.status_code, 200)
        live.assert_called_once()


if __name__ == "__main__":
    unittest.main()
