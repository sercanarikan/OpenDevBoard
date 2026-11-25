import unittest
from datetime import date, datetime

import activity_chunks
from activity_chunks import MAX_CHUNKS, chunk_key, chunk_last_day, plan_month_chunks
from date_window import calendar_window, rolling_window

TODAY = datetime(2030, 1, 1)


def window_for(start: str, end: str):
    return calendar_window(date.fromisoformat(start), date.fromisoformat(end), today=TODAY.date())


class PlanMonthChunksTests(unittest.TestCase):
    def test_query_inside_one_month_still_fetches_the_whole_month(self):
        chunks = plan_month_chunks(window_for("2028-02-10", "2028-02-12"), now=TODAY)
        self.assertEqual([chunk_key(c) for c in chunks], ["2028-02-01"])
        self.assertEqual(chunk_last_day(chunks[0]), "2028-02-29")

    def test_window_crossing_year_end_uses_month_keys(self):
        chunks = plan_month_chunks(window_for("2027-12-30", "2028-01-02"), now=TODAY)
        self.assertEqual([chunk_key(c) for c in chunks], ["2027-12-01", "2028-01-01"])
        self.assertEqual(chunk_last_day(chunks[0]), "2027-12-31")
        self.assertEqual(chunk_last_day(chunks[1]), "2028-01-31")

    def test_leap_day_is_inside_the_february_chunk(self):
        chunks = plan_month_chunks(window_for("2028-02-28", "2028-03-01"), now=TODAY)
        self.assertEqual([chunk_key(c) for c in chunks], ["2028-02-01", "2028-03-01"])
        self.assertEqual(chunk_last_day(chunks[0]), "2028-02-29")

    def test_chunk_keys_do_not_depend_on_the_query_window(self):
        partial = plan_month_chunks(window_for("2028-02-10", "2028-02-12"), now=TODAY)
        full = plan_month_chunks(window_for("2028-02-01", "2028-02-29"), now=TODAY)
        self.assertEqual(chunk_key(partial[0]), chunk_key(full[0]))
        self.assertEqual(partial[0].start, full[0].start)
        self.assertEqual(partial[0].end, full[0].end)

    def test_chunks_cover_every_day_of_the_query(self):
        window = window_for("2026-03-15", "2028-01-20")
        chunks = plan_month_chunks(window, now=TODAY)
        self.assertLessEqual(chunks[0].start, window.start)
        self.assertGreaterEqual(chunks[-1].end, window.end)
        for left, right in zip(chunks, chunks[1:]):
            self.assertEqual(left.end, right.start)

    def test_future_days_of_the_current_month_are_not_fetched(self):
        today = datetime(2028, 2, 10)
        chunks = plan_month_chunks(calendar_window(date(2028, 2, 1), date(2028, 2, 10), today=today.date()), now=today)
        self.assertEqual(chunk_last_day(chunks[0]), "2028-02-10")

    def test_longest_allowed_window_fits_the_chunk_limit(self):
        # Start on a month end so that 1096 inclusive days touch 37 months.
        window = window_for("2025-01-31", "2028-01-31")
        self.assertEqual(window.days, 1096)
        self.assertEqual(len(plan_month_chunks(window, now=TODAY)), MAX_CHUNKS)

    def test_more_chunks_than_the_limit_are_rejected(self):
        original = activity_chunks.MAX_CHUNKS
        activity_chunks.MAX_CHUNKS = 2
        try:
            with self.assertRaisesRegex(ValueError, "limit is 2"):
                plan_month_chunks(window_for("2028-01-01", "2028-04-01"), now=TODAY)
        finally:
            activity_chunks.MAX_CHUNKS = original

    def test_rolling_windows_are_not_chunked(self):
        with self.assertRaises(ValueError):
            plan_month_chunks(rolling_window(30, now=datetime(2028, 3, 10)), now=TODAY)


if __name__ == "__main__":
    unittest.main()
