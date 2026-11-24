"""Calendar date window behaviour for pipeline and deployment services (synthetic data only)."""

import os
import tempfile
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import patch

import testsupport  # noqa: F401  (must precede the project imports)
import deployment_service
import feature_context
import persistence
import pipeline_service
from date_window import calendar_window, rolling_window

testsupport.isolate_database(globals())

TODAY = date(2028, 3, 10)


def _run(run_id, ts, result="succeeded"):
    return {"id": run_id, "project": "Alpha", "pipelineName": "P", "pipelineType": "yaml", "status": "completed",
            "result": result, "sourceBranch": "main", "requestedBy": "x", "queueTime": ts, "finishTime": ts}


def _dep(dep_id, ts, status="succeeded"):
    return {"id": dep_id, "project": "Alpha", "environmentName": "Production", "definitionName": "D",
            "status": status, "startedOn": ts, "completedOn": ts, "requestedBy": "x"}


def _ok(value):
    return type('Response', (), {'status_code': 200, 'headers': {}, 'json': lambda self: {'value': value}})()


class QueryWindowTests(unittest.TestCase):
    def test_pipeline_calendar_window_boundaries_across_leap_day(self):
        window = calendar_window(date(2028, 2, 28), date(2028, 3, 1), today=TODAY)
        runs = [
            _run(1, "2028-02-27T23:59:59Z"),  # day before start
            _run(2, "2028-02-28T00:00:00Z"),  # start day, first instant
            _run(3, "2028-02-29T12:00:00Z"),  # leap day
            _run(4, "2028-03-01T23:59:59Z"),  # end day, last instant
            _run(5, "2028-03-02T00:00:00Z"),  # day after end
        ]
        result = pipeline_service.query_pipeline_runs(runs, {"limit": 100}, window=window)
        self.assertEqual(sorted(r["id"] for r in result["items"]), [2, 3, 4])
        summary = result["summary"]
        self.assertEqual(summary["periodDays"], 3)
        self.assertEqual([d["date"] for d in summary["dailyStats"]], ["28 Feb", "29 Feb", "01 Mar"])
        self.assertEqual(sum(d["total"] for d in summary["dailyStats"]), 3)

    def test_deployment_calendar_window_boundaries(self):
        window = calendar_window(date(2028, 2, 28), date(2028, 3, 1), today=TODAY)
        deps = [
            _dep(1, "2028-02-27T23:59:59Z"),
            _dep(2, "2028-02-28T00:00:00Z"),
            _dep(3, "2028-03-01T23:59:59Z"),
            _dep(4, "2028-03-02T00:00:00Z"),
        ]
        result = deployment_service.query_deployments(deps, {"limit": 100}, window=window)
        self.assertEqual(sorted(d["id"] for d in result["items"]), [2, 3])
        self.assertEqual(result["summary"]["periodDays"], 3)
        self.assertEqual([d["date"] for d in result["summary"]["dailyStats"]], ["28 Feb", "29 Feb", "01 Mar"])
        self.assertEqual(sum(d["total"] for d in result["summary"]["dailyStats"]), 2)

    def test_missing_timestamp_is_kept_in_calendar_window(self):
        window = calendar_window(date(2028, 3, 1), date(2028, 3, 2), today=TODAY)
        run = _run(9, "")
        run["queueTime"] = run["finishTime"] = None
        self.assertEqual(len(pipeline_service.query_pipeline_runs([run], {}, window=window)["items"]), 1)
        dep = _dep(9, None)
        dep["completedOn"] = None
        self.assertEqual(len(deployment_service.query_deployments([dep], {}, window=window)["items"]), 1)

    def test_rolling_output_is_unchanged_without_window(self):
        now = datetime.utcnow()
        fmt = lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        runs = [_run(1, fmt(now - timedelta(days=1))), _run(2, fmt(now - timedelta(days=20)))]
        deps = [_dep(1, fmt(now - timedelta(days=1))), _dep(2, fmt(now - timedelta(days=20)))]
        implicit = pipeline_service.query_pipeline_runs(runs, {"days": 7})
        explicit = pipeline_service.query_pipeline_runs(runs, {"days": 7}, window=rolling_window(7))
        self.assertEqual([r["id"] for r in implicit["items"]], [1])
        self.assertEqual(implicit["summary"]["periodDays"], 7)
        self.assertEqual(len(implicit["summary"]["dailyStats"]), 7)
        self.assertEqual(implicit["summary"]["dailyStats"], explicit["summary"]["dailyStats"])
        dep_implicit = deployment_service.query_deployments(deps, {"days": 7})
        self.assertEqual([d["id"] for d in dep_implicit["items"]], [1])
        self.assertEqual(len(dep_implicit["summary"]["dailyStats"]), 7)
        self.assertEqual(deployment_service.compute_deployment_summary(deps, 7)["periodDays"], 7)
        self.assertEqual(pipeline_service.compute_pipeline_summary(runs, 7)["periodDays"], 7)


class CalendarSyncTests(unittest.TestCase):
    def setUp(self):
        self.window = calendar_window(date(2028, 3, 1), date(2028, 3, 3), today=TODAY)

    def _state_rows(self, table):
        with persistence.get_db_connection() as conn:
            return conn.execute(f"SELECT * FROM {table}").fetchall()

    def test_pipeline_calendar_fetch_is_bounded_and_does_not_touch_cache_state(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(persistence, 'DB_PATH', os.path.join(temp_dir, 'p.db')):
                pipeline_service.init_pipeline_db()
                raw = [{"id": 1, "project": {"name": "Alpha"}, "queueTime": "2028-03-02T01:00:00Z", "finishTime": "2028-03-02T01:05:00Z", "status": "completed", "result": "succeeded"},
                       {"id": 2, "project": {"name": "Alpha"}, "queueTime": "2028-03-04T01:00:00Z", "finishTime": "2028-03-04T01:05:00Z", "status": "completed", "result": "succeeded"}]
                with patch.object(feature_context, 'is_fixture_mode', return_value=False), \
                        patch.object(feature_context, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.azure_http, 'get', return_value=_ok(raw)) as get:
                    result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', project_scoped=False, window=self.window)
                    self.assertEqual([r["id"] for r in result], [1])
                    params = get.call_args.kwargs["params"]
                    self.assertEqual(params["minTime"], "2028-03-01T00:00:00Z")
                    self.assertEqual(params["maxTime"], "2028-03-04T00:00:00Z")
                self.assertEqual(self._state_rows("pipeline_cache_state"), [])

    def test_pipeline_calendar_fetch_never_uses_rolling_cache_shortcut(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(persistence, 'DB_PATH', os.path.join(temp_dir, 'p.db')):
                pipeline_service.init_pipeline_db()
                now = pipeline_service._utcnow().isoformat()
                with persistence.get_db_connection() as conn:
                    conn.execute("INSERT INTO pipeline_cache_state (id, requested_days, attempted_at, completed_at, outcome, successful_projects) VALUES (1, 30, ?, ?, 'partial', '[]')", (now, now))
                    conn.commit()
                with patch.object(feature_context, 'is_fixture_mode', return_value=False), \
                        patch.object(feature_context, 'get_devops_headers', return_value={}), \
                        patch.object(pipeline_service.azure_http, 'get', return_value=_ok([])) as get:
                    pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'pat', days=30, project_scoped=False, window=self.window)
                self.assertGreaterEqual(get.call_count, 1)
                state = self._state_rows("pipeline_cache_state")
                self.assertEqual(len(state), 1)
                self.assertEqual(state[0]["completed_at"], now)  # untouched by the calendar fetch

    def test_deployment_calendar_fetch_is_bounded_keeps_rows_and_cache_state(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(persistence, 'DB_PATH', os.path.join(temp_dir, 'd.db')):
                deployment_service.init_deployment_db()
                now = deployment_service._utcnow().isoformat()
                with persistence.get_db_connection() as conn:
                    conn.execute("INSERT INTO deployment_cache_state (id, requested_days, attempted_at, completed_at, outcome, successful_projects) VALUES (1, 30, ?, ?, 'complete', '[]')", (now, now))
                    conn.execute('''INSERT INTO deployment_records (id, project, release_name, definition_name, environment_name,
                        status, started_on, last_synced_at) VALUES (500, 'Alpha', 'r', 'd', 'Production', 'succeeded', '2028-03-08T10:00:00Z', ?)''', (now,))
                    conn.commit()
                raw = [{"id": 1, "startedOn": "2028-03-02T01:00:00Z", "completedOn": "2028-03-02T01:05:00Z", "deploymentStatus": "succeeded"},
                       {"id": 2, "startedOn": "2028-03-05T01:00:00Z", "completedOn": "2028-03-05T01:05:00Z", "deploymentStatus": "succeeded"}]
                with patch.object(feature_context, 'is_fixture_mode', return_value=False), \
                        patch.object(feature_context, 'get_devops_headers', return_value={}), \
                        patch.object(deployment_service.project_inventory, 'discover_projects', return_value=(['Alpha'], True)), \
                        patch.object(deployment_service.azure_http, 'get', return_value=_ok(raw)) as get:
                    result = deployment_service.sync_live_deployments('https://dev.azure.com/org', 'org', 'pat', days=30, window=self.window)
                    self.assertEqual(get.call_count, 1)  # no cache shortcut despite fresh 30-day state
                    params = get.call_args.kwargs["params"]
                    self.assertEqual(params["minStartedTime"], "2028-03-01T00:00:00Z")
                    self.assertEqual(params["maxStartedTime"], "2028-03-04T00:00:00Z")
                self.assertEqual([d["id"] for d in result], [1])
                state = self._state_rows("deployment_cache_state")
                self.assertEqual(len(state), 1)
                self.assertEqual(state[0]["requested_days"], 30)
                self.assertEqual(state[0]["completed_at"], now)
                ids = sorted(r["id"] for r in self._state_rows("deployment_records"))
                self.assertEqual(ids, [1, 500])  # row outside the window was not deleted


if __name__ == "__main__":
    unittest.main()
