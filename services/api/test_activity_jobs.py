import os
import tempfile
import threading
import time
import unittest
from datetime import date, datetime

import coverage_ledger as cl
from activity_chunks import chunk_key, plan_month_chunks
from activity_jobs import BUSY, DONE, FAILED, IDLE, PARTIAL, RUNNING, ChunkJobRunner
from date_window import calendar_window
from persistence import get_db_connection

SCOPE = cl.scope_key("https://dev.example.invalid/org", ["Alpha"])


def february_chunk():
    window = calendar_window(date(2028, 2, 1), date(2028, 2, 29), today=date(2028, 3, 10))
    return plan_month_chunks(window, now=datetime(2028, 3, 10))[0]


def wait_until_idle(runner, chunk_keys, metric="pipelines", timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = runner.status(SCOPE, metric, chunk_keys)
        if status["state"] != RUNNING:
            return status
        time.sleep(0.01)
    raise AssertionError("chunk jobs did not finish")


class ChunkJobRunnerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "test.db")
        self.runner = ChunkJobRunner(db_path=self.db_path, max_workers=2, max_pending=64)
        self.chunk = february_chunk()
        self.key = chunk_key(self.chunk)

    def tearDown(self):
        self.runner.shutdown(wait=True)
        self._tmp.cleanup()

    def coverage(self):
        conn = get_db_connection(self.db_path)
        try:
            row = cl.read_coverage(conn, SCOPE, "pipelines", [self.key]).get(self.key)
            return row["coverage"] if row else None
        finally:
            conn.close()

    def attempts(self):
        conn = get_db_connection(self.db_path)
        try:
            return [tuple(r) for r in conn.execute("SELECT outcome, error_code FROM coverage_attempts ORDER BY id")]
        finally:
            conn.close()

    def test_complete_fetch_promotes_the_chunk(self):
        self.runner.submit(SCOPE, "pipelines", self.chunk, lambda chunk: True)
        self.assertEqual(wait_until_idle(self.runner, [self.key])["state"], DONE)
        self.assertEqual(self.coverage(), "complete")

    def test_incomplete_fetch_stores_partial(self):
        self.runner.submit(SCOPE, "pipelines", self.chunk, lambda chunk: False)
        self.assertEqual(wait_until_idle(self.runner, [self.key])["state"], PARTIAL)
        self.assertEqual(self.coverage(), "partial")

    def test_incomplete_fetch_does_not_downgrade_complete(self):
        self.runner.submit(SCOPE, "pipelines", self.chunk, lambda chunk: True)
        wait_until_idle(self.runner, [self.key])
        self.runner.submit(SCOPE, "pipelines", self.chunk, lambda chunk: False)
        wait_until_idle(self.runner, [self.key])
        self.assertEqual(self.coverage(), "complete")

    def test_exception_logs_error_code_only_and_keeps_coverage(self):
        self.runner.submit(SCOPE, "pipelines", self.chunk, lambda chunk: True)
        wait_until_idle(self.runner, [self.key])

        def boom(chunk):
            raise RuntimeError("https://secret.example.invalid/?pat=HIDDEN")

        self.runner.submit(SCOPE, "pipelines", self.chunk, boom)
        self.assertEqual(wait_until_idle(self.runner, [self.key])["state"], FAILED)
        self.assertEqual(self.coverage(), "complete")
        self.assertIn(("failed", "RuntimeError"), self.attempts())
        for _, code in self.attempts():
            self.assertNotIn("HIDDEN", code or "")

    def test_identical_chunk_fetches_are_coalesced(self):
        gate = threading.Event()
        calls = []

        def slow(chunk):
            calls.append(1)
            gate.wait(2)
            return True

        self.assertEqual(self.runner.submit(SCOPE, "pipelines", self.chunk, slow), RUNNING)
        self.assertEqual(self.runner.submit(SCOPE, "pipelines", self.chunk, slow), RUNNING)
        gate.set()
        wait_until_idle(self.runner, [self.key])
        self.assertEqual(len(calls), 1)

    def test_at_most_two_fetches_run_concurrently(self):
        lock = threading.Lock()
        active = {"now": 0, "max": 0}
        gate = threading.Event()

        def tracked(chunk):
            with lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            gate.wait(2)
            with lock:
                active["now"] -= 1
            return True

        keys = []
        for month in range(1, 5):
            chunk = plan_month_chunks(
                calendar_window(date(2028, month, 1), date(2028, month, 2), today=date(2028, 12, 1)),
                now=datetime(2028, 12, 1),
            )[0]
            keys.append(chunk_key(chunk))
            self.runner.submit(SCOPE, "pipelines", chunk, tracked)
        time.sleep(0.1)
        gate.set()
        wait_until_idle(self.runner, keys)
        self.assertEqual(active["max"], 2)

    def test_pending_limit_refuses_new_work(self):
        small = ChunkJobRunner(db_path=self.db_path, max_workers=1, max_pending=1)
        gate = threading.Event()
        try:
            self.assertEqual(small.submit(SCOPE, "pipelines", self.chunk, lambda c: gate.wait(2) or True), RUNNING)
            other = plan_month_chunks(
                calendar_window(date(2028, 3, 1), date(2028, 3, 2), today=date(2028, 3, 10)),
                now=datetime(2028, 3, 10),
            )[0]
            self.assertEqual(small.submit(SCOPE, "pipelines", other, lambda c: True), BUSY)
        finally:
            gate.set()
            small.shutdown(wait=True)

    def test_status_is_idle_before_any_submit(self):
        self.assertEqual(
            self.runner.status(SCOPE, "pipelines", [self.key]),
            {"state": IDLE, "pending": 0, "completed": 0, "partial": 0, "failed": 0},
        )


if __name__ == "__main__":
    unittest.main()
