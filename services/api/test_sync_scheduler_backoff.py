"""Persistent scheduler backoff for repeated partial initial full syncs."""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import testsupport  # noqa: F401  (must precede project imports)
import app as api_app
import sync_service
from test_sync_hardening import FakeAzure, ORG, raw_item

testsupport.isolate_database(globals())


class FakeClock:
    def __init__(self):
        self.now = datetime(2026, 11, 22, tzinfo=timezone.utc)
        self.sleeps = []

    def utcnow(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += timedelta(seconds=seconds)


class InitialFullSyncBackoffTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.rb = __import__('run_backend')
        sync_service.set_sync_meta('last_full_sync', '')
        sync_service.set_sync_meta('initial_full_partial_count', '0')
        sync_service.set_sync_meta('initial_full_retry_at', '')
        for key, value in (('watermark', 'marker-before'), ('closure_dirty', '1'),
                           ('sync_status', 'partial'), ('last_sync_result', '{"status":"partial"}')):
            sync_service.set_sync_meta(key, value)

    def test_consecutive_partial_full_syncs_use_600_1200_2400_then_3600_seconds(self):
        with mock.patch.object(self.rb, '_utcnow', self.clock.utcnow):
            delays = [self.rb._record_scheduler_result({'status': 'partial', 'mode': 'full'})
                      for _ in range(5)]
        self.assertEqual(delays, [600, 1200, 2400, 3600, 3600])
        self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '5')
        for key, value in (('watermark', 'marker-before'), ('last_full_sync', ''),
                           ('closure_dirty', '1'), ('sync_status', 'partial'),
                           ('last_sync_result', '{"status":"partial"}')):
            self.assertEqual(sync_service.get_sync_meta(key), value)

    def test_retry_timestamp_survives_restart_and_waits_only_remaining_time(self):
        with mock.patch.object(self.rb, '_utcnow', self.clock.utcnow):
            self.rb._record_scheduler_result({'status': 'partial', 'mode': 'full'})
        self.clock.sleep(200)
        restarted_clock = FakeClock()
        restarted_clock.now = self.clock.now
        with mock.patch.object(self.rb, '_utcnow', restarted_clock.utcnow), \
                mock.patch.object(self.rb.time, 'sleep', restarted_clock.sleep):
            self.rb._wait_for_initial_full_retry()
        self.assertEqual(sum(restarted_clock.sleeps), 400)
        self.assertTrue(all(seconds <= 30 for seconds in restarted_clock.sleeps))
        self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '1')

    def test_partial_error_then_recovery_preserves_streak_until_full_success(self):
        with mock.patch.object(self.rb, '_utcnow', self.clock.utcnow):
            self.assertEqual(self.rb._record_scheduler_result({'status': 'partial', 'mode': 'full'}), 600)
            self.assertIsNone(self.rb._record_scheduler_result({'status': 'error', 'mode': 'full'}))
            self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '1')
            self.assertEqual(self.rb._record_scheduler_result({'status': 'partial', 'mode': 'full'}), 1200)
            self.rb._record_scheduler_result({'status': 'success', 'mode': 'full'})
        self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '0')
        self.assertEqual(sync_service.get_sync_meta('initial_full_retry_at'), '')

    def test_prior_success_and_incremental_partial_keep_normal_schedule(self):
        sync_service.set_sync_meta('last_full_sync', '2026-11-21T00:00:00')
        with mock.patch.object(self.rb, '_utcnow', self.clock.utcnow):
            self.assertIsNone(self.rb._record_scheduler_result({'status': 'partial', 'mode': 'full'}))
            self.assertIsNone(self.rb._record_scheduler_result({'status': 'partial', 'mode': 'incremental'}))
        self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '0')

    def test_manual_sync_endpoint_is_not_gated_by_scheduler_retry_timestamp(self):
        sync_service.set_sync_meta('initial_full_retry_at', (self.clock.now + timedelta(hours=1)).isoformat())
        with mock.patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                mock.patch.object(api_app, 'get_devops_org_url', return_value='https://dev.azure.com/synthetic'), \
                mock.patch.object(api_app, 'get_devops_pat', return_value='synthetic'), \
                mock.patch.object(sync_service, 'sync_work_items', return_value={
                    'status': 'partial', 'mode': 'full'}) as manual_sync:
            response = api_app.app.test_client().post('/api/sync', json={'mode': 'full'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(manual_sync.call_args.kwargs, {'force_full': True})

    def test_context_cap_and_http_attempt_budget_partial_causes_are_backed_off_in_both_chunk_modes(self):
        for chunked in ('0', '1'):
            with self.subTest(chunked=chunked), mock.patch.dict(os.environ, {'SYNC_CHUNKED': chunked}), \
                    mock.patch.object(self.rb, '_utcnow', self.clock.utcnow):
                sync_service.set_sync_meta('initial_full_partial_count', '0')
                sync_service.set_sync_meta('last_full_sync', '')
                delay = self.rb._record_scheduler_result({
                    'status': 'partial', 'mode': 'full', 'warnings': ['context_cap_reached:25000']})
                self.assertEqual(delay, 600)
                sync_service.set_sync_meta('initial_full_partial_count', '0')
                delay = self.rb._record_scheduler_result({
                    'status': 'partial', 'mode': 'full',
                    'warnings': ['context_request_budget_reached:2', 'http_attempt_budget_exhausted']})
                self.assertEqual(delay, 600)

    def test_six_hour_synthetic_request_attempts_fall_without_advancing_completion_markers(self):
        rb, clock, runs = self.rb, self.clock, []

        class StopLoop(BaseException):
            pass

        def fake_sync(_org, _pat, force_full=False):
            runs.append((clock.now, force_full))
            return {'status': 'partial', 'mode': 'full', 'warnings': ['context_cap_reached:25000']}

        def fake_sleep(seconds):
            clock.sleep(seconds)
            if (clock.now - datetime(2026, 11, 22, tzinfo=timezone.utc)).total_seconds() >= 6 * 3600:
                raise StopLoop

        env = {'AZURE_DEVOPS_ORG_URL': 'https://dev.azure.com/synthetic', 'AZURE_DEVOPS_PAT': 'synthetic'}
        with mock.patch.dict(os.environ, env), mock.patch.object(rb, 'SYNC_INTERVAL_SEC', 300), \
                mock.patch.object(rb, '_utcnow', clock.utcnow), \
                mock.patch.object(rb.sync_service, 'sync_work_items', fake_sync), \
                mock.patch.object(rb.time, 'sleep', fake_sleep):
            with self.assertRaises(StopLoop):
                rb.background_sync_loop()

        baseline_runs = 6 * 3600 // 300
        attempts_per_fixture_run = 4
        self.assertEqual(len(runs), 8)
        self.assertTrue(all(force_full for _, force_full in runs))
        self.assertEqual(baseline_runs, 72)
        self.assertEqual((baseline_runs - len(runs)) * attempts_per_fixture_run, 256)
        self.assertEqual(sync_service.get_sync_meta('watermark'), 'marker-before')
        self.assertEqual(sync_service.get_sync_meta('last_full_sync'), '')
        self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '1')

    def test_scheduler_keeps_fast_error_retry_between_partial_and_success(self):
        rb, clock, outcomes, calls = self.rb, self.clock, iter(('partial', 'error', 'success')), []

        class StopLoop(Exception):
            pass

        def fake_sync(_org, _pat, force_full=False):
            calls.append((clock.now, force_full))
            status = next(outcomes)
            if status == 'success':
                sync_service.set_sync_meta('last_full_sync', clock.now.isoformat())
            return {'status': status, 'mode': 'full'}

        def fake_sleep(seconds):
            clock.sleep(seconds)
            if len(calls) == 3:
                raise StopLoop

        env = {'AZURE_DEVOPS_ORG_URL': 'https://dev.azure.com/synthetic', 'AZURE_DEVOPS_PAT': 'synthetic'}
        with mock.patch.dict(os.environ, env), mock.patch.object(rb, '_utcnow', clock.utcnow), \
                mock.patch.object(rb.sync_service, 'sync_work_items', fake_sync), \
                mock.patch.object(rb.time, 'sleep', fake_sleep):
            with self.assertRaises(StopLoop):
                rb.background_sync_loop()
        offsets = [(when - datetime(2026, 11, 22, tzinfo=timezone.utc)).total_seconds()
                   for when, _ in calls]
        self.assertEqual(offsets, [0, 600, 605])
        self.assertTrue(all(force_full for _, force_full in calls))
        self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '0')
        self.assertEqual(sync_service.get_sync_meta('initial_full_retry_at'), '')

    def test_restart_waits_without_real_sleep(self):
        with mock.patch.object(self.rb, '_utcnow', self.clock.utcnow):
            self.rb._record_scheduler_result({'status': 'partial', 'mode': 'full'})
        with mock.patch.object(self.rb, '_utcnow', self.clock.utcnow), \
                mock.patch.object(self.rb.time, 'sleep', self.clock.sleep):
            self.rb._wait_for_initial_full_retry()
        self.assertEqual(sum(self.clock.sleeps), 600)
        self.assertTrue(all(seconds <= 30 for seconds in self.clock.sleeps))

    def test_manual_chunked_full_success_interrupts_backoff_and_resumes_regular_schedule(self):
        rb, clock = self.rb, self.clock
        scheduled_calls, manual_results, manual_active = [], [], [False]
        fake = FakeAzure([raw_item(1)])
        real_sync = sync_service.sync_work_items

        class StopLoop(BaseException):
            pass

        def dispatch_sync(org_url, pat, force_full=False):
            if manual_active[0]:
                with fake.patch_all(), mock.patch.object(sync_service, '_sleep', lambda _seconds: None):
                    result = real_sync(org_url, pat, force_full=force_full)
                manual_results.append(result)
                return result
            scheduled_calls.append((clock.now, force_full))
            return {'status': 'partial', 'mode': 'full'}

        def fake_sleep(seconds):
            clock.sleep(seconds)
            if not manual_results:
                manual_active[0] = True
                with mock.patch.dict(os.environ, {'SYNC_CHUNKED': '1'}), \
                        mock.patch.object(api_app, 'get_devops_org_url', return_value=ORG), \
                        mock.patch.object(api_app, 'get_devops_pat', return_value='synthetic'):
                    response = api_app.app.test_client().post('/api/sync', json={'mode': 'full'})
                self.assertEqual(response.status_code, 200)
                manual_active[0] = False
            else:
                raise StopLoop

        env = {'AZURE_DEVOPS_ORG_URL': ORG, 'AZURE_DEVOPS_PAT': 'synthetic'}
        with mock.patch.dict(os.environ, env), mock.patch.object(rb, '_utcnow', clock.utcnow), \
                mock.patch.object(rb.sync_service, 'sync_work_items', dispatch_sync), \
                mock.patch.object(rb.time, 'sleep', fake_sleep):
            with self.assertRaises(StopLoop):
                rb.background_sync_loop()

        self.assertEqual(clock.sleeps, [30, 300])
        self.assertEqual(len(scheduled_calls), 1)
        self.assertEqual(len(manual_results), 1)
        self.assertEqual(manual_results[0]['status'], 'success')
        self.assertTrue(sync_service.get_sync_meta('watermark'))
        self.assertTrue(sync_service.get_sync_meta('last_full_sync'))
        self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '0')
        self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '0')
        self.assertEqual(sync_service.get_sync_meta('initial_full_retry_at'), '')


if __name__ == '__main__':
    unittest.main()
