"""Calendar commit chunks only persist commits; they never fetch live PRs (PRs come from the PR-window sync)."""

import unittest
from datetime import date, datetime
from unittest.mock import patch

import testsupport  # noqa: F401  (must precede the project imports)
import persistence
import team_service
from date_window import calendar_window

testsupport.isolate_database(globals())

NOW = datetime(2028, 3, 10, 12)


def _response(payload, status=200):
    return type("Response", (), {"status_code": status, "json": lambda self: payload})()


class CalendarCommitSyncNoLivePrTests(unittest.TestCase):
    def setUp(self):
        team_service.init_team_db()
        with persistence.db_lock, persistence.get_db_connection() as conn:
            conn.execute("DELETE FROM team_commits")
        self.window = calendar_window(date(2028, 2, 1), date(2028, 2, 2), today=date(2028, 3, 10))

    def _run(self):
        commit = {"commitId": "c1", "comment": "c",
                  "author": {"name": "Ada", "email": "ada@example.test", "date": "2028-02-01T08:00:00Z"}}

        def get(url, **kwargs):
            if url.endswith("/_apis/git/repositories?api-version=7.1"):
                return _response({"value": [{"id": 1, "name": "R", "project": {"name": "P"}}]})
            if "/commits?" in url:
                return _response({"value": [commit]})
            raise AssertionError(f"unexpected upstream call: {url}")

        with patch.object(team_service.feature_context, "get_devops_headers", return_value={}), \
                patch.object(team_service.azure_http, "get", side_effect=get), \
                patch.object(team_service, "_load_live_prs_summary_only",
                             side_effect=AssertionError("live PR fetch in commit chunk")), \
                patch.object(team_service, "_utcnow", return_value=NOW):
            return team_service.sync_live_team_activity("https://dev.azure.com/org", "unused", window=self.window)

    def test_commit_chunk_does_not_fetch_live_prs_and_returns_empty_pull_requests(self):
        result = self._run()
        self.assertEqual(result["pullRequests"], [])
        self.assertEqual([c["commitId"] for c in result["commits"]], ["c1"])
        self.assertEqual(result["cacheStatus"]["outcome"], "complete")
        self.assertTrue(result["cacheStatus"]["complete"])
        self.assertFalse(result["cacheStatus"]["stale"])


if __name__ == "__main__":
    unittest.main()
