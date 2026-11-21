import os
import unittest
from unittest import mock

import testsupport  # noqa: F401
import azure_client
import sync_service
import sync_staging
from test_sync_hardening import FakeAzure, raw_item, reset_db, rows, run_sync
from test_azure_client import FakeResponse

testsupport.isolate_database(globals())


def configured_sync(fake, budget, chunked, workers=4, force_full=True):
    client = azure_client.AzureClient('https://dev.azure.com/synthetic', 'synthetic',
                                      sleep=lambda _: None, workers=workers)
    env = {'SYNC_CONTEXT_POLICY': 'budgeted', 'SYNC_CONTEXT_MAX_ITEMS': '400000',
           'SYNC_CONTEXT_MAX_REQUESTS': str(budget), 'SYNC_CHUNKED': '1' if chunked else '0'}
    with mock.patch.dict(os.environ, env), fake.patch_all():
        result = sync_service.sync_work_items('https://dev.azure.com/synthetic', 'synthetic',
                                              force_full=force_full, client=client)
    return result, client


class SyncWideAttemptBudget(unittest.TestCase):
    def setUp(self):
        reset_db()

    def test_default_policy_keeps_the_fixed_cap_and_disables_request_budget(self):
        env = {'SYNC_CONTEXT_POLICY': '', 'SYNC_CONTEXT_MAX_ITEMS': '', 'SYNC_CONTEXT_MAX_REQUESTS': ''}
        with mock.patch.dict(os.environ, env):
            self.assertEqual(sync_service.context_budgets(), (25000, None))

    def test_budgeted_policy_rejects_missing_or_nonpositive_budgets_before_http(self):
        for values in ({}, {'SYNC_CONTEXT_MAX_ITEMS': '0', 'SYNC_CONTEXT_MAX_REQUESTS': '1'},
                       {'SYNC_CONTEXT_MAX_ITEMS': '1', 'SYNC_CONTEXT_MAX_REQUESTS': '-1'}):
            with self.subTest(values=values):
                fake = FakeAzure([raw_item(1, state='Active')])
                client = azure_client.AzureClient('https://dev.azure.com/synthetic', 'synthetic',
                                                  sleep=lambda _: None, workers=4)
                env = {'SYNC_CONTEXT_POLICY': 'budgeted', 'SYNC_CONTEXT_MAX_ITEMS': '',
                       'SYNC_CONTEXT_MAX_REQUESTS': '', **values}
                with mock.patch.dict(os.environ, env), fake.patch_all():
                    result = sync_service.sync_work_items('https://dev.azure.com/synthetic', 'synthetic',
                                                          force_full=True, client=client)
                self.assertEqual(result['status'], 'error')
                self.assertIn('context_budget_config_invalid', result['error'])
                self.assertEqual(client.stats['requests'], 0)

    def test_budget_covers_wiql_main_details_and_context_in_both_sync_modes(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                fake = FakeAzure([raw_item(1, state='Active', children=[2]),
                                  raw_item(2, state='Closed', parent=1)])
                result, client = configured_sync(fake, budget=2, chunked=chunked)
                self.assertEqual(result['status'], 'partial')
                self.assertIn('context_request_budget_reached:2', result['warnings'])
                self.assertEqual(client.stats['requests'], 2)  # one WIQL + one main-details attempt
                self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '1')
                self.assertIsNone(sync_service.get_sync_meta('watermark'))
                self.assertIsNone(sync_service.get_sync_meta('last_full_sync'))
                self.assertIsNone(sync_service.get_sync_meta('last_success_at'))

    def test_sync_succeeds_when_global_budget_exactly_covers_wiql_main_and_context(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                fake = FakeAzure([raw_item(1, state='Active', children=[2]),
                                  raw_item(2, state='Closed', parent=1)])
                result, client = configured_sync(fake, budget=3, chunked=chunked, workers=8)
                self.assertEqual(result['status'], 'success')
                self.assertEqual(client.stats['requests'], 3)
                self.assertEqual(result['context_upserted'], 1)
                self.assertTrue(sync_service.get_sync_meta('watermark'))
                self.assertTrue(sync_service.get_sync_meta('last_full_sync'))
                self.assertTrue(sync_service.get_sync_meta('last_success_at'))
                self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '0')

    def test_retry_attempt_consumes_global_budget_before_main_read(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                fake = FakeAzure([raw_item(1, state='Active')])
                fake.rate_limit_first = 1  # first WIQL attempt is throttled, then retried successfully
                result, client = configured_sync(fake, budget=2, chunked=chunked, workers=4)
                self.assertEqual(result['status'], 'error')
                self.assertIn('http_attempt_budget_exhausted', result['error'])
                self.assertEqual(client.stats['requests'], 2)  # throttled WIQL + its retry
                self.assertEqual(rows(), [])  # no main payload or snapshot was published
                self.assertIsNone(sync_service.get_sync_meta('watermark'))
                self.assertIsNone(sync_service.get_sync_meta('last_full_sync'))
                self.assertIsNone(sync_service.get_sync_meta('last_success_at'))

    def test_default_cap_stays_25000_and_does_not_fetch_an_oversized_frontier(self):
        items = [raw_item(1, state='Active', children=range(2, 25003))]
        items.extend(raw_item(item_id, state='Closed', parent=1) for item_id in range(2, 25003))
        self.assertEqual(sync_service.MAX_CONTEXT_ITEMS, 25000)
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                fake = FakeAzure(items)
                client = azure_client.AzureClient('https://dev.azure.com/synthetic', 'synthetic',
                                                  sleep=lambda _: None, workers=1)
                env = {'SYNC_CONTEXT_POLICY': '', 'SYNC_CONTEXT_MAX_ITEMS': '', 'SYNC_CONTEXT_MAX_REQUESTS': '',
                       'SYNC_CHUNKED': '1' if chunked else '0'}
                with mock.patch.dict(os.environ, env), fake.patch_all():
                    result = sync_service.sync_work_items('https://dev.azure.com/synthetic', 'synthetic',
                                                          force_full=True, client=client)
                self.assertEqual(result['status'], 'partial')
                self.assertIn('context_cap_reached:25000', result['warnings'])
                self.assertEqual(result['context_upserted'], 0)
                self.assertEqual(client.stats['requests'], 2)  # WIQL and main detail only
                self.assertIsNone(sync_service.get_sync_meta('watermark'))
                self.assertIsNone(sync_service.get_sync_meta('last_full_sync'))
                self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '1')

    def test_budget_exhausted_during_main_read_preserves_previous_snapshot_and_markers(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                baseline = FakeAzure([raw_item(1, state='Active')])
                first = run_sync(baseline, force_full=True)
                self.assertEqual(first['status'], 'success')
                before_rows = rows()
                before_meta = {key: sync_service.get_sync_meta(key)
                               for key in ('watermark', 'last_full_sync', 'last_success_at')}

                fake = FakeAzure([raw_item(1, state='Active'), raw_item(2, state='Active')])
                result, client = configured_sync(fake, budget=1, chunked=chunked, workers=8)
                self.assertEqual(result['status'], 'error')
                self.assertIn('http_attempt_budget_exhausted', result['error'])
                self.assertEqual(client.stats['requests'], 1)
                self.assertEqual(rows(), before_rows)
                self.assertEqual(before_meta, {key: sync_service.get_sync_meta(key) for key in before_meta})

    def test_budget_exhausted_during_scope_reconciliation_never_soft_deletes(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                baseline = FakeAzure([raw_item(1, state='Active'), raw_item(2, state='Active')])
                first = run_sync(baseline, force_full=True)
                self.assertEqual(first['status'], 'success')
                before = {key: sync_service.get_sync_meta(key)
                          for key in ('last_full_sync', 'watermark', 'last_success_at')}

                fake = FakeAzure([raw_item(1, state='Active')])
                result, client = configured_sync(fake, budget=2, chunked=chunked, workers=4)
                self.assertEqual(result['status'], 'partial')
                self.assertEqual(client.stats['requests'], 2)  # WIQL + main; reconciliation gets no attempt
                self.assertIsNone(next(r for r in rows() if r['id'] == 2)['deleted_at'])
                self.assertEqual(before, {key: sync_service.get_sync_meta(key) for key in before})
                self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '1')

    def test_budget_exhausted_during_hollow_reconciliation_marks_partial(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                first_fake = FakeAzure([raw_item(1, state='Active', children=[2]),
                                        raw_item(2, state='Closed', parent=1)])
                self.assertEqual(run_sync(first_fake, force_full=True)['status'], 'success')
                before = {key: sync_service.get_sync_meta(key)
                          for key in ('watermark', 'last_full_sync', 'last_success_at')}
                with sync_service.get_db_connection() as conn:
                    conn.execute('UPDATE work_items SET relations_json = NULL, last_seen_at = NULL WHERE id = 2')

                no_link_fake = FakeAzure([raw_item(1, state='Active'), raw_item(2, state='Closed')])
                result, client = configured_sync(no_link_fake, budget=2, chunked=chunked)
                self.assertEqual(result['status'], 'partial')
                self.assertEqual(client.stats['requests'], 2)
                self.assertIn('request_budget_reached:2', result['warnings'])
                self.assertEqual(before, {key: sync_service.get_sync_meta(key) for key in before})
                self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '1')

    def test_default_hollow_fetch_failure_preserves_legacy_completion_semantics(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                initial = FakeAzure([raw_item(1, state='Active', children=[2]),
                                     raw_item(2, state='Closed', parent=1)])
                self.assertEqual(run_sync(initial, force_full=True)['status'], 'success')
                with sync_service.get_db_connection() as conn:
                    conn.execute('UPDATE work_items SET relations_json = NULL, last_seen_at = NULL WHERE id = 2')

                fake = FakeAzure([raw_item(1, state='Active'), raw_item(2, state='Closed')])
                fake.fail_ids = {2}  # only the hollow refresh fails; reconciliation itself is isolated below
                client = azure_client.AzureClient('https://dev.azure.com/synthetic', 'synthetic',
                                                  sleep=lambda _: None, workers=4)
                env = {'SYNC_CONTEXT_POLICY': '', 'SYNC_CONTEXT_MAX_ITEMS': '',
                       'SYNC_CONTEXT_MAX_REQUESTS': '', 'SYNC_CHUNKED': '1' if chunked else '0'}
                with (mock.patch.dict(os.environ, env), fake.patch_all(),
                      mock.patch.object(sync_service, '_plan_reconciliation', return_value=([], [])),
                      mock.patch.object(sync_staging, '_plan_reconciliation', return_value=[])):
                    result = sync_service.sync_work_items('https://dev.azure.com/synthetic', 'synthetic',
                                                          force_full=True, client=client)
                self.assertEqual(result['status'], 'success')
                self.assertTrue(sync_service.get_sync_meta('last_full_sync'))
                self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '0')


class ConcurrentAttemptBudget(unittest.TestCase):
    def test_limits_at_and_one_below_batch_count_never_overrun_with_1_4_or_8_workers(self):
        ids = list(range(1, 2001))  # ten actual GET batches

        def response(url, headers=None, timeout=None):
            requested = [int(i) for i in url.split('ids=', 1)[1].split('&', 1)[0].split(',')]
            return FakeResponse(200, {'value': [{'id': i} for i in requested]})

        for workers in (1, 4, 8):
            for budget, expected_status in ((9, 'partial'), (10, 'success')):
                with self.subTest(workers=workers, budget=budget):
                    client = azure_client.AzureClient('https://dev.azure.com/synthetic', 'synthetic',
                                                      sleep=lambda _: None, workers=workers)
                    with mock.patch.object(azure_client.requests, 'get', side_effect=response):
                        with client.request_budget(budget):
                            result = client.get_items(ids, error_policy_omit=True)
                    self.assertLessEqual(client.stats['requests'], budget)
                    self.assertEqual(client.stats['requests'], budget)
                    self.assertEqual(bool(result.failed_batches), expected_status == 'partial')


if __name__ == '__main__':
    unittest.main()
