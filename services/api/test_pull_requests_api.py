"""Synthetic API contract tests for PR refresh failures and stale fallback."""

import unittest
from unittest.mock import patch

import app as api_app
import pr_service


class TestPullRequestFailureResponses(unittest.TestCase):
    def setUp(self):
        self.client = api_app.app.test_client()

    def test_failed_refresh_without_cache_is_not_returned_as_zero_prs(self):
        failed = {"items": [], "cacheStatus": {"outcome": "failed", "complete": False, "stale": True, "errors": [{"kind": "auth", "status": 403}]}}
        with patch.object(api_app, '_get_pr_current_user', return_value={"id": "fixture-user"}), \
                patch.object(api_app, '_load_all_prs', return_value=failed):
            responses = [
                self.client.get('/api/pull-requests?project=all&status=active&quickFilter=needs-my-review'),
                self.client.get('/api/pull-requests/summary?project=all'),
                self.client.get('/api/my-pull-requests'),
            ]
        self.assertTrue(all(response.status_code == 503 for response in responses))
        self.assertTrue(all(response.get_json()['cacheStatus']['outcome'] == 'failed' for response in responses))

    def test_partial_refresh_without_snapshot_is_not_returned_as_zero_prs(self):
        partial = {"items": [], "cacheStatus": {"outcome": "partial", "complete": False, "stale": True, "hasSnapshot": False, "errors": [{"kind": "auth", "status": 403}]}}
        with patch.object(api_app, '_get_pr_current_user', return_value={"id": "fixture-user"}), \
                patch.object(api_app, '_load_all_prs', return_value=partial):
            response = self.client.get('/api/pull-requests/summary?project=all')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()['cacheStatus']['outcome'], 'partial')

    def test_failed_refresh_can_serve_a_successful_empty_snapshot_as_stale(self):
        stale_empty = {"items": [], "cacheStatus": {"outcome": "failed", "complete": False, "stale": True, "hasSnapshot": True, "lastSyncedAt": "2026-11-01T00:00:00Z", "errors": [{"kind": "timeout"}]}}
        with patch.object(api_app, '_get_pr_current_user', return_value={"id": "fixture-user"}), \
                patch.object(api_app, '_load_all_prs', return_value=stale_empty):
            response = self.client.get('/api/pull-requests/summary?project=all')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['cacheStatus']['hasSnapshot'])
        self.assertTrue(response.get_json()['cacheStatus']['stale'])

    def test_failed_refresh_with_cache_returns_stale_rows_and_status(self):
        cached = {
            "items": [dict(pr_service.build_fixture_prs()[0])],
            "cacheStatus": {"outcome": "failed", "complete": False, "stale": True, "lastSyncedAt": "2026-11-01T00:00:00Z", "errors": [{"kind": "timeout"}]},
        }
        with patch.object(api_app, '_get_pr_current_user', return_value={"id": "00000000-0000-0000-0000-000000000001"}), \
                patch.object(api_app, '_load_all_prs', return_value=cached):
            response = self.client.get('/api/pull-requests?project=all&status=active&quickFilter=all')
        self.assertEqual(response.status_code, 200)
        self.assertGreater(response.get_json()['total'], 0)
        self.assertTrue(response.get_json()['cacheStatus']['stale'])
        self.assertEqual(response.get_json()['cacheStatus']['errors'][0]['kind'], 'timeout')


if __name__ == '__main__':
    unittest.main()
