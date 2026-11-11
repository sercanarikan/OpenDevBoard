"""Regression coverage for invalid days query parameters across API routes."""

import unittest

import app as api_app


class TestDaysValidation(unittest.TestCase):
    def test_invalid_days_return_consistent_json_400_for_days_routes(self):
        routes = (
            "/api/team-activity",
            "/api/team-activity/summary",
            "/api/team-activity/contributors",
            "/api/team-activity/commits",
            "/api/team-activity/repositories",
            "/api/pipelines",
            "/api/pipelines/summary",
            "/api/pipelines/runs",
            "/api/deployment-metrics",
            "/api/deployments",
            "/api/deployments/summary",
            "/api/my-history",
            "/api/my-history/summary",
            "/api/my-history/timeline",
        )

        with api_app.app.test_client() as client:
            for route in routes:
                for value in ("invalid", "0", "-1", "1.5"):
                    with self.subTest(route=route, days=value):
                        response = client.get(f"{route}?days={value}")

                        self.assertEqual(response.status_code, 400)
                        self.assertEqual(response.get_json(), {
                            "error": "days must be a positive integer"
                        })

    def test_pipeline_health_keeps_its_existing_allowed_days_contract(self):
        with api_app.app.test_client() as client:
            for value in ("invalid", "0", "-1", "7.5", "8"):
                with self.subTest(days=value):
                    response = client.get(f"/api/pipeline-health?days={value}")

                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(response.get_json(), {
                        "error": "days must be one of: 7, 14, 30, 90"
                    })
