"""Concurrent identical Azure DevOps summary loads share one fan-out."""
import threading
import unittest
from unittest.mock import patch

import testsupport  # noqa: F401  (must precede the project imports)
import app as api_app
import request_coalescing

testsupport.isolate_database(globals())


class CoalescerTests(unittest.TestCase):
    def _concurrently(self, coalescer, key, compute, callers=4):
        results, errors = [], []
        start = threading.Barrier(callers)

        def call():
            start.wait()
            try:
                results.append(coalescer.run(key, compute))
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=call) for _ in range(callers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        return results, errors

    def test_concurrent_callers_with_the_same_key_share_one_computation(self):
        coalescer = request_coalescing.Coalescer()
        calls, release = [], threading.Event()

        def compute():
            calls.append(1)
            release.wait(2)
            return {'items': [1, 2, 3]}

        threading.Timer(0.3, release.set).start()
        results, errors = self._concurrently(coalescer, ('pipelines', 30, False), compute)
        self.assertEqual(errors, [])
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 4)
        self.assertTrue(all(r == {'items': [1, 2, 3]} for r in results))

    def test_different_keys_do_not_share(self):
        coalescer = request_coalescing.Coalescer()
        self.assertEqual(coalescer.run(('a', 30, False), lambda: 'a'), 'a')
        self.assertEqual(coalescer.run(('a', 30, True), lambda: 'forced'), 'forced')
        self.assertEqual(coalescer.run(('a', 7, False), lambda: 'week'), 'week')

    def test_nothing_is_cached_after_the_flight_ends(self):
        coalescer = request_coalescing.Coalescer()
        calls = []
        coalescer.run('k', lambda: calls.append(1))
        coalescer.run('k', lambda: calls.append(1))
        self.assertEqual(len(calls), 2)

    def test_an_exception_reaches_every_waiting_caller_and_the_key_is_released(self):
        coalescer = request_coalescing.Coalescer()
        release = threading.Event()

        def boom():
            release.wait(2)
            raise RuntimeError('upstream failed')

        threading.Timer(0.3, release.set).start()
        results, errors = self._concurrently(coalescer, 'k', boom, callers=3)
        self.assertEqual(results, [])
        self.assertEqual(len(errors), 3)
        self.assertTrue(all(isinstance(e, RuntimeError) for e in errors))
        self.assertEqual(coalescer.run('k', lambda: 'recovered'), 'recovered')

    def test_background_start_is_single_flight_and_sync_run_joins_it(self):
        coalescer = request_coalescing.Coalescer()
        started, release = threading.Event(), threading.Event()
        calls = []

        def compute():
            calls.append(1)
            started.set()
            release.wait(2)
            return {'items': [1]}

        self.assertTrue(coalescer.start('prs', compute))
        self.assertTrue(started.wait(1))
        self.assertFalse(coalescer.start('prs', compute))
        self.assertTrue(coalescer.in_flight('prs'))
        result = []
        waiter = threading.Thread(target=lambda: result.append(coalescer.run('prs', lambda: 'duplicate')))
        waiter.start()
        release.set()
        waiter.join(2)
        self.assertEqual(result, [{'items': [1]}])
        self.assertEqual(len(calls), 1)
        self.assertFalse(coalescer.in_flight('prs'))

    def test_shutdown_rejects_new_background_work_and_waits_only_to_its_bound(self):
        coalescer = request_coalescing.Coalescer()
        started, release = threading.Event(), threading.Event()
        self.assertTrue(coalescer.start('prs', lambda: (started.set(), release.wait(2))))
        self.assertTrue(started.wait(1))
        coalescer.shutdown(timeout=0.01)
        self.assertFalse(coalescer.start('other', lambda: None))
        release.set()


class AppLoaderCoalescingTests(unittest.TestCase):
    def test_cold_identity_lookup_does_not_block_dashboard_and_is_single_flight(self):
        flights = request_coalescing.Coalescer()
        started, release, group_started = threading.Event(), threading.Event(), threading.Event()
        identity = {"id": "synthetic", "subjectDescriptor": "synthetic-descriptor"}

        def delayed_identity():
            started.set()
            release.wait(2)
            return identity

        def delayed_groups(*_args):
            group_started.set()
            return {'groupIds': [], 'status': 'available'}

        with patch.object(api_app, '_pr_background_flights', flights), \
                patch.object(api_app, '_pr_current_user_cache', None), \
                patch.object(api_app.sync_service, 'is_fixture_mode', return_value=False), \
                patch.object(api_app, 'get_current_user_info', side_effect=delayed_identity), \
                patch.object(api_app, 'get_devops_org_name', return_value='synthetic-org'), \
                patch.object(api_app, 'get_headers', return_value={}), \
                patch.object(api_app.pr_service, 'cached_user_group_ids', return_value=(None, False)), \
                patch.object(api_app.pr_service, 'fetch_user_group_ids', side_effect=delayed_groups) as groups:
            user = api_app._get_pr_current_user()
            self.assertTrue(started.wait(1))
            self.assertEqual(user['groupMembershipStatus'], 'unavailable')
            self.assertEqual(user['groupMembershipError']['kind'], 'loading')
            self.assertTrue(user['groupMembershipRefreshing'])
            self.assertTrue(flights.in_flight(('pr-current-user',)))
            release.set()
            self.assertTrue(group_started.wait(1))
            flights.shutdown(timeout=1)
        groups.assert_called_once()

    def _loads(self, loader, service, attr, kwargs=None):
        release = threading.Event()
        calls = []

        def slow(*args, **kw):
            calls.append(kw)
            release.wait(2)
            return {'items': [], 'cacheStatus': {'outcome': 'partial', 'complete': False, 'stale': False}}

        results = []
        threading.Timer(0.3, release.set).start()
        with patch.object(api_app.sync_service, 'is_fixture_mode', return_value=False), \
                patch.object(api_app, 'get_devops_org_url', return_value='https://dev.azure.com/org'), \
                patch.object(api_app, 'get_devops_org_name', return_value='org'), \
                patch.object(api_app, 'get_devops_pat', return_value='synthetic'), \
                patch.object(service, attr, side_effect=slow):
            threads = [threading.Thread(target=lambda: results.append(loader(**(kwargs or {})))) for _ in range(3)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(5)
        return calls, results

    def test_pipeline_loads_share_one_fan_out_but_a_forced_refresh_does_not_join_a_cached_read(self):
        calls, results = self._loads(api_app._load_all_pipelines, api_app.pipeline_service, 'sync_live_pipeline_runs', {'days': 30})
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 3)
        self.assertFalse(calls[0]['force_refresh'])
        with patch.object(api_app.sync_service, 'is_fixture_mode', return_value=False), \
                patch.object(api_app, 'get_devops_org_url', return_value='https://dev.azure.com/org'), \
                patch.object(api_app, 'get_devops_pat', return_value='synthetic'), \
                patch.object(api_app.pipeline_service, 'sync_live_pipeline_runs', return_value={'items': []}) as live:
            api_app._load_all_pipelines(days=30, force_refresh=True)
        self.assertTrue(live.call_args.kwargs['force_refresh'])

    def test_deployment_loads_share_one_fan_out(self):
        calls, results = self._loads(api_app._load_all_deployments, api_app.deployment_service, 'sync_live_deployments', {'days': 30})
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 3)

    def test_team_activity_loads_share_one_fan_out(self):
        calls, results = self._loads(api_app._load_all_team_activity, api_app.team_service, 'sync_live_team_activity', {'days': 7})
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 3)


if __name__ == '__main__':
    unittest.main()
