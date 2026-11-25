"""Calendar date window support in the team activity and history services (synthetic data only)."""

import unittest
from datetime import date, datetime
from unittest.mock import patch

import testsupport  # noqa: F401  (must precede the project imports)
import history_service
import persistence
import team_service
from date_window import calendar_window, rolling_window

testsupport.isolate_database(globals())

NOW = datetime(2028, 3, 10, 12)


def _response(payload, status=200):
    return type("Response", (), {"status_code": status, "json": lambda self: payload})()


def _commit(commit_id, date_str):
    return {"commitId": commit_id, "author": {"name": "Ada", "email": "ada@example.test", "date": date_str}, "comment": "c"}


class TestSummaryWindows(unittest.TestCase):
    def _team_items(self):
        commits = [
            {"commitId": f"c{d}", "project": "P", "repository": "R", "author": "Ada", "authorEmail": "", "comment": "",
             "url": "", "date": f"{d}T10:00:00Z"}
            for d in ("2028-01-30", "2028-01-31", "2028-02-01", "2028-02-02", "2028-02-29", "2028-03-01")
        ]
        prs = [{"id": 1, "project": "P", "repository": "R", "author": "Ada", "reviewers": [],
                "creationDate": "2028-02-01T23:59:59Z"}]
        return commits, prs

    def _history_events(self):
        return [
            {"id": f"e{d}", "eventType": "git.commit", "occurredAt": f"{d}T10:00:00Z", "project": "P",
             "entity": {"type": "commit", "id": d, "title": "t"}, "summary": "s"}
            for d in ("2028-01-30", "2028-01-31", "2028-02-01", "2028-02-02", "2028-02-29", "2028-03-01")
        ]

    def test_team_rolling_output_unchanged_with_and_without_window(self):
        commits = [{"commitId": "a", "project": "P", "repository": "R", "author": "Ada", "authorEmail": "",
                    "comment": "", "url": "", "date": (NOW.replace(microsecond=0)).isoformat() + "Z"}]
        with patch.object(team_service, "_utcnow", return_value=NOW):
            base = team_service.compute_team_summary(commits, [], days=7)
            explicit = team_service.compute_team_summary(commits, [], days=7, window=rolling_window(7, NOW))
        base.pop("lastSyncedAt"), explicit.pop("lastSyncedAt")
        self.assertEqual(base, explicit)
        self.assertEqual(base["periodDays"], 7)
        self.assertEqual(len(base["dailyStats"]), 7)
        self.assertEqual(base["dailyStats"][-1]["date"], "10 Mar")
        self.assertEqual(base["totalCommits"], 1)

    def test_team_calendar_month_boundary_includes_both_days_excludes_next(self):
        commits, prs = self._team_items()
        window = calendar_window(date(2028, 1, 31), date(2028, 2, 1), today=date(2028, 3, 10))
        summary = team_service.compute_team_summary(commits, prs, days=30, window=window)
        self.assertEqual(summary["periodDays"], 2)
        self.assertEqual(summary["totalCommits"], 2)
        self.assertEqual(summary["totalPRs"], 1)
        self.assertEqual([d["date"] for d in summary["dailyStats"]], ["31 Jan", "01 Feb"])
        self.assertEqual(summary["dailyStats"][1]["total"], 2)

    def test_team_calendar_leap_day(self):
        commits, prs = self._team_items()
        window = calendar_window(date(2028, 2, 29), date(2028, 2, 29), today=date(2028, 3, 10))
        summary = team_service.compute_team_summary(commits, prs, window=window)
        self.assertEqual(summary["periodDays"], 1)
        self.assertEqual(summary["totalCommits"], 1)
        self.assertEqual(summary["dailyStats"][0]["date"], "29 Feb")
        listed = team_service.query_commits(commits, {"days": 7}, window=window)
        self.assertEqual([c["commitId"] for c in listed["items"]], ["c2028-02-29"])
        contributors = team_service.query_contributors(commits, prs, {"days": 7}, window=window)
        self.assertEqual(contributors["items"][0]["commitCount"], 1)

    def test_history_rolling_output_unchanged_with_and_without_window(self):
        events = [dict(self._history_events()[0], occurredAt=NOW.isoformat() + "Z")]
        with patch.object(history_service, "_utcnow", return_value=NOW):
            base = history_service.compute_history_summary(events, days=7)
            explicit = history_service.compute_history_summary(events, days=7, window=rolling_window(7, NOW))
        base.pop("lastSyncedAt"), explicit.pop("lastSyncedAt")
        self.assertEqual(base, explicit)
        self.assertEqual(base["periodDays"], 7)
        self.assertEqual(base["totalEvents"], 1)

    def test_history_calendar_boundaries(self):
        events = self._history_events()
        window = calendar_window(date(2028, 1, 31), date(2028, 2, 1), today=date(2028, 3, 10))
        summary = history_service.compute_history_summary(events, window=window)
        self.assertEqual(summary["periodDays"], 2)
        self.assertEqual(summary["totalEvents"], 2)
        self.assertEqual([d["date"] for d in summary["dailyHeatmap"]], ["31 Jan", "01 Feb"])
        leap = calendar_window(date(2028, 2, 29), date(2028, 2, 29), today=date(2028, 3, 10))
        listed = history_service.query_history_events(events, {"days": 7}, window=leap)
        self.assertEqual([e["id"] for e in listed["items"]], ["e2028-02-29"])


class TestCalendarSync(unittest.TestCase):
    def setUp(self):
        team_service.init_team_db()
        history_service.init_history_db()
        with persistence.db_lock, persistence.get_db_connection() as conn:
            conn.execute("DELETE FROM team_commits")
            conn.execute("DELETE FROM team_activity_cache_state")
            conn.execute("DELETE FROM history_events")
        self.window = calendar_window(date(2028, 2, 1), date(2028, 2, 2), today=date(2028, 3, 10))

    def _team_get(self, commits):
        urls = []

        def get(url, **kwargs):
            urls.append(url)
            if url.endswith("/_apis/git/repositories?api-version=7.1"):
                return _response({"value": [{"id": 1, "name": "R", "project": {"name": "P"}}]})
            return _response({"value": commits})
        return get, urls

    def test_team_calendar_sync_bounds_query_and_never_writes_state_or_deletes(self):
        old = "2028-01-05T10:00:00Z"
        with persistence.db_lock, persistence.get_db_connection() as conn:
            conn.execute(
                "INSERT INTO team_commits (commit_id, project, repository, author_name, author_email, date, comment, "
                "change_counts, url, last_synced_at) VALUES ('old','P','R','Ada','',?, '', '', '', '2028-01-05T10:00:00')",
                (old,))
        get, urls = self._team_get([_commit("in1", "2028-02-01T08:00:00Z"), _commit("in2", "2028-02-02T23:00:00Z"),
                                    _commit("out", "2028-02-03T00:00:00Z")])
        with patch.object(team_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(team_service.azure_http, "get", side_effect=get), \
                patch.object(team_service, "_utcnow", return_value=NOW):
            result = team_service.sync_live_team_activity("https://dev.azure.com/org", "unused", window=self.window)
            result2 = team_service.sync_live_team_activity("https://dev.azure.com/org", "unused", window=self.window)
        self.assertEqual({c["commitId"] for c in result["commits"]}, {"in1", "in2"})
        self.assertEqual({c["commitId"] for c in result2["commits"]}, {"in1", "in2"})
        commit_urls = [u for u in urls if "/commits?" in u]
        self.assertEqual(len(commit_urls), 2, "calendar sync must not shortcut from cache")
        self.assertIn("searchCriteria.fromDate=2028-02-01T00:00:00Z", commit_urls[0])
        self.assertIn("searchCriteria.toDate=2028-02-03T00:00:00Z", commit_urls[0])
        with persistence.get_db_connection() as conn:
            self.assertIsNone(conn.execute("SELECT * FROM team_activity_cache_state").fetchone())
            ids = {r["commit_id"] for r in conn.execute("SELECT commit_id FROM team_commits")}
        self.assertEqual(ids, {"old", "in1", "in2"})

    def test_team_calendar_sync_keeps_cached_commits_after_the_window(self):
        # Regression: a completed calendar fetch used to delete every cached commit dated on or after the
        # rolling start (now - days), which removed rows that belong to later rolling reads. This row is
        # inside the rolling window (2028-03-08..now) but after the calendar range (2028-02-01..02).
        later = "2028-03-09T10:00:00Z"
        with persistence.db_lock, persistence.get_db_connection() as conn:
            conn.execute(
                "INSERT INTO team_commits (commit_id, project, repository, author_name, author_email, date, comment, "
                "change_counts, url, last_synced_at) VALUES ('later','P','R','Ada','',?, '', '', '', '2028-03-09T10:00:00')",
                (later,))
        get, _urls = self._team_get([_commit("in1", "2028-02-01T08:00:00Z")])
        with patch.object(team_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(team_service.azure_http, "get", side_effect=get), \
                patch.object(team_service, "_load_live_prs_summary_only", return_value=[]), \
                patch.object(team_service, "_utcnow", return_value=NOW):
            team_service.sync_live_team_activity("https://dev.azure.com/org", "unused", window=self.window)
        with persistence.get_db_connection() as conn:
            ids = {r["commit_id"] for r in conn.execute("SELECT commit_id FROM team_commits")}
        self.assertIn("later", ids)
        self.assertIn("in1", ids)

    def test_calendar_commit_pages_are_followed_until_a_short_page(self):
        first = [_commit(f"c{i}", "2028-02-01T08:00:00Z") for i in range(2)]
        second = [_commit("c2", "2028-02-01T09:00:00Z")]
        pages = [first, second]
        urls = []

        def get(url, **kwargs):
            urls.append(url)
            if url.endswith("/_apis/git/repositories?api-version=7.1"):
                return _response({"value": [{"id": 1, "name": "R", "project": {"name": "P"}}]})
            if "/commits?" in url:
                return _response({"value": pages.pop(0) if pages else []})
            return _response({"value": []})

        with patch.object(team_service, "CALENDAR_PAGE_SIZE", 2), \
                patch.object(team_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(team_service.azure_http, "get", side_effect=get), \
                patch.object(team_service, "_load_live_prs_summary_only", return_value=[]), \
                patch.object(team_service, "_utcnow", return_value=NOW):
            result = team_service.sync_live_team_activity("https://dev.azure.com/org", "unused", window=self.window)
        self.assertEqual({c["commitId"] for c in result["commits"]}, {"c0", "c1", "c2"})
        self.assertEqual(result["cacheStatus"]["outcome"], "complete")
        self.assertTrue(any("$skip=2" in u for u in urls))

    def test_calendar_commit_page_cap_marks_the_result_partial(self):
        full_page = [_commit(f"x{i}", "2028-02-01T08:00:00Z") for i in range(2)]

        def get(url, **kwargs):
            if url.endswith("/_apis/git/repositories?api-version=7.1"):
                return _response({"value": [{"id": 1, "name": "R", "project": {"name": "P"}}]})
            if "/commits?" in url:
                return _response({"value": full_page})
            return _response({"value": []})

        with patch.object(team_service, "CALENDAR_PAGE_SIZE", 2), patch.object(team_service, "CALENDAR_MAX_PAGES", 3), \
                patch.object(team_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(team_service.azure_http, "get", side_effect=get), \
                patch.object(team_service, "_load_live_prs_summary_only", return_value=[]), \
                patch.object(team_service, "_utcnow", return_value=NOW):
            result = team_service.sync_live_team_activity("https://dev.azure.com/org", "unused", window=self.window)
        self.assertEqual(result["cacheStatus"]["outcome"], "partial")
        self.assertFalse(result["cacheStatus"]["complete"])

    def _pr(self, pr_id):
        return {"pullRequestId": pr_id, "creationDate": "2028-02-01T08:00:00Z", "title": f"PR {pr_id}",
                "createdBy": {"displayName": "Ada"}, "repository": {"name": "R", "project": {"name": "P"}}}

    def _pr_get(self, second_page):
        """First PR page is full (200 items); the second page is produced by ``second_page``."""
        first = [self._pr(i) for i in range(200)]

        def get(url, **kwargs):
            if "/pullrequests" in url:
                if "$skip=200" in url:
                    return second_page()
                return _response({"value": first})
            return _response({"value": []})
        return get

    def _live_prs(self, get):
        report = {}
        with patch.object(team_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(team_service.azure_http, "get", side_effect=get), \
                patch.object(team_service, "_utcnow", return_value=NOW):
            prs = team_service._load_live_prs_summary_only(
                "https://dev.azure.com/org", "unused", 30, window=self.window, report=report)
        return prs, report

    def test_calendar_pr_page_cap_marks_the_result_partial(self):
        def get(url, **kwargs):
            return _response({"value": [self._pr(i) for i in range(200)]})
        with patch.object(team_service, "CALENDAR_MAX_PAGES", 2):
            _prs, report = self._live_prs(get)
        self.assertTrue(report["incomplete"])

    def test_calendar_pr_second_page_http_error_is_partial_and_keeps_first_page(self):
        prs, report = self._live_prs(self._pr_get(lambda: _response({"message": "boom"}, status=500)))
        self.assertTrue(report["incomplete"])
        self.assertEqual(len(prs), 200, "records from the successful first page must be kept")

    def test_calendar_pr_second_page_timeout_is_partial_and_keeps_first_page(self):
        def timeout():
            raise TimeoutError("read timed out")
        prs, report = self._live_prs(self._pr_get(timeout))
        self.assertTrue(report["incomplete"])
        self.assertEqual(len(prs), 200)

    def test_calendar_pr_first_page_timeout_is_partial_not_complete(self):
        def get(url, **kwargs):
            raise TimeoutError("read timed out")
        prs, report = self._live_prs(get)
        self.assertTrue(report["incomplete"])
        self.assertEqual(prs, [])

    def test_calendar_pr_short_page_is_complete(self):
        prs, report = self._live_prs(lambda url, **kw: _response({"value": [self._pr(1)]}))
        self.assertFalse(report["incomplete"])
        self.assertEqual(len(prs), 1)

    def test_calendar_commit_second_page_failure_is_partial_and_keeps_true_records(self):
        first = [_commit(f"k{i}", "2028-02-01T08:00:00Z") for i in range(team_service.CALENDAR_PAGE_SIZE)]

        def get(url, **kwargs):
            if url.endswith("/_apis/git/repositories?api-version=7.1"):
                return _response({"value": [{"id": 1, "name": "R", "project": {"name": "P"}}]})
            if "/commits?" in url:
                if "$skip=0" in url:
                    return _response({"value": first})
                return _response({"message": "boom"}, status=503)
            return _response({"value": []})

        with patch.object(team_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(team_service.azure_http, "get", side_effect=get), \
                patch.object(team_service, "_load_live_prs_summary_only", return_value=[]), \
                patch.object(team_service, "_utcnow", return_value=NOW):
            result = team_service.sync_live_team_activity("https://dev.azure.com/org", "unused", window=self.window)
        self.assertFalse(result["cacheStatus"]["complete"])
        self.assertEqual(result["cacheStatus"]["outcome"], "partial")
        self.assertEqual(len(result["commits"]), team_service.CALENDAR_PAGE_SIZE)

    def test_team_rolling_sync_still_writes_state_row(self):
        get, _ = self._team_get([_commit("r1", (NOW).isoformat() + "Z")])
        with patch.object(team_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(team_service.azure_http, "get", side_effect=get), \
                patch.object(team_service, "_load_live_prs_summary_only", return_value=[]), \
                patch.object(team_service, "_utcnow", return_value=NOW):
            team_service.sync_live_team_activity("https://dev.azure.com/org", "unused", days=7)
        with persistence.get_db_connection() as conn:
            row = conn.execute("SELECT * FROM team_activity_cache_state").fetchone()
        self.assertEqual(row["requested_days"], 7)

    def _history_run(self, window, days=30):
        posted = []

        def post(url, headers=None, json=None, timeout=None):
            posted.append(json["query"])
            return _response({"workItems": []})

        def get(url, **kwargs):
            if "/_apis/git/pullrequests" in url:
                return _response({"value": []})
            if url.endswith("/_apis/git/repositories?api-version=7.1"):
                return _response({"value": [{"id": 1, "name": "R", "project": {"name": "P"}}]})
            get.commit_urls.append(url)
            return _response({"value": [
                _commit("aaaaaaaa1", "2028-02-02T10:00:00Z"), _commit("bbbbbbbb2", "2028-02-05T10:00:00Z")]})
        get.commit_urls = []
        user = {"displayName": "Ada", "id": "u1", "uniqueName": "ada@example.test"}
        with patch.object(history_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(history_service.requests, "post", side_effect=post), \
                patch.object(history_service.requests, "get", side_effect=get), \
                patch.object(history_service, "_utcnow", return_value=NOW):
            result = history_service.sync_live_history(
                "https://dev.azure.com/org", "unused", user, days=days, window=window)
        return result, posted, get.commit_urls

    def test_history_calendar_wiql_uses_explicit_bounds(self):
        result, posted, commit_urls = self._history_run(self.window)
        self.assertEqual(len(posted), 1)
        # Contract: explicit UTC timestamps, because date-only WIQL literals use the server's local time zone.
        self.assertIn("[System.ChangedDate] >= '2028-02-01T00:00:00Z'", posted[0])
        self.assertIn("[System.ChangedDate] < '2028-02-03T00:00:00Z'", posted[0])
        self.assertNotIn("@Today", posted[0])
        self.assertIn("searchCriteria.toDate=2028-02-03T00:00:00Z", commit_urls[0])
        self.assertEqual([e["id"] for e in result["events"]], ["commit-aaaaaaaa"])

    def _history_run_custom(self, pr_pages=None, commit_pages=None, wiql_refs=None, wiql_status=200):
        """Synthetic upstream: ``pr_pages`` / ``commit_pages`` are callables returning a response for each call."""
        pr_pages = pr_pages or (lambda index: _response({"value": []}))
        commit_pages = commit_pages or (lambda repo_index, index: _response({"value": []}))
        wiql_refs = wiql_refs or []
        posted = []
        pr_calls = []

        def post(url, headers=None, json=None, timeout=None):
            posted.append(json["query"])
            if wiql_status != 200:
                return _response({"message": "boom"}, status=wiql_status)
            return _response({"workItems": wiql_refs})

        def get(url, **kwargs):
            if "/_apis/git/pullrequests" in url:
                index = len(pr_calls)
                pr_calls.append(url)
                return pr_pages(index)
            if url.endswith("/_apis/git/repositories?api-version=7.1"):
                return _response({"value": [{"id": 1, "name": "R", "project": {"name": "P"}}]})
            if "/commits?" in url:
                return commit_pages(0, 0 if "$skip" not in url else int(url.split("$skip=")[1].split("&")[0]) // 50)
            return _response({"value": []})

        user = {"displayName": "Ada", "id": "u1", "uniqueName": "ada@example.test"}
        with patch.object(history_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(history_service.requests, "post", side_effect=post), \
                patch.object(history_service.requests, "get", side_effect=get), \
                patch.object(history_service, "_utcnow", return_value=NOW):
            result = history_service.sync_live_history("https://dev.azure.com/org", "unused", user, days=2, window=self.window)
        return result, posted, pr_calls

    def test_history_calendar_complete_when_every_source_succeeds(self):
        result, _posted, _prs = self._history_run(self.window)
        self.assertTrue(result["cacheStatus"]["complete"])
        self.assertEqual(result["cacheStatus"]["issues"], [])

    def test_history_calendar_pr_second_page_failure_is_partial_and_keeps_first_page(self):
        full = [{"pullRequestId": i, "creationDate": "2028-02-01T08:00:00Z", "status": "completed",
                 "createdBy": {"displayName": "Ada", "uniqueName": "ada@example.test"}, "title": f"PR {i}",
                 "repository": {"name": "R", "project": {"name": "P"}}} for i in range(history_service.PR_PAGE_SIZE)]
        result, _posted, prs = self._history_run_custom(
            pr_pages=lambda index: _response({"value": full}) if index == 0 else _response({"message": "boom"}, status=500))
        self.assertFalse(result["cacheStatus"]["complete"])
        self.assertIn("pull-requests-incomplete", result["cacheStatus"]["issues"])
        self.assertEqual(len(prs), 2)

    def test_history_calendar_pr_timeout_is_partial(self):
        full = [{"pullRequestId": 1, "creationDate": "2028-02-01T08:00:00Z", "status": "completed",
                 "createdBy": {"displayName": "Ada", "uniqueName": "ada@example.test"}, "title": "PR",
                 "repository": {"name": "R", "project": {"name": "P"}}}] * history_service.PR_PAGE_SIZE
        def pr_pages_with_timeout(index):
            if index == 0:
                return _response({"value": full})
            raise TimeoutError("read timed out")
        result, _posted, _prs = self._history_run_custom(pr_pages=pr_pages_with_timeout)
        self.assertFalse(result["cacheStatus"]["complete"])
        self.assertIn("pull-requests-error", result["cacheStatus"]["issues"])

    def test_history_calendar_commit_second_page_failure_is_partial_and_keeps_first_page(self):
        first = [_commit(f"h{i:07d}", "2028-02-02T10:00:00Z") for i in range(history_service.COMMIT_PAGE_SIZE)]
        def commit_pages(repo_index, index):
            if index == 0:
                return _response({"value": first})
            return _response({"message": "boom"}, status=503)
        result, _posted, _prs = self._history_run_custom(commit_pages=commit_pages)
        self.assertFalse(result["cacheStatus"]["complete"])
        self.assertIn("commits-incomplete", result["cacheStatus"]["issues"])
        commit_events = [e for e in result["events"] if e["entity"]["type"] == "commit"]
        self.assertEqual(len(commit_events), history_service.COMMIT_PAGE_SIZE)

    def test_history_calendar_work_item_candidate_cap_is_partial(self):
        refs = [{"id": i} for i in range(3)]
        with patch.object(history_service, "CALENDAR_MAX_WORK_ITEMS", 2):
            result, _posted, _prs = self._history_run_custom(wiql_refs=refs)
        self.assertIn("work-items-capped", result["cacheStatus"]["issues"])
        self.assertFalse(result["cacheStatus"]["complete"])

    def test_history_calendar_wiql_also_matches_closed_date_inside_the_window(self):
        _result, posted, _prs = self._history_run_custom()
        self.assertIn("[Microsoft.VSTS.Common.ClosedDate] >= '2028-02-01T00:00:00Z'", posted[0])
        self.assertIn("[Microsoft.VSTS.Common.ClosedDate] < '2028-02-03T00:00:00Z'", posted[0])

    def test_history_rolling_wiql_keeps_today_clause(self):
        _, posted, _ = self._history_run(None, days=14)
        self.assertIn("[System.ChangedDate] >= @Today - 14 ", posted[0])

    def test_history_calendar_does_not_shortcut_from_cache_or_delete(self):
        with persistence.db_lock, persistence.get_db_connection() as conn:
            conn.execute(
                "INSERT INTO history_events (id, event_type, occurred_at, project, entity_type, entity_id, title, "
                "summary, actor_name, actor_id, url, source_endpoint, source_event_id, verification_status, last_synced_at) "
                "VALUES ('keep','git.commit','2028-01-05T10:00:00Z','P','commit','k','t','s','Ada','u1','','','','verified',?)",
                (NOW.isoformat(),))
        result, posted, _ = self._history_run(self.window)
        self.assertEqual(len(posted), 1, "fresh cache must not short-circuit a calendar request")
        with persistence.get_db_connection() as conn:
            ids = {r["id"] for r in conn.execute("SELECT id FROM history_events")}
        self.assertEqual(ids, {"keep", "commit-aaaaaaaa"})


if __name__ == "__main__":
    unittest.main()
