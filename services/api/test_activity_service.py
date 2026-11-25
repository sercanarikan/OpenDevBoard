import sqlite3
import unittest
from datetime import date, datetime

import activity_service as svc
import coverage_ledger as cl
from date_window import calendar_window

NOW = datetime(2028, 3, 10, 12, 0, 0)
ORG_PROJECTS = ["Alpha", "Beta"]


def window(start: str, end: str):
    return calendar_window(date.fromisoformat(start), date.fromisoformat(end), today=NOW.date())


def ledger_row(coverage: str, fetched_at: str = "2028-03-10T11:55:00Z", chunk_end: str = "2028-03-31"):
    return {"coverage": coverage, "fetchedAt": fetched_at, "chunkEnd": chunk_end}


def pipeline_db(rows):
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE pipeline_runs (id INTEGER, project TEXT, queue_time TEXT)")
    conn.executemany("INSERT INTO pipeline_runs VALUES (?, ?, ?)", rows)
    return conn


class DailyCountsTests(unittest.TestCase):
    def test_counts_group_by_utc_day_and_filter_by_project(self):
        conn = pipeline_db([
            (1, "Alpha", "2028-02-01T10:00:00Z"),
            (2, "Alpha", "2028-02-01T23:59:59Z"),
            (3, "Beta", "2028-02-01T01:00:00Z"),
            (4, "Gamma", "2028-02-01T01:00:00Z"),  # outside the project set
        ])
        counts = svc.daily_counts(conn, "pipelines", ["Alpha", "Beta"], window("2028-02-01", "2028-02-02"))
        self.assertEqual(counts, {"2028-02-01": 3})

    def test_days_outside_the_window_are_excluded(self):
        conn = pipeline_db([(1, "Alpha", "2028-01-31T10:00:00Z"), (2, "Alpha", "2028-02-02T10:00:00Z")])
        counts = svc.daily_counts(conn, "pipelines", ["Alpha"], window("2028-02-01", "2028-02-01"))
        self.assertEqual(counts, {})

    def test_empty_project_set_returns_no_counts(self):
        conn = pipeline_db([(1, "Alpha", "2028-02-01T10:00:00Z")])
        self.assertEqual(svc.daily_counts(conn, "pipelines", [], window("2028-02-01", "2028-02-01")), {})

    def test_unknown_metric_is_rejected(self):
        conn = pipeline_db([])
        with self.assertRaises(ValueError):
            svc.daily_counts(conn, "drop table", ["Alpha"], window("2028-02-01", "2028-02-01"))


class ClassifyDaysTests(unittest.TestCase):
    def test_complete_chunk_with_no_rows_is_covered_zero_not_missing(self):
        days = svc.classify_days(window("2028-02-01", "2028-02-02"), {"2028-02-01": ledger_row("complete")}, {}, NOW, None)
        self.assertEqual([(d["date"], d["state"], d["count"]) for d in days], [
            ("2028-02-01", "covered_zero", 0),
            ("2028-02-02", "covered_zero", 0),
        ])

    def test_complete_chunk_with_rows_is_covered_active_with_count(self):
        days = svc.classify_days(window("2028-02-01", "2028-02-01"), {"2028-02-01": ledger_row("complete")}, {"2028-02-01": 4}, NOW, None)
        self.assertEqual((days[0]["state"], days[0]["count"]), ("covered_active", 4))

    def test_partial_chunk_is_partial_never_zero(self):
        days = svc.classify_days(window("2028-02-01", "2028-02-01"), {"2028-02-01": ledger_row("partial")}, {}, NOW, None)
        self.assertEqual(days[0]["state"], "partial")
        self.assertIsNone(days[0]["count"])

    def test_day_without_ledger_row_is_not_collected(self):
        days = svc.classify_days(window("2028-02-01", "2028-02-01"), {}, {"2028-02-01": 9}, NOW, None)
        self.assertEqual((days[0]["state"], days[0]["count"]), ("not_collected", None))

    def test_days_older_than_retention_are_unavailable_when_not_covered(self):
        days = svc.classify_days(window("2027-12-01", "2027-12-02"), {}, {}, NOW, retention_days=90)
        self.assertEqual({d["state"] for d in days}, {"unavailable_retention"})

    def test_covered_days_inside_retention_keep_their_state(self):
        days = svc.classify_days(
            window("2028-03-01", "2028-03-01"), {"2028-03-01": ledger_row("complete")}, {}, NOW, retention_days=90
        )
        self.assertEqual(days[0]["state"], "covered_zero")

    def test_no_retention_horizon_never_claims_unavailable(self):
        days = svc.classify_days(window("2026-01-01", "2026-01-01"), {}, {}, NOW, retention_days=None)
        self.assertEqual(days[0]["state"], "not_collected")

    def test_stale_flag_follows_ledger_freshness(self):
        old = ledger_row("complete", fetched_at="2028-03-01T00:00:00Z", chunk_end="2028-03-31")
        days = svc.classify_days(window("2028-03-10", "2028-03-10"), {"2028-03-01": old}, {}, NOW, None)
        self.assertTrue(days[0]["stale"])
        self.assertEqual(days[0]["state"], "covered_zero")

    def test_year_boundary_and_leap_day_are_contiguous(self):
        w = window("2027-12-30", "2028-03-01")
        coverage = {
            "2027-12-01": ledger_row("complete", chunk_end="2027-12-31"),
            "2028-01-01": ledger_row("complete", chunk_end="2028-01-31"),
            "2028-02-01": ledger_row("complete", chunk_end="2028-02-29"),
            "2028-03-01": ledger_row("complete", chunk_end="2028-03-31"),
        }
        days = svc.classify_days(w, coverage, {"2028-02-29": 2}, NOW, None)
        keys = [d["date"] for d in days]
        self.assertEqual(keys[:4], ["2027-12-30", "2027-12-31", "2028-01-01", "2028-01-02"])
        self.assertIn("2028-02-29", keys)
        self.assertEqual(len(keys), w.days)
        self.assertEqual(len(set(keys)), len(keys))
        leap = next(d for d in days if d["date"] == "2028-02-29")
        self.assertEqual((leap["state"], leap["count"]), ("covered_active", 2))


if __name__ == "__main__":
    unittest.main()


class ChunkEndTests(unittest.TestCase):
    def test_days_after_the_fetched_end_are_not_collected(self):
        # Chunk fetched through 10 Nov: 8-10 Nov are scanned, 11-12 Nov of the same month are unknown.
        w = window("2026-11-08", "2026-11-12")
        coverage = {"2026-11-01": {"coverage": "complete", "fetchedAt": "2026-11-10T12:00:00Z", "chunkEnd": "2026-11-10"}}
        days = svc.classify_days(w, coverage, {}, datetime(2026, 11, 10, 13), None)
        states = {d["date"]: d["state"] for d in days}
        self.assertEqual(states["2026-11-08"], "covered_zero")
        self.assertEqual(states["2026-11-10"], "covered_zero")
        self.assertEqual(states["2026-11-11"], "not_collected")
        self.assertEqual(states["2026-11-12"], "not_collected")
