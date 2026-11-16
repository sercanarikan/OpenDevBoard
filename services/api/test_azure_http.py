"""The dashboard services share one pooled, cookie-less, GET-only Azure DevOps HTTP session."""
import unittest
from unittest.mock import patch

import requests

import azure_http


class AzureHttpTests(unittest.TestCase):
    def test_get_goes_through_the_shared_session_and_forwards_arguments(self):
        with patch.object(azure_http._session, 'get', return_value='response') as get:
            result = azure_http.get('https://dev.azure.com/org/_apis/projects', headers={'A': 'b'}, params={'x': 1}, timeout=7)
        self.assertEqual(result, 'response')
        get.assert_called_once_with('https://dev.azure.com/org/_apis/projects', headers={'A': 'b'}, params={'x': 1}, timeout=7)

    def test_module_exposes_only_get(self):
        self.assertTrue(callable(azure_http.get))
        for name in ('post', 'put', 'patch', 'delete', 'request'):
            self.assertFalse(hasattr(azure_http, name), name)

    def test_pool_is_sized_for_the_services_fan_out(self):
        adapter = azure_http._session.get_adapter('https://dev.azure.com/org')
        self.assertGreaterEqual(adapter._pool_maxsize, 20)
        self.assertEqual(adapter.max_retries.total, 0, 'retries stay disabled so requests exception types are unchanged')

    def test_cookies_are_never_stored(self):
        prepared = requests.Request('GET', 'https://dev.azure.com/org/_apis/projects').prepare()
        mock_request = requests.cookies.MockRequest(prepared)
        cookie = requests.cookies.create_cookie(name='session', value='secret', domain='dev.azure.com')
        policy = azure_http._session.cookies._policy
        self.assertFalse(policy.set_ok(cookie, mock_request))


if __name__ == '__main__':
    unittest.main()
