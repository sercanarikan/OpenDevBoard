import threading
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

import azure_client
from azure_client import AzureClient, BATCH_SIZE
from test_azure_client import FakeAzure, FakeResponse, ORG, PAT


def _client(workers, sleeps=None):
    return AzureClient(ORG, PAT, sleep=(lambda s: sleeps.append(s)) if sleeps is not None else (lambda s: None),
                       workers=workers)


class ParallelDetailTests(unittest.TestCase):
    def test_result_is_identical_to_the_sequential_result(self):
        ids = list(range(1, 1301))
        results = []
        for workers in (1, 4):
            fake = FakeAzure(ids[:-7])  # the last 7 ids do not exist -> reported missing
            with mock.patch.object(azure_client.requests, 'get', side_effect=fake.get):
                r = _client(workers).get_items(ids, error_policy_omit=True)
            results.append((list(r.items), r.missing, r.batches, r.failed_batches, r.errors))
        self.assertEqual(results[0], results[1])

    def test_concurrency_is_bounded_by_workers(self):
        fake = FakeAzure(range(1, 2001))
        lock, state = threading.Lock(), {'now': 0, 'peak': 0}

        def slow_get(url, headers=None, timeout=None):
            with lock:
                state['now'] += 1
                state['peak'] = max(state['peak'], state['now'])
            time.sleep(0.02)
            try:
                return fake.get(url, headers=headers, timeout=timeout)
            finally:
                with lock:
                    state['now'] -= 1

        with mock.patch.object(azure_client.requests, 'get', side_effect=slow_get):
            r = _client(3).get_items(range(1, 2001))
        self.assertEqual(len(r.items), 2000)
        self.assertLessEqual(state['peak'], 3)
        self.assertGreater(state['peak'], 1)

    def test_only_get_is_used_for_details(self):
        fake = FakeAzure(range(1, 801))
        with mock.patch.object(azure_client.requests, 'get', side_effect=fake.get), \
                mock.patch.object(azure_client.requests, 'post') as post:
            _client(4).get_items(range(1, 801))
        post.assert_not_called()
        self.assertTrue(all(method == 'GET' for method, _ in fake.calls))

    def test_failed_batch_is_reported_with_its_ids_and_the_rest_is_kept(self):
        fake = FakeAzure(range(1, 801))
        bad = '1,2,3'

        def get(url, headers=None, timeout=None):
            if parse_qs(urlparse(url).query)['ids'][0].startswith(bad):
                return FakeResponse(401, text='no')
            return fake.get(url, headers=headers, timeout=timeout)

        with mock.patch.object(azure_client.requests, 'get', side_effect=get):
            r = _client(4).get_items(range(1, 801))
        self.assertEqual(len(r.failed_batches), 1)
        self.assertEqual(r.failed_batches[0][0], 1)
        self.assertEqual(len(r.items), 800 - BATCH_SIZE)
        self.assertTrue(r.errors[0].startswith('batch 1:'))

    def test_429_pauses_all_workers_for_retry_after_and_shrinks_concurrency(self):
        fake = FakeAzure(range(1, 1601))
        sleeps, first = [], {'done': False}

        def get(url, headers=None, timeout=None):
            if not first['done']:
                first['done'] = True
                return FakeResponse(429, headers={'Retry-After': '0.05'}, text='slow down')
            return fake.get(url, headers=headers, timeout=timeout)

        client = _client(4, sleeps)
        with mock.patch.object(azure_client.requests, 'get', side_effect=get):
            r = client.get_items(range(1, 1601))
        self.assertEqual(len(r.items), 1600)
        self.assertFalse(r.failed_batches)
        self.assertIn(0.05, sleeps)  # Retry-After honoured, not the exponential default
        self.assertEqual(client.stats['throttled'], 1)
        self.assertEqual(client.stats['retries'], 1)
        self.assertIsNone(client._limiter)  # fan-out state is cleared afterwards

    def test_a_burst_of_429s_shrinks_the_concurrency_once(self):
        limiter = azure_client._Limiter(8)
        t0 = time.monotonic()
        limiter.shrink(t0)
        limiter.shrink(t0)      # started before the first shrink: same overload, ignored
        limiter.shrink(t0)
        self.assertEqual(limiter.limit, 4)
        limiter.shrink(time.monotonic() + 1)   # a request that started after it and was throttled again
        self.assertEqual(limiter.limit, 2)

    def test_exhausted_429_retries_fail_the_batch_instead_of_hanging(self):
        def get(url, headers=None, timeout=None):
            return FakeResponse(429, headers={'Retry-After': '0.01'}, text='no')

        with mock.patch.object(azure_client.requests, 'get', side_effect=get):
            r = _client(4).get_items(range(1, 601))
        self.assertEqual(len(r.failed_batches), 3)
        self.assertEqual(r.items, {})

    def test_context_request_budget_counts_retries_and_never_exceeds_attempt_limit(self):
        for status in (429, 503):
            with self.subTest(status=status):
                def get(url, headers=None, timeout=None):
                    return FakeResponse(status, headers={'Retry-After': '0'}, text='temporary')

                client = _client(4)
                with mock.patch.object(azure_client.requests, 'get', side_effect=get):
                    with client.request_budget(1):
                        result = client.get_items(range(1, 201))
                self.assertEqual(client.stats['requests'], 1)
                self.assertEqual(len(result.failed_batches), 1)
                self.assertIn('http_attempt_budget_exhausted', result.errors[0])

    def test_default_is_sequential(self):
        with mock.patch.dict('os.environ', clear=False) as env:
            env.pop('SYNC_DETAIL_WORKERS', None)
            self.assertEqual(AzureClient(ORG, PAT)._workers, 1)
        self.assertEqual(azure_client.DEFAULT_DETAIL_WORKERS, 1)


class WorkerCountTests(unittest.TestCase):
    def test_valid_values_are_kept(self):
        for raw, want in ((1, 1), ('1', 1), ('4', 4), (' 4 ', 4), (8, 8), (4.0, 4)):
            self.assertEqual(azure_client.normalize_workers(raw), want, raw)

    def test_unset_or_empty_gives_the_default(self):
        for raw in (None, '', '   '):
            self.assertEqual(azure_client.normalize_workers(raw), 1)

    def test_invalid_zero_and_negative_fall_back_to_sequential(self):
        for raw in ('abc', '0', 0, '-3', -1, '4.5', 4.5, 'four', '1e1', True, False, [], {}):
            with self.assertLogs('azure_client', level='WARNING'):
                self.assertEqual(azure_client.normalize_workers(raw), 1, raw)

    def test_excessive_values_are_clamped(self):
        for raw in ('9', 9, '1000', 10 ** 9):
            with self.assertLogs('azure_client', level='WARNING'):
                self.assertEqual(azure_client.normalize_workers(raw), azure_client.MAX_DETAIL_WORKERS, raw)

    def test_environment_variable_is_read_per_client_and_never_raises(self):
        for raw, want in (('4', 4), ('nope', 1), ('0', 1), ('-2', 1), ('64', azure_client.MAX_DETAIL_WORKERS), ('', 1)):
            with mock.patch.dict('os.environ', {'SYNC_DETAIL_WORKERS': raw}):
                self.assertEqual(AzureClient(ORG, PAT)._workers, want, raw)

    def test_constructor_argument_wins_over_the_environment_and_is_normalised(self):
        with mock.patch.dict('os.environ', {'SYNC_DETAIL_WORKERS': '8'}):
            self.assertEqual(AzureClient(ORG, PAT, workers=2)._workers, 2)
            self.assertEqual(AzureClient(ORG, PAT, workers=-5)._workers, 1)


class OrderingAndFailureParityTests(unittest.TestCase):
    """Whatever order the workers finish in, the FetchResult must equal the sequential one."""

    def _run(self, workers, ids, known, bad_prefixes, jitter):
        import random
        rnd = random.Random(7)
        fake = FakeAzure(known)

        def get(url, headers=None, timeout=None):
            ids_param = parse_qs(urlparse(url).query)['ids'][0]
            if jitter:
                time.sleep(rnd.random() * 0.01)
            if any(ids_param.startswith(p) for p in bad_prefixes):
                return FakeResponse(401, text='denied')
            return fake.get(url, headers=headers, timeout=timeout)

        with mock.patch.object(azure_client.requests, 'get', side_effect=get):
            r = _client(workers).get_items(ids, error_policy_omit=True)
        return (list(r.items), r.missing, r.batches, r.failed_batches, r.errors)

    def test_missing_failed_batches_and_errors_match_sequential(self):
        ids = list(range(1, 2201))
        known = [i for i in ids if i % 11]           # every 11th id does not exist -> missing
        bad = (str(ids[200]), str(ids[1000]))        # two batches (2 and 6) answer 401
        seq = self._run(1, ids, known, bad, jitter=False)
        for workers in (2, 4, 8):
            for _ in range(3):
                self.assertEqual(self._run(workers, ids, known, bad, jitter=True), seq)
        self.assertEqual(len(seq[3]), 2)
        self.assertTrue(seq[4][0].startswith('batch 2:') and seq[4][1].startswith('batch 6:'))


class FanOutSafetyTests(unittest.TestCase):
    def test_no_threads_left_behind(self):
        fake = FakeAzure(range(1, 2001))
        before = {t.name for t in threading.enumerate()}
        with mock.patch.object(azure_client.requests, 'get', side_effect=fake.get):
            for _ in range(3):
                _client(8).get_items(range(1, 2001))
        leftover = [t.name for t in threading.enumerate() if t.name not in before]
        self.assertEqual(leftover, [])

    def test_unexpected_error_stops_queued_batches_and_propagates(self):
        calls = []

        def get(url, headers=None, timeout=None):
            calls.append(url)
            if len(calls) == 1:
                raise ValueError('boom')   # not an AzureError / requests transport error
            time.sleep(0.02)
            return FakeResponse(200, {'value': []})

        client = _client(2)
        with mock.patch.object(azure_client.requests, 'get', side_effect=get):
            with self.assertRaises(ValueError):
                client.get_items(range(1, 200 * 40 + 1))   # 40 batches
        self.assertLess(len(calls), 40)                 # the queued tail was cancelled, not run
        self.assertIsNone(client._limiter)
        self.assertFalse(client._fanout_lock.locked())

    def test_gate_is_set_by_429_and_by_retry_after_but_not_by_plain_5xx(self):
        for status, headers, expect_gate in ((429, {}, True), (503, {'Retry-After': '0.01'}, True), (503, {}, False), (502, {}, False)):
            fake = FakeAzure(range(1, 801))
            first = {'done': False}

            def get(url, headers_=None, timeout=None, headers=None, _s=status, _h=headers, _f=first):
                if not _f['done']:
                    _f['done'] = True
                    return FakeResponse(_s, headers=_h, text='x')
                return fake.get(url, headers=headers, timeout=timeout)

            client = _client(4)
            with mock.patch.object(azure_client.requests, 'get', side_effect=get):
                r = client.get_items(range(1, 801))
            self.assertEqual(len(r.items), 800, (status, headers))
            self.assertEqual(client.stats['throttled'], 1 if expect_gate else 0, (status, headers))

    def test_retries_queue_behind_the_shrunk_cap_so_a_server_limit_never_fails_a_batch(self):
        # Server accepts 2 concurrent requests and answers 429 above that. 8 workers start at once; every throttled
        # batch must still be delivered (the retry budget is not burnt by our own over-concurrency).
        fake = FakeAzure(range(1, 3201))
        lock, state = threading.Lock(), {'now': 0, 'over': 0}

        def get(url, headers=None, timeout=None):
            with lock:
                state['now'] += 1
                too_many = state['now'] > 2
            try:
                time.sleep(0.01)
                if too_many:
                    state['over'] += 1
                    return FakeResponse(429, headers={'Retry-After': '0.01'}, text='slow down')
                return fake.get(url, headers=headers, timeout=timeout)
            finally:
                with lock:
                    state['now'] -= 1

        client = AzureClient(ORG, PAT, sleep=lambda s: time.sleep(min(s, 0.01)), workers=8)
        with mock.patch.object(azure_client.requests, 'get', side_effect=get):
            r = client.get_items(range(1, 3201))
        self.assertEqual(r.failed_batches, [])
        self.assertEqual(len(r.items), 3200)
        self.assertGreater(state['over'], 0)    # the scenario really did throttle

    def test_http_500_is_not_retried_and_fails_its_batch_the_same_way_at_any_worker_count(self):
        outcomes = []
        for workers in (1, 4):
            fake = FakeAzure(range(1, 801))
            sleeps = []

            def get(url, headers=None, timeout=None, _f=fake):
                if parse_qs(urlparse(url).query)['ids'][0].startswith('201,'):
                    return FakeResponse(500, text='boom')
                return _f.get(url, headers=headers, timeout=timeout)

            client = _client(workers, sleeps)
            with mock.patch.object(azure_client.requests, 'get', side_effect=get):
                r = client.get_items(range(1, 801))
            outcomes.append((list(r.items), r.failed_batches, r.errors, client.stats['retries'], sleeps))
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(outcomes[0][3], 0)

    def test_a_second_concurrent_get_items_runs_sequentially_without_touching_the_limiter(self):
        fake = FakeAzure(range(1, 1601))
        gate_in, gate_out = threading.Event(), threading.Event()

        def slow_get(url, headers=None, timeout=None):
            gate_in.set()
            gate_out.wait(2)
            return fake.get(url, headers=headers, timeout=timeout)

        client = _client(4)
        first = {}
        with mock.patch.object(azure_client.requests, 'get', side_effect=slow_get):
            th = threading.Thread(target=lambda: first.update(r=client.get_items(range(1, 1601))))
            th.start()
            gate_in.wait(2)
            limiter = client._limiter
            self.assertIsNotNone(limiter)
            gate_out.set()
            second = client.get_items(range(1, 401))   # while the first fan-out may still hold the lock
            th.join()
        self.assertEqual(len(second.items), 400)
        self.assertEqual(len(first['r'].items), 1600)
        self.assertIsNone(client._limiter)

    def test_request_statistics_are_exact_under_concurrency(self):
        fake = FakeAzure(range(1, 4001))
        client = _client(8)
        with mock.patch.object(azure_client.requests, 'get', side_effect=fake.get):
            client.get_items(range(1, 4001))
        self.assertEqual(client.stats['requests'], 20)
        self.assertEqual(client.stats['batches'], 20)
        self.assertEqual(client.stats['retries'], 0)

    def test_only_read_only_http_is_possible_in_the_fan_out(self):
        client = _client(4)
        for verb in ('put', 'patch', 'delete'):
            with mock.patch.object(azure_client.requests, verb) as m:
                with self.assertRaises(ValueError):
                    client._request(verb.upper(), f'{ORG}/_apis/wit/workitems')
                m.assert_not_called()


if __name__ == '__main__':
    unittest.main()
