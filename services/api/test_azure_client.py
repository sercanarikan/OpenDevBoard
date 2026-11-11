import re
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

import requests

import azure_client
from azure_client import AzureClient, AzureError, BATCH_SIZE, WIQL_RESULT_LIMIT, quote_wiql

ORG = 'https://dev.azure.com/example'
PAT = 'SECRET-PAT-VALUE-123'


class FakeResponse:
    def __init__(self, status=200, body=None, headers=None, text=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = text if text is not None else ('' if body is None else str(body))

    def json(self):
        if self._body is None:
            raise ValueError('no body')
        return self._body


class FakeAzure:
    """In-memory WIQL + work item store. Records every call as (method, url)."""

    def __init__(self, ids, total_limit=WIQL_RESULT_LIMIT):
        self.ids = sorted(ids)
        self.total_limit = total_limit
        self.calls = []

    def post(self, url, headers=None, json=None, timeout=None):
        self.calls.append(('POST', url))
        query = json['query']
        qs = parse_qs(urlparse(url).query)
        top = int(qs['$top'][0]) if '$top' in qs else None
        lo, hi = 0, float('inf')
        m = re.search(r'\[System\.Id\] >= (\d+)', query)
        if m:
            lo = int(m.group(1))
        m = re.search(r'\[System\.Id\] < (\d+)', query)
        if m:
            hi = int(m.group(1))
        matching = [i for i in self.ids if lo <= i < hi]
        if 'ORDER BY [System.Id] DESC' in query:
            matching = list(reversed(matching))
        if top is not None:
            matching = matching[:top]
        elif len(matching) > self.total_limit:
            return FakeResponse(400, text='{"message": "VS402337: query exceeds the size limit"}')
        return FakeResponse(200, {'workItems': [{'id': i} for i in matching]})

    def get(self, url, headers=None, timeout=None):
        self.calls.append(('GET', url))
        qs = parse_qs(urlparse(url).query)
        ids = [int(x) for x in qs['ids'][0].split(',')]
        omit = 'errorPolicy' in qs
        known = set(self.ids)
        value = [{'id': i} if i in known else None for i in ids]
        if not omit:
            value = [v for v in value if v is not None]
        return FakeResponse(200, {'value': value})


class RetryTests(unittest.TestCase):
    def setUp(self):
        self.sleeps = []
        self.client = AzureClient(ORG, PAT, sleep=lambda s: self.sleeps.append(s), max_retries=3)

    def test_429_with_retry_after_then_success(self):
        responses = [
            FakeResponse(429, headers={'Retry-After': '7'}, text='slow down'),
            FakeResponse(200, {'value': []}),
        ]
        with mock.patch.object(azure_client.requests, 'get', side_effect=responses) as get:
            resp = self.client._request('GET', f'{ORG}/_apis/wit/workitems?ids=1')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(self.sleeps, [7.0])
        self.assertEqual(self.client.stats['retries'], 1)

    def test_retry_after_is_capped(self):
        responses = [FakeResponse(503, headers={'Retry-After': '999'}), FakeResponse(200, {})]
        with mock.patch.object(azure_client.requests, 'get', side_effect=responses):
            self.client._request('GET', f'{ORG}/x')
        self.assertEqual(self.sleeps, [30.0])

    def test_backoff_without_retry_after(self):
        responses = [FakeResponse(502), FakeResponse(504), FakeResponse(503), FakeResponse(200, {})]
        with mock.patch.object(azure_client.requests, 'get', side_effect=responses):
            self.client._request('GET', f'{ORG}/x')
        self.assertEqual(self.sleeps, [1.0, 2.0, 4.0])

    def test_503_retry_exhaustion_raises_retryable(self):
        responses = [FakeResponse(503, text='unavailable')] * 4
        with mock.patch.object(azure_client.requests, 'get', side_effect=responses) as get:
            with self.assertRaises(AzureError) as cm:
                self.client._request('GET', f'{ORG}/x')
        self.assertEqual(get.call_count, 4)
        self.assertEqual(cm.exception.status, 503)
        self.assertTrue(cm.exception.retryable)

    def test_connection_error_retries_then_raises(self):
        err = requests.ConnectionError('boom')
        with mock.patch.object(azure_client.requests, 'get', side_effect=err):
            with self.assertRaises(AzureError) as cm:
                self.client._request('GET', f'{ORG}/x')
        self.assertTrue(cm.exception.retryable)
        self.assertEqual(self.client.stats['retries'], 3)

    def test_401_and_404_are_not_retried(self):
        for status in (401, 404):
            self.sleeps.clear()
            with mock.patch.object(azure_client.requests, 'get',
                                   return_value=FakeResponse(status, text='nope')) as get:
                with self.assertRaises(AzureError) as cm:
                    self.client._request('GET', f'{ORG}/x')
            self.assertEqual(get.call_count, 1)
            self.assertEqual(self.sleeps, [])
            self.assertEqual(cm.exception.status, status)
            self.assertFalse(cm.exception.retryable)

    def test_error_body_snippet_is_truncated(self):
        with mock.patch.object(azure_client.requests, 'get',
                               return_value=FakeResponse(404, text='x' * 1000)):
            with self.assertRaises(AzureError) as cm:
                self.client._request('GET', f'{ORG}/x')
        self.assertLessEqual(len(str(cm.exception)), 300)

    def test_pat_never_leaks_into_exceptions(self):
        errors = [
            requests.ConnectionError('conn'),
            requests.Timeout('slow'),
        ]
        for err in errors:
            with mock.patch.object(azure_client.requests, 'get', side_effect=err):
                with self.assertRaises(AzureError) as cm:
                    self.client._request('GET', f'{ORG}/x')
            self.assertNotIn(PAT, str(cm.exception))
            self.assertNotIn(PAT, repr(cm.exception))
        with mock.patch.object(azure_client.requests, 'get', return_value=FakeResponse(401, text='no')):
            with self.assertRaises(AzureError) as cm:
                self.client._request('GET', f'{ORG}/x')
        self.assertNotIn(PAT, str(cm.exception))
        self.assertNotIn(PAT, repr(cm.exception))

    def test_rejects_non_permitted_methods(self):
        for method in ('PATCH', 'PUT', 'DELETE'):
            with mock.patch.object(azure_client.requests, 'get') as get, \
                    mock.patch.object(azure_client.requests, 'post') as post:
                with self.assertRaises(ValueError):
                    self.client._request(method, f'{ORG}/_apis/wit/workitems/1')
            get.assert_not_called()
            post.assert_not_called()

    def test_rejects_post_to_non_wiql_endpoint(self):
        with mock.patch.object(azure_client.requests, 'post') as post:
            with self.assertRaises(ValueError):
                self.client._request('POST', f'{ORG}/_apis/wit/workitems?api-version=7.1', json={})
        post.assert_not_called()


class WiqlTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeAzure(range(1, 45001))
        self.client = AzureClient(ORG, PAT, sleep=lambda s: None)

    def _run(self, fake_obj, fn):
        with mock.patch.object(azure_client.requests, 'post', side_effect=fake_obj.post), \
                mock.patch.object(azure_client.requests, 'get', side_effect=fake_obj.get):
            return fn()

    def test_wiql_ids_returns_ids_in_order(self):
        fake = FakeAzure([5, 3, 9])
        result = self._run(fake, lambda: self.client.wiql_ids('[System.TeamProject] = \'P\''))
        self.assertEqual(result, [3, 5, 9])

    def test_top_parameter_is_sent(self):
        fake = FakeAzure(range(1, 11))
        result = self._run(fake, lambda: self.client.wiql_ids('1=1', order_by='[System.Id] DESC', top=1))
        self.assertEqual(result, [10])
        self.assertIn('$top=1', fake.calls[0][1])

    def test_size_limit_sets_flag(self):
        with mock.patch.object(azure_client.requests, 'post',
                               return_value=FakeResponse(400, text='VS402337 size limit')):
            with self.assertRaises(AzureError) as cm:
                self.client.wiql_ids('1=1')
        self.assertEqual(cm.exception.status, 400)
        self.assertTrue(cm.exception.size_limit)

    def test_collect_ids_partitions_45000_without_duplicates(self):
        result = self._run(self.fake, lambda: self.client.collect_ids("[System.TeamProject] = 'P'"))
        self.assertTrue(result.partitioned)
        self.assertGreater(result.partitions, 1)
        self.assertEqual(result.ids, list(range(1, 45001)))
        self.assertEqual(len(result.ids), len(set(result.ids)))
        self.assertGreater(result.queries, result.partitions)

    def test_collect_ids_plain_when_small(self):
        fake = FakeAzure(range(1, 101))
        result = self._run(fake, lambda: self.client.collect_ids('1=1'))
        self.assertFalse(result.partitioned)
        self.assertEqual(result.partitions, 1)
        self.assertEqual(result.ids, list(range(1, 101)))

    def test_exactly_limit_is_treated_as_possibly_truncated(self):
        fake = FakeAzure(range(1, WIQL_RESULT_LIMIT + 1))
        result = self._run(fake, lambda: self.client.collect_ids('1=1'))
        self.assertTrue(result.partitioned)
        self.assertEqual(result.ids, list(range(1, WIQL_RESULT_LIMIT + 1)))

    def test_collect_ids_empty(self):
        fake = FakeAzure([])
        result = self._run(fake, lambda: self.client.collect_ids('1=1'))
        self.assertEqual(result.ids, [])
        self.assertFalse(result.partitioned)

    def test_non_size_limit_error_propagates(self):
        with mock.patch.object(azure_client.requests, 'post',
                               return_value=FakeResponse(400, text='bad WIQL syntax')):
            with self.assertRaises(AzureError):
                self.client.collect_ids('bogus')

    def test_quote_wiql_doubles_single_quotes(self):
        self.assertEqual(quote_wiql("O'Brien's Project"), "O''Brien''s Project")


class ItemsTests(unittest.TestCase):
    def setUp(self):
        self.client = AzureClient(ORG, PAT, sleep=lambda s: None)

    def test_batching_450_ids_into_three_calls(self):
        ids = list(range(1, 451))
        fake = FakeAzure(ids)
        with mock.patch.object(azure_client.requests, 'get', side_effect=fake.get):
            result = self.client.get_items(ids)
        sizes = [len(parse_qs(urlparse(u).query)['ids'][0].split(',')) for _, u in fake.calls]
        self.assertEqual(sizes, [BATCH_SIZE, BATCH_SIZE, 50])
        self.assertEqual(result.batches, 3)
        self.assertEqual(len(result.items), 450)
        self.assertEqual(result.missing, [])

    def test_dedupes_requested_ids_preserving_order(self):
        fake = FakeAzure([1, 2, 3])
        with mock.patch.object(azure_client.requests, 'get', side_effect=fake.get):
            result = self.client.get_items([3, 1, 3, 2, 1])
        self.assertEqual(len(fake.calls), 1)
        self.assertIn('ids=3,1,2', fake.calls[0][1])
        self.assertEqual(sorted(result.items), [1, 2, 3])

    def test_error_policy_omit_none_entries_reported_missing(self):
        def fake_get(url, headers=None, timeout=None):
            return FakeResponse(200, {'value': [{'id': 1}, None, {'id': 3}, None]})
        with mock.patch.object(azure_client.requests, 'get', side_effect=fake_get) as get:
            result = self.client.get_items([1, 2, 3, 4], error_policy_omit=True)
        self.assertIn('errorPolicy=omit', get.call_args.args[0])
        self.assertEqual(sorted(result.items), [1, 3])
        self.assertEqual(result.missing, [2, 4])

    def test_failed_middle_batch_does_not_abort_others(self):
        ids = list(range(1, 601))
        ok = FakeAzure(ids)
        calls = {'n': 0}

        def fake_get(url, headers=None, timeout=None):
            calls['n'] += 1
            if calls['n'] == 2:
                return FakeResponse(404, text='gone')
            return ok.get(url)

        with mock.patch.object(azure_client.requests, 'get', side_effect=fake_get):
            result = self.client.get_items(ids)
        self.assertEqual(result.batches, 3)
        self.assertEqual(len(result.failed_batches), 1)
        self.assertEqual(result.failed_batches[0], list(range(201, 401)))
        self.assertEqual(len(result.errors), 1)
        self.assertEqual(len(result.items), 400)
        self.assertEqual(result.missing, [])

    def test_raise_on_error_reraises(self):
        with mock.patch.object(azure_client.requests, 'get', return_value=FakeResponse(401, text='no')):
            with self.assertRaises(AzureError):
                self.client.get_items([1], raise_on_error=True)

    def test_expand_relations_never_sends_fields(self):
        fake = FakeAzure([1, 2])
        with mock.patch.object(azure_client.requests, 'get', side_effect=fake.get):
            self.client.get_items([1, 2], expand_relations=True, fields=['System.Title'])
        url = fake.calls[0][1]
        self.assertIn('$expand=relations', url)
        self.assertNotIn('fields=', url)

    def test_fields_sent_without_expand(self):
        fake = FakeAzure([1])
        with mock.patch.object(azure_client.requests, 'get', side_effect=fake.get):
            self.client.get_items([1], expand_relations=False, fields=['System.Title', 'System.State'])
        url = fake.calls[0][1]
        self.assertIn('fields=System.Title,System.State', url)
        self.assertNotIn('$expand', url)

    def test_only_get_and_wiql_post_are_issued(self):
        fake = FakeAzure(range(1, 45001))
        with mock.patch.object(azure_client.requests, 'post', side_effect=fake.post), \
                mock.patch.object(azure_client.requests, 'get', side_effect=fake.get), \
                mock.patch.object(azure_client.requests, 'put') as put, \
                mock.patch.object(azure_client.requests, 'patch') as patch, \
                mock.patch.object(azure_client.requests, 'delete') as delete:
            client = AzureClient(ORG, PAT, sleep=lambda s: None)
            client.collect_ids('1=1')
            client.get_items(list(range(1, 301)))
        put.assert_not_called()
        patch.assert_not_called()
        delete.assert_not_called()
        self.assertTrue(fake.calls)
        for method, url in fake.calls:
            self.assertIn(method, ('GET', 'POST'))
            if method == 'POST':
                self.assertIn('/_apis/wit/wiql', url)


class QuoteTests(unittest.TestCase):
    def test_quote_wiql(self):
        self.assertEqual(quote_wiql('a'), 'a')
        self.assertEqual(quote_wiql("it's"), "it''s")


if __name__ == '__main__':
    unittest.main()
