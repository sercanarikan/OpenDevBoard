"""Unit tests for the synthetic benchmark harness counters (the benchmark timings themselves are never asserted)."""
import os
import tempfile
import threading
import time
import unittest
from datetime import date, datetime

import requests

from activity_chunks import plan_month_chunks
from date_window import calendar_window

from bench.fake_upstream import FakeUpstream, FakeResponse
from bench.harness import InstrumentedRunner, percentile

ORG = "https://dev.example.invalid/org"
TODAY = date(2028, 3, 10)


def march_chunk():
    window = calendar_window(date(2028, 3, 1), date(2028, 3, 10), today=TODAY)
    return plan_month_chunks(window, now=datetime(2028, 3, 10))[0]


class FakeUpstreamTests(unittest.TestCase):
    def upstream(self, **kw):
        return FakeUpstream(projects=["P1", "P2"], runs_per_month=10, today=TODAY, **kw)

    def builds(self, up, project="P1", **params):
        base = {"minTime": "2028-02-01T00:00:00Z", "maxTime": "2028-03-01T00:00:00Z", "$top": 250}
        base.update(params)
        return up.get(f"{ORG}/{project}/_apis/build/builds", headers={}, params=base, timeout=10)

    def test_counts_every_call_by_kind(self):
        up = self.upstream()
        up.get(f"{ORG}/_apis/projects", headers={}, params={"$top": 100}, timeout=10)
        self.builds(up)
        self.builds(up, "P2")
        self.assertEqual(up.counters["requests"], 3)
        self.assertEqual(up.counters["projects"], 1)
        self.assertEqual(up.counters["builds"], 2)

    def test_builds_stay_inside_the_requested_window(self):
        up = self.upstream()
        value = self.builds(up).json()["value"]
        self.assertEqual(len(value), 10)
        self.assertTrue(all("2028-02-01" <= b["queueTime"][:10] <= "2028-02-29" for b in value))

    def test_rate_limit_mode_sets_retry_after_and_counts_status(self):
        up = self.upstream(mode="429", retry_after=90)
        response = self.builds(up)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], "90")
        self.assertEqual(up.counters["status_429"], 1)

    def test_server_error_and_timeout_modes(self):
        up = self.upstream(mode="5xx")
        self.assertEqual(self.builds(up).status_code, 503)
        up = self.upstream(mode="timeout")
        with self.assertRaises(requests.Timeout):
            self.builds(up)
        self.assertEqual(up.counters["timeouts"], 1)

    def test_fail_first_then_succeed(self):
        up = self.upstream(mode="429", retry_after=0, fail_first=2)
        codes = [self.builds(up).status_code for _ in range(3)]
        self.assertEqual(codes, [429, 429, 200])

    def test_pagination_returns_all_rows_across_pages(self):
        up = FakeUpstream(projects=["P1"], runs_per_month=30, today=TODAY)
        seen, token = [], None
        while True:
            params = {"minTime": "2028-02-01T00:00:00Z", "maxTime": "2028-03-01T00:00:00Z", "$top": 12}
            if token:
                params["continuationToken"] = token
            response = up.get(f"{ORG}/P1/_apis/build/builds", headers={}, params=params, timeout=10)
            seen.extend(b["id"] for b in response.json()["value"])
            token = response.headers.get("x-ms-continuationtoken")
            if not token:
                break
        self.assertEqual(len(seen), 30)
        self.assertEqual(len(set(seen)), 30)

    def test_wiql_and_detail_calls_are_counted_and_windowed(self):
        up = self.upstream()
        query = ("SELECT [System.Id] FROM WorkItems WHERE [Microsoft.VSTS.Common.ClosedDate] >= '2028-02-01T00:00:00Z' "
                 "AND [Microsoft.VSTS.Common.ClosedDate] < '2028-03-01T00:00:00Z'")
        ids = [w["id"] for w in up.wiql_post(f"{ORG}/_apis/wit/wiql", headers={}, json={"query": query}, timeout=5)
               .json()["workItems"]]
        self.assertEqual(len(ids), 20)  # 2 projects x 10 per month
        items = up.items_get(f"{ORG}/_apis/wit/workitems?ids={','.join(map(str, ids[:5]))}&api-version=7.1",
                             headers={}, timeout=5).json()["value"]
        self.assertEqual([i["id"] for i in items], ids[:5])
        self.assertEqual((up.counters["wiql"], up.counters["items"], up.counters["requests"]), (1, 1, 2))

    def test_counter_snapshot_is_thread_safe(self):
        up = self.upstream()
        threads = [threading.Thread(target=lambda: [self.builds(up) for _ in range(25)]) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(up.counters["builds"], 100)


class InstrumentedRunnerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.runner = InstrumentedRunner(db_path=os.path.join(self._tmp.name, "b.db"), max_workers=2)
        self.chunk = march_chunk()

    def tearDown(self):
        self.runner.shutdown(wait=True)
        self._tmp.cleanup()

    def test_coalesced_submissions_are_counted_and_one_fetch_runs(self):
        release = threading.Event()
        calls = []

        def fetch(chunk):
            calls.append(1)
            release.wait(5)
            return True

        for _ in range(5):
            self.runner.submit("scope", "pipelines", self.chunk, fetch)
        release.set()
        deadline = time.time() + 5
        while self.runner.status("scope", "pipelines", ["2028-03-01"])["state"] == "running" and time.time() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.runner.counters["submitted"], 5)
        self.assertEqual(self.runner.counters["started"], 1)
        self.assertEqual(self.runner.counters["coalesced"], 4)
        self.assertEqual(self.runner.starts_per_chunk, {"2028-03-01": 1})

    def test_queue_depth_peak_and_busy_are_tracked(self):
        runner = InstrumentedRunner(db_path=os.path.join(self._tmp.name, "c.db"), max_workers=1, max_pending=2)
        release = threading.Event()
        try:
            chunks = plan_month_chunks(calendar_window(date(2027, 12, 1), date(2028, 3, 10), today=TODAY),
                                       now=datetime(2028, 3, 10))
            outcomes = [runner.submit("s", "pipelines", c, lambda _c: release.wait(5) or True) for c in chunks]
            self.assertEqual(outcomes.count("busy"), len(chunks) - 2)
            self.assertEqual(runner.counters["busy"], len(chunks) - 2)
            self.assertEqual(runner.queue_depth_peak, 2)
        finally:
            release.set()
            runner.shutdown(wait=True)


class PercentileTests(unittest.TestCase):
    def test_percentiles(self):
        values = [1.0, 2.0, 3.0, 4.0, 5.0]
        self.assertEqual(percentile(values, 50), 3.0)
        self.assertEqual(percentile(values, 95), 5.0)
        self.assertEqual(percentile([7.0], 95), 7.0)
        self.assertIsNone(percentile([], 50))


if __name__ == "__main__":
    unittest.main()
