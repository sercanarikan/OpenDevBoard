"""Unit and integration tests for My History personal activity service and endpoints."""

import unittest
from datetime import datetime
import history_service


class TestMyHistoryService(unittest.TestCase):
    def setUp(self):
        history_service.init_history_db()
        self.fixture_data = history_service.build_fixture_history("Fixture User")

    def test_fixture_history_events_structure(self):
        self.assertIn("events", self.fixture_data)
        self.assertGreaterEqual(len(self.fixture_data["events"]), 15)

        e0 = self.fixture_data["events"][0]
        self.assertIn("id", e0)
        self.assertIn("eventType", e0)
        self.assertIn("occurredAt", e0)
        self.assertIn("project", e0)
        self.assertIn("entity", e0)
        self.assertIn("summary", e0)
        self.assertIn("actor", e0)
        self.assertIn("sourceEndpoint", e0)
        self.assertIn("sourceEventId", e0)
        self.assertIn("verificationStatus", e0)
        self.assertEqual(e0["verificationStatus"], "verified")

    def test_event_provenance_verification_helper(self):
        # 1. Work Item closed by the user -> verified
        wi_verified = history_service.verify_work_item_event(
            wi_id=123,
            title="Fix bug",
            project="Alpha",
            closed_date="2026-11-06T10:00:00Z",
            closed_by={"displayName": "Fixture User", "id": "usr-1"},
            user_info={"displayName": "Fixture User", "id": "usr-1"}
        )
        self.assertIsNotNone(wi_verified)
        self.assertEqual(wi_verified["verificationStatus"], "verified")
        self.assertEqual(wi_verified["actor"]["displayName"], "Fixture User")
        self.assertEqual(wi_verified["sourceEndpoint"], "/_apis/wit/workitems/123")

        # 2. Work Item closed by another person -> rejected (returns None)
        wi_rejected = history_service.verify_work_item_event(
            wi_id=124,
            title="Other bug",
            project="Alpha",
            closed_date="2026-11-06T10:00:00Z",
            closed_by={"displayName": "Someone Else", "id": "usr-other"},
            user_info={"displayName": "Fixture User", "id": "usr-1"}
        )
        self.assertIsNone(wi_rejected)

        # 3. PR merged by another person -> user only gets PR created event, not merged event
        pr_raw = {
            "pullRequestId": 555,
            "title": "New feature",
            "repository": {"name": "Alpha.Web", "project": {"name": "Alpha"}},
            "createdBy": {"displayName": "Fixture User", "id": "usr-1"},
            "closedBy": {"displayName": "Tech Lead", "id": "usr-lead"},
            "creationDate": "2026-11-05T09:00:00Z",
            "closedDate": "2026-11-06T15:00:00Z",
            "status": "completed",
            "reviewers": []
        }
        user_info = {"displayName": "Fixture User", "id": "usr-1"}
        events = history_service.extract_verified_pr_events(pr_raw, user_info, "https://dev.azure.com/org")
        # Should contain created event, but NOT merged event attributed to Fixture User
        event_types = [e["eventType"] for e in events]
        self.assertIn("git.pullRequest.created", event_types)
        self.assertNotIn("git.pullRequest.merged", event_types)

    def test_pr_review_requires_reviewer_timestamp_and_uses_reviewer_event_identity(self):
        user = {"displayName": "Fixture User", "id": "usr-1"}
        base = {
            "pullRequestId": 555,
            "title": "Review provenance",
            "repository": {"name": "Alpha.Web", "project": {"name": "Alpha"}},
            "creationDate": "2026-11-01T09:00:00Z",
            "status": "active",
            "lastModifiedDate": "2026-11-06T15:00:00Z",
            "reviewers": [{"id": "usr-1", "displayName": "Fixture User", "vote": 10}],
        }

        no_vote_time = history_service.extract_verified_pr_events(base, user, "https://dev.azure.com/org")
        self.assertNotIn("git.pullRequest.reviewed", [event["eventType"] for event in no_vote_time])

        with_vote_time = {**base, "reviewers": [{
            "id": "usr-1", "displayName": "Fixture User", "vote": 10,
            "voteDate": "2026-11-05T12:30:00Z",
        }]}
        events = history_service.extract_verified_pr_events(with_vote_time, user, "https://dev.azure.com/org")
        reviews = [event for event in events if event["eventType"] == "git.pullRequest.reviewed"]
        self.assertEqual(len(reviews), 1)
        self.assertEqual(reviews[0]["occurredAt"], "2026-11-05T12:30:00Z")
        self.assertEqual(reviews[0]["sourceEventId"], "555")

    def test_pr_review_does_not_accept_pr_modified_time_as_vote_time(self):
        user = {"displayName": "Fixture User", "id": "usr-1"}
        pr = {
            "pullRequestId": 556,
            "title": "Not a review timestamp",
            "repository": {"name": "Alpha.Web", "project": {"name": "Alpha"}},
            "creationDate": "2026-11-01T09:00:00Z",
            "lastModifiedDate": "2026-11-06T15:00:00Z",
            "reviewers": [{
                "id": "usr-1", "displayName": "Fixture User", "vote": 10,
                "lastUpdatedDate": "2026-11-05T12:30:00Z",
            }],
        }
        events = history_service.extract_verified_pr_events(pr, user, "https://dev.azure.com/org")
        self.assertNotIn("git.pullRequest.reviewed", [event["eventType"] for event in events])

    def test_compute_history_summary(self):
        summary = history_service.compute_history_summary(
            self.fixture_data["events"],
            days=30
        )

        self.assertIn("totalEvents", summary)
        self.assertIn("completedWorkItems", summary)
        self.assertIn("commitsCount", summary)
        self.assertIn("prsCount", summary)
        self.assertIn("reviewsCount", summary)
        self.assertIn("projectsTouched", summary)
        self.assertIn("dailyHeatmap", summary)

        self.assertGreater(summary["totalEvents"], 0)
        self.assertGreater(summary["completedWorkItems"], 0)
        self.assertGreater(summary["commitsCount"], 0)
        self.assertGreater(len(summary["projectsTouched"]), 0)

    def test_compute_history_summary_project_scope_matches_timeline(self):
        summary = history_service.compute_history_summary(self.fixture_data["events"], days=30, project="Alpha")
        timeline = history_service.query_history_events(self.fixture_data["events"], {"days": "30", "project": "Alpha", "limit": "100"})
        self.assertEqual(summary["totalEvents"], timeline["total"])
        self.assertTrue(all(project.lower() == "alpha" for project in summary["projectsTouched"]))

    def test_summary_and_timeline_share_project_date_type_and_search_scope(self):
        params = {"days": "30", "project": "Alpha", "activityType": "pullRequest", "search": "PR", "limit": "2", "offset": "0"}
        summary = history_service.compute_history_summary(
            self.fixture_data["events"], days=30, project="Alpha", activity_type="pullRequest", search="PR"
        )
        timeline = history_service.query_history_events(self.fixture_data["events"], params)
        self.assertEqual(summary["totalEvents"], timeline["total"])
        self.assertEqual(summary["totalMatchingEvents"], timeline["total"])
        self.assertEqual(len(timeline["items"]), min(2, timeline["total"]))

    def test_history_summary_endpoint_uses_project_and_days_scope(self):
        from unittest.mock import patch
        import app as api_app

        with patch.object(api_app, "_load_all_history", return_value=self.fixture_data):
            response = api_app.app.test_client().get("/api/my-history/summary?project=Alpha&days=30")
        self.assertEqual(response.status_code, 200)
        summary = response.get_json()
        timeline = history_service.query_history_events(
            self.fixture_data["events"], {"project": "Alpha", "days": "30", "limit": "100"}
        )
        self.assertEqual(summary["totalEvents"], timeline["total"])

    def test_history_summary_endpoint_uses_timeline_filters(self):
        from unittest.mock import patch
        import app as api_app

        with patch.object(api_app, "_load_all_history", return_value=self.fixture_data):
            response = api_app.app.test_client().get(
                "/api/my-history/summary?project=Alpha&days=30&activityType=pullRequest&search=PR"
            )
        self.assertEqual(response.status_code, 200)
        timeline = history_service.query_history_events(
            self.fixture_data["events"], {"project": "Alpha", "days": "30", "activityType": "pullRequest", "search": "PR", "limit": "25"}
        )
        self.assertEqual(response.get_json()["totalEvents"], timeline["total"])
        self.assertEqual(response.get_json()["totalMatchingEvents"], timeline["total"])

    def test_query_history_events_pagination(self):
        p1 = history_service.query_history_events(
            self.fixture_data["events"],
            {"limit": "5", "offset": "0"}
        )
        self.assertEqual(len(p1["items"]), 5)
        self.assertEqual(p1["limit"], 5)
        self.assertEqual(p1["offset"], 0)
        self.assertTrue(p1["hasMore"])

        p2 = history_service.query_history_events(
            self.fixture_data["events"],
            {"limit": "5", "offset": "5"}
        )
        self.assertEqual(len(p2["items"]), 5)
        ids1 = {e["id"] for e in p1["items"]}
        ids2 = {e["id"] for e in p2["items"]}
        self.assertEqual(len(ids1 & ids2), 0)

    def test_query_history_events_filters(self):
        # Filter by activityType: commit
        commit_res = history_service.query_history_events(
            self.fixture_data["events"],
            {"activityType": "commit", "limit": "50"}
        )
        self.assertGreater(len(commit_res["items"]), 0)
        for e in commit_res["items"]:
            self.assertEqual(e["entity"]["type"], "commit")

        # Filter by activityType: workItem
        wi_res = history_service.query_history_events(
            self.fixture_data["events"],
            {"activityType": "workItem", "limit": "50"}
        )
        self.assertGreater(len(wi_res["items"]), 0)
        for e in wi_res["items"]:
            self.assertEqual(e["entity"]["type"], "workItem")

        # Filter by project
        alpha_res = history_service.query_history_events(
            self.fixture_data["events"],
            {"project": "Alpha", "limit": "50"}
        )
        for e in alpha_res["items"]:
            self.assertEqual(e["project"], "Alpha")

        # Search query
        search_res = history_service.query_history_events(
            self.fixture_data["events"],
            {"search": "jwt", "limit": "50"}
        )
        for e in search_res["items"]:
            text = (e["summary"] + " " + e["entity"].get("title", "")).lower()
            self.assertIn("jwt", text)

    def test_group_events_by_relative_timeline(self):
        grouped = history_service.group_events_by_timeline(self.fixture_data["events"])
        self.assertIn("today", grouped)
        self.assertIn("yesterday", grouped)
        self.assertIn("thisWeek", grouped)
        self.assertIn("earlier", grouped)
        total_grouped = len(grouped["today"]) + len(grouped["yesterday"]) + len(grouped["thisWeek"]) + len(grouped["earlier"])
        self.assertEqual(total_grouped, len(self.fixture_data["events"]))


if __name__ == '__main__':
    unittest.main()
