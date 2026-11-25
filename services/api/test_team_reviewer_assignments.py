"""Team Activity reviewer assignment vs current vote state (synthetic data only)."""

import unittest
from datetime import date

import testsupport  # noqa: F401  (must precede the project imports)
import team_service
from date_window import calendar_window

testsupport.isolate_database(globals())


def _pr(pr_id, created, author, votes):
    return {
        "id": pr_id, "project": "P", "repository": "R", "title": "t", "author": author,
        "reviewers": [v["name"] for v in votes], "reviewerVotes": votes,
        "status": "active", "creationDate": created, "url": "",
    }


class TestReviewerAssignments(unittest.TestCase):
    def setUp(self):
        self.window = calendar_window(date(2028, 3, 1), date(2028, 3, 5), today=date(2028, 3, 10))

    def _contributors(self, prs):
        summary = team_service.compute_team_summary([], prs, window=self.window)
        return {c["name"]: c for c in summary["contributors"]}

    def test_vote_zero_is_assignment_only_and_vote_ten_is_both(self):
        prs = [_pr(1, "2028-03-02T10:00:00Z", "Ada", [
            {"name": "Bob", "vote": 0}, {"name": "Cy", "vote": 10},
        ])]
        c = self._contributors(prs)
        self.assertEqual(c["Bob"]["reviewerAssignments"], 1)
        self.assertEqual(c["Bob"]["reviewVotesCount"], 0)
        self.assertEqual(c["Cy"]["reviewerAssignments"], 1)
        self.assertEqual(c["Cy"]["reviewVotesCount"], 1)
        self.assertEqual(c["Bob"]["reviewsCount"], c["Bob"]["reviewerAssignments"])

    def test_author_is_never_counted_as_reviewer(self):
        prs = [_pr(1, "2028-03-02T10:00:00Z", "Ada", [{"name": "Ada", "vote": 10}])]
        c = self._contributors(prs)
        self.assertEqual(c["Ada"]["reviewerAssignments"], 0)
        self.assertEqual(c["Ada"]["reviewVotesCount"], 0)
        self.assertEqual(c["Ada"]["reviewsCount"], 0)

    def test_prs_outside_window_are_not_counted(self):
        prs = [_pr(1, "2028-03-20T10:00:00Z", "Ada", [{"name": "Bob", "vote": 10}])]
        self.assertNotIn("Bob", self._contributors(prs))

    def test_legacy_pr_without_vote_data_counts_assignment_only(self):
        pr = _pr(1, "2028-03-02T10:00:00Z", "Ada", [])
        pr["reviewers"] = ["Bob"]
        del pr["reviewerVotes"]
        c = self._contributors([pr])
        self.assertEqual(c["Bob"]["reviewerAssignments"], 1)
        self.assertEqual(c["Bob"]["reviewVotesCount"], 0)

    def test_live_normalization_keeps_vote_zero_reviewers(self):
        raw = [{"displayName": "Bob", "vote": 0}, {"displayName": "Cy", "vote": -5}, {"vote": 10}]
        self.assertEqual(
            team_service._reviewer_votes(raw),
            [{"name": "Bob", "vote": 0}, {"name": "Cy", "vote": -5}],
        )


if __name__ == "__main__":
    unittest.main()
