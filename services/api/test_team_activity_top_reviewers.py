"""The legacy top_reviewers list exposes reviewer assignments under both keys (synthetic data only)."""

import unittest
from unittest.mock import patch

import testsupport  # noqa: F401  (must precede the project imports)
import app as app_module

testsupport.isolate_database(globals())


class TestTopReviewers(unittest.TestCase):
    def test_top_reviewers_emit_reviewer_assignments_and_keep_count(self):
        prs = [{
            "id": 1, "project": "P", "repository": "R", "title": "t", "author": "Ada",
            "reviewers": ["Bob"], "reviewerVotes": [{"name": "Bob", "vote": 0}],
            "status": "active", "creationDate": "2028-03-02T10:00:00Z", "url": "",
        }]
        with patch.object(app_module, "_load_all_team_activity", return_value={"commits": [], "pullRequests": prs}), \
                patch.object(app_module, "_request_window", return_value=(
                    __import__("date_window").calendar_window(
                        __import__("datetime").date(2028, 3, 1), __import__("datetime").date(2028, 3, 5),
                        today=__import__("datetime").date(2028, 3, 10)), None)):
            response = app_module.app.test_client().get("/api/team-activity")
        self.assertEqual(response.status_code, 200)
        reviewers = response.get_json()["top_reviewers"]
        self.assertEqual(reviewers, [{"name": "Bob", "count": 1, "reviewerAssignments": 1}])


if __name__ == "__main__":
    unittest.main()
