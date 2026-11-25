import sqlite3
import unittest
from datetime import datetime

import coverage_ledger as cl

SCOPE = cl.scope_key("https://dev.example.invalid/org", ["Alpha", "Beta"])
OTHER_PROJECTS = cl.scope_key("https://dev.example.invalid/org", ["Alpha"])
OTHER_ACTOR = cl.scope_key("https://dev.example.invalid/org", ["Alpha", "Beta"], actor_id="user-1")
T1 = "2028-02-01T10:00:00Z"
T2 = "2028-02-02T10:00:00Z"


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        cl.init_coverage_db(self.conn)

    def tearDown(self):
        self.conn.close()

    def coverage(self, scope=SCOPE, source="pipelines", chunk="2028-02-01"):
        row = cl.read_coverage(self.conn, scope, source, [chunk]).get(chunk)
        return row["coverage"] if row else None

    def test_complete_fetch_is_stored(self):
        self.assertEqual(cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", True, T1), "complete")
        self.assertEqual(self.coverage(), "complete")

    def test_partial_fetch_never_downgrades_complete(self):
        cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", True, T1)
        stored = cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", False, T2)
        self.assertEqual(stored, "complete")
        self.assertEqual(self.coverage(), "complete")
        self.assertEqual(cl.read_coverage(self.conn, SCOPE, "pipelines", ["2028-02-01"])["2028-02-01"]["fetchedAt"], T1)

    def test_partial_fetch_without_prior_row_is_stored_as_partial(self):
        self.assertEqual(cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", False, T1), "partial")
        self.assertEqual(self.coverage(), "partial")

    def test_complete_fetch_upgrades_partial(self):
        cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", False, T1)
        cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", True, T2)
        self.assertEqual(self.coverage(), "complete")

    def test_failed_attempt_leaves_coverage_and_is_logged(self):
        cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", True, T1)
        cl.record_failed_attempt(self.conn, SCOPE, "pipelines", "2028-02-01", "upstream-timeout", attempted_at=T2)
        self.assertEqual(self.coverage(), "complete")
        outcomes = [r[0] for r in self.conn.execute("SELECT outcome FROM coverage_attempts ORDER BY id")]
        self.assertEqual(outcomes, ["complete", "failed"])

    def test_scopes_do_not_share_coverage(self):
        cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", True, T1)
        self.assertIsNone(self.coverage(scope=OTHER_PROJECTS))
        self.assertIsNone(self.coverage(scope=OTHER_ACTOR))

    def test_different_sources_do_not_share_coverage(self):
        cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", True, T1)
        self.assertIsNone(self.coverage(source="deployments"))

    def test_scope_key_is_order_independent_and_hides_identity(self):
        a = cl.scope_key("https://x.invalid/org/", ["B", "A"])
        b = cl.scope_key("https://x.invalid/org", ["A", "B"])
        self.assertEqual(a, b)
        self.assertNotIn("user-1", OTHER_ACTOR)

    def test_freshness_uses_ttl_for_the_current_chunk(self):
        now = datetime(2028, 2, 10, 12, 0, 0)
        self.assertEqual(cl.freshness("2028-02-10T11:50:00Z", "2028-02-29", now=now), "fresh")
        self.assertEqual(cl.freshness("2028-02-10T11:30:00Z", "2028-02-29", now=now), "stale")

    def test_freshness_uses_longer_ttl_for_closed_chunks(self):
        now = datetime(2028, 3, 10, 12, 0, 0)
        self.assertEqual(cl.freshness("2028-03-05T12:00:00Z", "2028-02-29", now=now), "fresh")
        self.assertEqual(cl.freshness("2028-02-20T12:00:00Z", "2028-02-29", now=now), "stale")

    def test_coverage_and_freshness_are_separate_fields(self):
        cl.promote_chunk(self.conn, SCOPE, "pipelines", "2028-02-01", "2028-02-29", True, T1)
        row = cl.read_coverage(self.conn, SCOPE, "pipelines", ["2028-02-01"])["2028-02-01"]
        self.assertEqual(set(row), {"chunkEnd", "coverage", "fetchedAt"})


if __name__ == "__main__":
    unittest.main()
