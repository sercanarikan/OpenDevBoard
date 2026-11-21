"""Synthetic-only tests for internal metrics exposure and sync parity."""

import os
import re
import importlib
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

import testsupport  # noqa: F401
import observability
import azure_client
import sync_service
from test_sync_hardening import FakeAzure, ORG, raw_item, reset_db

testsupport.isolate_database(globals())


class ObservabilityTests(unittest.TestCase):
    def setUp(self):
        reset_db()

    def _sync_pair(self, enabled):
        results = []
        fake = FakeAzure([raw_item(101), raw_item(102, changed='2026-11-06T08:00:00Z')])
        with mock.patch.dict(os.environ, {'OBSERVABILITY_METRICS_ENABLED': '1' if enabled else '0'}), \
                mock.patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                fake.patch_all(), mock.patch.object(sync_service, '_sleep', lambda _seconds: None):
            results.append(sync_service.sync_work_items(ORG, 'synthetic', force_full=True))
            results.append(sync_service.sync_work_items(ORG, 'synthetic'))
            results.append(sync_service.sync_work_items(ORG, 'synthetic', max_items=1))
            fake.fail_details_after = len(fake.detail_calls) + 1
            results.append(sync_service.sync_work_items(ORG, 'synthetic'))
        visible = [{k: result[k] for k in ('status', 'mode', 'fetched', 'upserted', 'deleted',
                                            'context_upserted', 'details_fetched', 'synced_count', 'total_active')}
                   for result in results]
        with sync_service.get_db_connection() as conn:
            rows = [tuple(row) for row in conn.execute(
                'SELECT id, title, state, project, is_context, is_active, relations_json FROM work_items ORDER BY id')]
        return visible, rows

    @staticmethod
    def _histogram_count(metric_name, labels):
        for family in observability.REGISTRY.collect():
            if family.name != metric_name:
                continue
            for sample in family.samples:
                if sample.name.endswith('_count') and all(sample.labels.get(k) == v for k, v in labels.items()):
                    return sample.value
        return 0

    def test_metrics_on_and_off_have_identical_full_and_incremental_sync_results(self):
        tracked_outcomes = (('full', 'success'), ('incremental', 'success'),
                            ('incremental', 'partial'), ('incremental', 'error'))
        run_counts_before = {key: observability.SYNC_RUNS.labels(mode=key[0], status=key[1])._value.get()
                             for key in tracked_outcomes}
        full_count_before = self._histogram_count('opendevboard_sync_duration_seconds', {'mode': 'full'})
        incremental_count_before = self._histogram_count('opendevboard_sync_duration_seconds', {'mode': 'incremental'})
        enabled = self._sync_pair(True)
        self.assertEqual([result['status'] for result in enabled[0]], ['success', 'success', 'partial', 'error'])
        self.assertEqual([result['mode'] for result in enabled[0]],
                         ['full', 'incremental', 'incremental', 'incremental'])
        for mode, status in tracked_outcomes:
            self.assertEqual(observability.SYNC_RUNS.labels(mode=mode, status=status)._value.get()
                             - run_counts_before[(mode, status)], 1, (mode, status))
        self.assertEqual(self._histogram_count('opendevboard_sync_duration_seconds', {'mode': 'full'}) - full_count_before, 1)
        self.assertEqual(self._histogram_count('opendevboard_sync_duration_seconds', {'mode': 'incremental'}) - incremental_count_before, 3)
        counters_after_enabled = {
            ('full', 'success'): observability.SYNC_RUNS.labels(mode='full', status='success')._value.get(),
            ('incremental', 'success'): observability.SYNC_RUNS.labels(mode='incremental', status='success')._value.get(),
            ('incremental', 'partial'): observability.SYNC_RUNS.labels(mode='incremental', status='partial')._value.get(),
            ('incremental', 'error'): observability.SYNC_RUNS.labels(mode='incremental', status='error')._value.get(),
        }
        reset_db()
        disabled = self._sync_pair(False)
        self.assertEqual(enabled, disabled)
        self.assertEqual(counters_after_enabled, {
            ('full', 'success'): observability.SYNC_RUNS.labels(mode='full', status='success')._value.get(),
            ('incremental', 'success'): observability.SYNC_RUNS.labels(mode='incremental', status='success')._value.get(),
            ('incremental', 'partial'): observability.SYNC_RUNS.labels(mode='incremental', status='partial')._value.get(),
            ('incremental', 'error'): observability.SYNC_RUNS.labels(mode='incremental', status='error')._value.get(),
        })

    def test_metrics_endpoint_is_internal_and_does_not_expose_sensitive_labels(self):
        from testsupport import app
        client = app.app.test_client()
        response = client.get('/metrics', environ_base={'REMOTE_ADDR': '127.0.0.1'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content_type, 'text/plain; version=0.0.4; charset=utf-8')
        body = response.get_data(as_text=True)
        self.assertIn('opendevboard_sync_runs_total', body)
        self.assertNotIn('synthetic', body)
        labels = re.findall(r'\{([^}]*)\}', body)
        self.assertFalse(any('101' in label for label in labels))
        external = client.get('/metrics', environ_base={'REMOTE_ADDR': '8.8.8.8'})
        self.assertEqual(external.status_code, 404)
        for path in ('/api/metrics', '/api/metrics/', '/api//metrics'):
            self.assertEqual(client.get(path).status_code, 404, path)

        nginx = (Path(__file__).resolve().parents[2] / 'apps/web/nginx.conf').read_text()
        self.assertIn('location = /metrics {\n        return 404;\n    }', nginx)
        self.assertNotIn('proxy_pass http://api:5000/metrics', nginx)

    def test_disabled_metrics_stop_updates_and_endpoint_access(self):
        attempts = observability.HTTP_ATTEMPTS.labels(method='GET')._value.get()
        result_count = observability.HTTP_RESULTS.labels(result='2xx')._value.get()
        client = azure_client.AzureClient(ORG, 'synthetic', sleep=lambda _seconds: None)
        with mock.patch.dict(os.environ, {'OBSERVABILITY_METRICS_ENABLED': '0'}), \
                mock.patch.object(azure_client.requests, 'get', return_value=__import__(
                    'test_sync_hardening').Resp({'value': []})):
            self.assertEqual(client.get_items([101]).errors, [])
            observability.observe_http_result('2xx')
            from testsupport import app
            self.assertEqual(app.app.test_client().get('/metrics').status_code, 404)
        self.assertEqual(observability.HTTP_ATTEMPTS.labels(method='GET')._value.get(), attempts)
        self.assertEqual(observability.HTTP_RESULTS.labels(result='2xx')._value.get(), result_count)

    def test_scrape_without_sync_after_registry_restart_rehydrates_persisted_state(self):
        persisted = '2026-11-20T12:30:00+00:00'
        sync_service.set_sync_meta('last_success_at', persisted)
        sync_service.set_sync_meta('sync_status', 'partial')
        sync_service.set_sync_meta('closure_dirty', '1')
        # Reloading recreates a fresh process-local registry while the SQLite sync state remains durable.
        importlib.reload(observability)
        from testsupport import app
        body = app.app.test_client().get('/metrics').get_data(as_text=True)
        match = re.search(r'^opendevboard_last_successful_sync_timestamp_seconds ([^\s]+)$', body, re.MULTILINE)
        self.assertIsNotNone(match)
        self.assertAlmostEqual(float(match.group(1)), datetime.fromisoformat(persisted).timestamp())
        self.assertIn('opendevboard_sync_partial 1.0', body)
        self.assertIn('opendevboard_closure_dirty 1.0', body)

    def test_sync_metrics_failures_do_not_change_sync_result(self):
        fake = FakeAzure([raw_item(201)])
        with mock.patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                fake.patch_all(), mock.patch.object(sync_service, '_sleep', lambda _seconds: None), \
                mock.patch.object(observability.SYNC_RUNS, 'labels', side_effect=RuntimeError('metrics failure')), \
                mock.patch.object(observability.PHASE_DURATION, 'labels', side_effect=RuntimeError('metrics failure')), \
                mock.patch.object(observability.threading, 'Event', side_effect=RuntimeError('metrics setup failure')):
            result = sync_service.sync_work_items(ORG, 'synthetic', force_full=True)
        self.assertEqual(result['status'], 'success')
        self.assertEqual(sync_service.get_counts()['total_cached'], 1)

    def test_rejected_duplicate_trigger_does_not_create_a_sync_duration_sample(self):
        before = self._histogram_count('opendevboard_sync_duration_seconds', {'mode': 'full'})
        cpu_before = self._histogram_count('opendevboard_sync_cpu_seconds', {})
        peak_before = observability.SYNC_PEAK_RSS._value.get()
        self.assertTrue(sync_service.sync_lock.acquire(blocking=False))
        try:
            with mock.patch.object(sync_service, 'is_fixture_mode', return_value=False):
                result = sync_service.sync_work_items(ORG, 'synthetic')
        finally:
            sync_service.sync_lock.release()
        self.assertEqual(result['status'], 'in_progress')
        self.assertEqual(self._histogram_count('opendevboard_sync_duration_seconds', {'mode': 'full'}), before)
        self.assertEqual(self._histogram_count('opendevboard_sync_cpu_seconds', {}), cpu_before)
        self.assertEqual(observability.SYNC_PEAK_RSS._value.get(), peak_before)

        with mock.patch.object(sync_service, 'is_fixture_mode', return_value=True):
            fixture = sync_service.sync_work_items(ORG, 'synthetic')
        self.assertEqual(fixture['status'], 'error')
        self.assertEqual(self._histogram_count('opendevboard_sync_duration_seconds', {'mode': 'full'}), before)
        self.assertEqual(self._histogram_count('opendevboard_sync_cpu_seconds', {}), cpu_before)
        self.assertEqual(observability.SYNC_PEAK_RSS._value.get(), peak_before)

    def test_process_peak_and_sync_peak_rss_are_distinct(self):
        with mock.patch.dict(os.environ, {'OBSERVABILITY_METRICS_ENABLED': '1'}), \
                mock.patch.object(observability, '_rss_bytes', side_effect=[100, 200]), \
                mock.patch.object(observability.resource, 'getrusage',
                                  return_value=type('Usage', (), {'ru_maxrss': 1000})()):
            with observability.track_sync('full'):
                pass
        self.assertEqual(observability.SYNC_PEAK_RSS._value.get(), 200)
        self.assertEqual(observability.PROCESS_PEAK_RSS._value.get(), 1000 * 1024)

    def test_metric_family_labels_are_only_bounded_enums(self):
        observability.observe_http_result('2xx')
        allowed = {
            'le': {'0.005', '0.01', '0.025', '0.05', '0.075', '0.1', '0.25', '0.5', '0.75',
                   '1.0', '2.5', '5.0', '7.5', '10.0', '+Inf'},
            'mode': {'full', 'incremental'},
            'status': {'success', 'partial', 'error', 'in_progress', 'fixture_mode'},
            'phase': {'wiql', 'detail_fetch', 'context_closure', 'reconciliation', 'sqlite_publish'},
            'method': {'GET', 'POST'},
            'result': {'2xx', '429', '503', '4xx', '5xx', 'other', 'network'},
            'kind': {'fetched', 'upserted'},
        }
        maximum_series = {'opendevboard_sync_runs': 10, 'opendevboard_sync_duration_seconds': 2,
                          'opendevboard_sync_phase_duration_seconds': 5, 'opendevboard_http_attempts': 2,
                          'opendevboard_http_results': 7, 'opendevboard_work_items_processed': 2}
        for family in observability.REGISTRY.collect():
            seen = set()
            for sample in family.samples:
                # Histogram bucket `le` values are a fixed bucket dimension, not user-controlled series.
                seen.add(tuple(sorted((k, v) for k, v in sample.labels.items() if k != 'le')))
                for key, value in sample.labels.items():
                    self.assertIn(key, allowed, (family.name, key))
                    self.assertIn(value, allowed[key], (family.name, key, value))
            if family.name in maximum_series:
                self.assertLessEqual(len(seen), maximum_series[family.name], family.name)
        text = observability.render_metrics().decode('utf-8')
        self.assertNotRegex(text, r'(?i)(pat|organization|org_url|work_item_id|title|description|username)=')
        self.assertIn('result="2xx"', text)

    def test_retry_metrics_match_actual_network_attempts_for_429_and_503(self):
        from test_sync_hardening import Resp
        attempts_before = observability.HTTP_ATTEMPTS.labels(method='GET')._value.get()
        retries_before = observability.HTTP_RETRIES._value.get()
        rate_limit_before = observability.HTTP_RESULTS.labels(result='429')._value.get()
        unavailable_before = observability.HTTP_RESULTS.labels(result='503')._value.get()
        get = mock.Mock(side_effect=[Resp(status=429, headers={'Retry-After': '0'}),
                                     Resp(status=503), Resp({'value': []})])
        client = azure_client.AzureClient(ORG, 'synthetic', sleep=lambda _seconds: None)
        with mock.patch.object(azure_client.requests, 'get', get):
            result = client.get_items([101])
        self.assertEqual(result.errors, [])
        self.assertEqual(get.call_count, 3)
        self.assertEqual(observability.HTTP_ATTEMPTS.labels(method='GET')._value.get() - attempts_before, 3)
        self.assertEqual(observability.HTTP_RETRIES._value.get() - retries_before, 2)
        self.assertEqual(observability.HTTP_RESULTS.labels(result='429')._value.get() - rate_limit_before, 1)
        self.assertEqual(observability.HTTP_RESULTS.labels(result='503')._value.get() - unavailable_before, 1)


if __name__ == '__main__':
    unittest.main()
