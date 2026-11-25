"""Contract tests for the shared analytics date window (synthetic data only)."""
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import patch

import date_window
from date_window import CALENDAR, ROLLING, parse_request_window

TODAY = date(2028, 3, 10)  # leap year, so Feb 29 exists
NOW = datetime(2028, 3, 10, 12, 0, 0)


class ParseRequestWindowTests(unittest.TestCase):
    def parse(self, args):
        return parse_request_window(args, now=NOW)

    def test_legacy_days_remains_a_rolling_window_ending_now(self):
        window = self.parse({"days": "30"})
        self.assertEqual(window.kind, ROLLING)
        self.assertEqual(window.days, 30)
        self.assertEqual(window.end, NOW)
        self.assertEqual(window.start, datetime(2028, 2, 9, 12, 0, 0))

    def test_missing_arguments_default_to_thirty_rolling_days(self):
        self.assertEqual(self.parse({}).days, 30)

    def test_invalid_days_are_rejected(self):
        for value in ("abc", "0", "-3", "7.5"):
            with self.subTest(days=value), self.assertRaises(ValueError):
                self.parse({"days": value})

    def test_calendar_range_is_inclusive_utc_days(self):
        window = self.parse({"startDate": "2028-02-28", "endDate": "2028-03-01"})
        self.assertEqual(window.kind, CALENDAR)
        self.assertEqual(window.start, datetime(2028, 2, 28))
        self.assertEqual(window.end, datetime(2028, 3, 2))
        self.assertEqual(window.days, 3)  # Feb 28, Feb 29 (leap day), Mar 1
        self.assertEqual(window.to_meta()["endDate"], "2028-03-01")
        self.assertTrue(window.contains(datetime(2028, 3, 1, 23, 59, 59)))
        self.assertFalse(window.contains(datetime(2028, 3, 2, 0, 0, 0)))

    def test_one_day_range_is_valid(self):
        window = self.parse({"startDate": "2028-03-10", "endDate": "2028-03-10"})
        self.assertEqual(window.days, 1)

    def test_partial_calendar_arguments_are_rejected(self):
        with self.assertRaises(ValueError):
            self.parse({"startDate": "2028-03-01"})
        with self.assertRaises(ValueError):
            self.parse({"endDate": "2028-03-01"})

    def test_malformed_and_impossible_dates_are_rejected(self):
        for start, end in (("2028-02-30", "2028-03-01"), ("2028-3-1", "2028-03-02"), ("bad", "2028-03-02")):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                self.parse({"startDate": start, "endDate": end})

    def test_non_leap_year_feb_29_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_request_window({"startDate": "2027-02-29", "endDate": "2027-03-01"}, now=datetime(2027, 3, 10))

    def test_end_before_start_is_rejected(self):
        with self.assertRaises(ValueError):
            self.parse({"startDate": "2028-03-02", "endDate": "2028-03-01"})

    def test_future_end_is_rejected_not_clipped(self):
        with self.assertRaises(ValueError):
            self.parse({"startDate": "2028-03-09", "endDate": "2028-03-11"})

    def test_three_year_span_is_the_limit(self):
        # Contract change (approved): query windows may span up to 1096 UTC days.
        # today (2028-03-10) minus 1095 days is 2025-03-11, the oldest allowed start for a 1096-day span
        window = self.parse({"startDate": "2025-03-11", "endDate": "2028-03-10"})
        self.assertEqual(window.days, 1096)
        with self.assertRaises(ValueError):
            self.parse({"startDate": "2025-03-10", "endDate": "2028-03-10"})

    def test_starts_older_than_the_age_limit_are_rejected(self):
        # Contract change (approved): start may be at most 3650 days before today (UTC).
        oldest_allowed = date(2028, 3, 10) - timedelta(days=3650)
        self.assertEqual(self.parse({"startDate": oldest_allowed.isoformat(), "endDate": oldest_allowed.isoformat()}).days, 1)
        too_old = oldest_allowed - timedelta(days=1)
        with self.assertRaises(ValueError):
            self.parse({"startDate": too_old.isoformat(), "endDate": too_old.isoformat()})

    def test_explicit_limits_can_still_be_tightened_by_callers(self):
        # Legacy-shaped callers may pass tighter limits; they must be enforced exactly.
        with self.assertRaises(ValueError):
            parse_request_window(
                {"startDate": "2028-01-01", "endDate": "2028-03-10"},
                now=datetime(2028, 3, 10),
                max_span_days=30,
            )

    def test_month_boundary_range_across_year_end(self):
        window = parse_request_window({"startDate": "2027-12-31", "endDate": "2028-01-01"}, now=datetime(2028, 1, 5))
        self.assertEqual(window.days, 2)
        self.assertEqual(window.start, datetime(2027, 12, 31))
        self.assertEqual(window.end, datetime(2028, 1, 2))


class DayBucketTests(unittest.TestCase):
    def test_calendar_buckets_cover_every_day_including_leap_day(self):
        window = parse_request_window({"startDate": "2028-02-28", "endDate": "2028-03-01"}, now=NOW)
        self.assertEqual([k for k, _ in window.day_keys()], ["2028-02-28", "2028-02-29", "2028-03-01"])

    def test_rolling_buckets_keep_the_historical_now_based_shape(self):
        window = date_window.rolling_window(3, now=NOW)
        self.assertEqual([k for k, _ in window.day_keys(NOW)], ["2028-03-08", "2028-03-09", "2028-03-10"])

    def test_cache_keys_differ_between_ranges(self):
        a = parse_request_window({"days": "30"}, now=NOW).key
        b = parse_request_window({"startDate": "2028-02-01", "endDate": "2028-02-29"}, now=NOW).key
        c = parse_request_window({"startDate": "2028-02-01", "endDate": "2028-03-01"}, now=NOW).key
        self.assertEqual(len({a, b, c}), 3)


class AnalyticsRouteContractTests(unittest.TestCase):
    """Routes must accept calendar ranges, keep days working, and reject bad input with 400."""

    def setUp(self):
        import app as api_app
        self.api_app = api_app
        self.client = api_app.app.test_client()

    def test_invalid_calendar_range_returns_400_and_does_not_load(self):
        with patch.object(self.api_app, '_load_all_pipelines') as load:
            response = self.client.get('/api/pipelines/summary?startDate=2001-01-01&endDate=2001-01-02')
        self.assertEqual(response.status_code, 400)
        self.assertIn('startDate', response.get_json()['error'])
        load.assert_not_called()

    def test_calendar_request_passes_window_to_the_loader(self):
        window_arg = {}

        def fake_load(**kwargs):
            window_arg.update(kwargs)
            return []

        with patch.object(date_window, 'utc_now', return_value=NOW), \
                patch.object(self.api_app, '_load_all_pipelines', side_effect=fake_load), \
                patch.object(self.api_app.pipeline_service, 'compute_pipeline_summary', return_value={
                    'total': 0, 'periodDays': 3, 'dailyStats': []}) as summarize:
            response = self.client.get('/api/pipelines/summary?startDate=2028-02-28&endDate=2028-03-01')
        self.assertEqual(response.status_code, 200)
        self.assertIn('window', window_arg)
        self.assertNotIn('days', window_arg)
        self.assertEqual(window_arg['window'].kind, CALENDAR)
        self.assertEqual(summarize.call_args.kwargs['window'].days, 3)


if __name__ == '__main__':
    unittest.main()
