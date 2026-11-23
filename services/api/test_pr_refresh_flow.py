"""Dashboard PR reads return snapshots quickly while one synthetic refresh runs."""
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import testsupport  # noqa: F401  (must precede the project imports)
import persistence
import pr_service
import request_coalescing

testsupport.isolate_database(globals())


class FakeRefreshFlights:
    def __init__(self):
        self.started = 0
        self.active = False

    def start(self, _key, _compute):
        if self.active:
            return False
        self.started += 1
        self.active = True
        return True

    def in_flight(self, _key):
        return self.active


class PullRequestSnapshotFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, 'pr-cache.db')
        self.db_patch = patch.object(persistence, 'DB_PATH', self.db_path)
        self.db_patch.start()
        pr_service.init_pr_db()
        self.now = datetime(2026, 11, 23, 12, 0, 0)
        self.flights = FakeRefreshFlights()

    def tearDown(self):
        self.db_patch.stop()
        self.temp_dir.cleanup()

    def seed_snapshot(self, completed_at):
        with persistence.get_db_connection() as conn:
            conn.execute('''INSERT INTO pull_requests
                (id, project, repository, title, status, creation_date, reviewers_json, work_items_json, last_synced_at)
                VALUES (1, 'Synthetic', 'repo', 'Synthetic PR', 'active', '2026-11-01', '[]', '[]', ?)''',
                (completed_at.isoformat(),))
            conn.execute('''INSERT INTO pr_cache_state
                (id, attempted_at, completed_at, outcome, successful_projects, errors_json, last_complete_at, scope)
                VALUES (1, ?, ?, 'complete', '[]', '[]', ?, 'project-inventory')''',
                (completed_at.isoformat(), completed_at.isoformat(), completed_at.isoformat()))

    def load(self):
        return pr_service.load_live_pull_requests(
            'https://dev.azure.com/synthetic', 'synthetic-token', self.flights, now=self.now
        )

    def test_fresh_snapshot_returns_without_scheduling_refresh(self):
        self.seed_snapshot(self.now - timedelta(seconds=30))
        with patch.object(pr_service.feature_context, 'is_fixture_mode', return_value=False):
            result = self.load()
        self.assertEqual([item['id'] for item in result['items']], [1])
        self.assertFalse(result['cacheStatus']['stale'])
        self.assertFalse(result['cacheStatus'].get('refreshing', False))
        self.assertEqual(self.flights.started, 0)

    def test_expired_snapshot_returns_stale_and_starts_one_refresh_for_concurrent_reads(self):
        self.seed_snapshot(self.now - timedelta(seconds=301))
        with patch.object(pr_service.feature_context, 'is_fixture_mode', return_value=False):
            first = self.load()
            second = self.load()
        self.assertEqual(first['items'], second['items'])
        self.assertTrue(first['cacheStatus']['stale'])
        self.assertTrue(first['cacheStatus']['refreshing'])
        self.assertEqual(self.flights.started, 1)

    def test_cold_cache_returns_loading_contract_and_starts_one_refresh(self):
        with patch.object(pr_service.feature_context, 'is_fixture_mode', return_value=False):
            result = self.load()
        self.assertEqual(result['items'], [])
        self.assertEqual(result['cacheStatus']['outcome'], 'loading')
        self.assertFalse(result['cacheStatus']['hasSnapshot'])
        self.assertTrue(result['cacheStatus']['refreshing'])
        self.assertEqual(self.flights.started, 1)

    def test_recent_failed_refresh_serves_snapshot_without_starting_another_refresh(self):
        self.seed_snapshot(self.now - timedelta(seconds=301))
        with persistence.get_db_connection() as conn:
            conn.execute("UPDATE pr_cache_state SET outcome='failed', attempted_at=? WHERE id=1",
                         ((self.now - timedelta(seconds=5)).isoformat(),))
        with patch.object(pr_service.feature_context, 'is_fixture_mode', return_value=False):
            result = self.load()
        self.assertEqual([item['id'] for item in result['items']], [1])
        self.assertTrue(result['cacheStatus']['stale'])
        self.assertEqual(result['cacheStatus']['retryAfterSeconds'], 30)
        self.assertFalse(result['cacheStatus']['refreshing'])
        self.assertEqual(self.flights.started, 0)

    def test_concurrent_dashboard_reads_start_one_real_refresh(self):
        self.seed_snapshot(self.now - timedelta(seconds=301))
        flights = request_coalescing.Coalescer()
        entered, release = threading.Event(), threading.Event()
        refresh_calls = []

        def refresh(*_args, **_kwargs):
            refresh_calls.append(1)
            entered.set()
            release.wait(2)
            return {'items': [], 'cacheStatus': {'outcome': 'complete'}}

        barrier = threading.Barrier(6)
        results = []

        def load():
            barrier.wait()
            results.append(pr_service.load_live_pull_requests(
                'https://dev.azure.com/synthetic', 'synthetic-token', flights, now=self.now
            ))

        with patch.object(pr_service.feature_context, 'is_fixture_mode', return_value=False), \
                patch.object(pr_service, 'sync_live_pull_requests', side_effect=refresh):
            threads = [threading.Thread(target=load) for _ in range(5)]
            for thread in threads:
                thread.start()
            barrier.wait()
            self.assertTrue(entered.wait(1))
            for thread in threads:
                thread.join(1)
            self.assertEqual(len(results), 5)
            self.assertTrue(all(result['items'][0]['id'] == 1 for result in results))
            release.set()
            flights.shutdown(timeout=1)
        self.assertEqual(refresh_calls, [1])


if __name__ == '__main__':
    unittest.main()
