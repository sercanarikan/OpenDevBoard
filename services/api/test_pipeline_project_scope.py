"""Synthetic coverage for project-scoped Azure Build discovery."""
import os
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlparse

import pipeline_service
import sync_service


class Response:
    def __init__(self, values, status=200, token=None):
        self.status_code = status
        self.headers = {'x-ms-continuationtoken': token} if token else {}
        self.values = values

    def json(self):
        return {'value': self.values}


class PipelineProjectScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db = patch.object(sync_service, 'DB_PATH', os.path.join(self.temp.name, 'synthetic.db'))
        self.db.start()
        pipeline_service.init_pipeline_db()
        with sync_service.get_db_connection() as conn:
            conn.execute('CREATE TABLE work_items (id INTEGER, project TEXT, deleted_at TEXT)')
            conn.execute("INSERT INTO work_items (project, deleted_at) VALUES ('Alpha', NULL)")
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.db.stop)

    def test_azure_inventory_and_build_continuations_include_project_without_work_items(self):
        calls = []
        def fetch(url, *, headers, params, timeout):
            path = urlparse(url).path
            calls.append((path, dict(params)))
            token = params.get('continuationToken')
            if path.endswith('/_apis/projects'):
                return Response([{'name': 'Beta'}] if token else [{'name': 'Alpha'}], token=None if token else 'projects-next')
            if path.endswith('/Alpha/_apis/build/builds'):
                return Response([{'id': 1, 'project': {'name': 'Alpha'}}])
            if path.endswith('/Beta/_apis/build/builds'):
                return Response([{'id': 3, 'project': {'name': 'Beta'}}] if token else [{'id': 2, 'project': {'name': 'Beta'}}], token=None if token else 'build-next')
            raise AssertionError('unexpected synthetic endpoint')
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True)
        self.assertEqual({x['id'] for x in result['items']}, {1, 2, 3})
        self.assertFalse(any(p == '/org/_apis/build/builds' for p, _ in calls))
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')
        self.assertTrue(result['cacheStatus']['projectDiscoveryComplete'])
        self.assertEqual(len([p for p, _ in calls if p.endswith('/Beta/_apis/build/builds')]), 2)

    def _scoped_fetch(self, fail_beta=False):
        calls = []
        queued = pipeline_service._utcnow().isoformat(timespec='seconds') + 'Z'
        def fetch(url, *, headers, params, timeout):
            path = urlparse(url).path
            calls.append(path)
            if path.endswith('/_apis/projects'):
                return Response([{'name': 'Alpha'}, {'name': 'Beta'}])
            if path.endswith('/Alpha/_apis/build/builds'):
                return Response([{'id': 1, 'project': {'name': 'Alpha'}, 'queueTime': queued}])
            if path.endswith('/Beta/_apis/build/builds'):
                return Response([], status=500) if fail_beta else Response([{'id': 2, 'project': {'name': 'Beta'}, 'queueTime': queued}])
            raise AssertionError('unexpected synthetic endpoint')
        return calls, fetch

    def test_successful_project_scoped_read_stays_partial_but_is_served_from_the_ttl_cache(self):
        calls, fetch = self._scoped_fetch()
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            first = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', include_cache_status=True)
            after_first = len(calls)
            second = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', include_cache_status=True)
            forced = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True)
        self.assertEqual(after_first, 3)
        self.assertEqual({x['id'] for x in first['items']}, {1, 2})
        self.assertEqual(first['cacheStatus']['outcome'], 'partial')
        self.assertFalse(first['cacheStatus']['organizationSnapshotComplete'])
        self.assertEqual({x['id'] for x in second['items']}, {1, 2})
        self.assertEqual(second['cacheStatus']['outcome'], 'partial')
        self.assertFalse(second['cacheStatus']['stale'])
        self.assertFalse(second['cacheStatus']['complete'])
        self.assertEqual(len(calls), after_first + 3, 'only the forced refresh may call Azure DevOps again')
        self.assertEqual(forced['cacheStatus']['outcome'], 'partial')

    def test_project_scoped_read_with_a_failed_project_is_not_cached(self):
        calls, fetch = self._scoped_fetch(fail_beta=True)
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            first = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', include_cache_status=True)
            after_first = len(calls)
            pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', include_cache_status=True)
        self.assertEqual(first['cacheStatus']['outcome'], 'partial')
        self.assertEqual(first['cacheStatus']['successfulProjects'], ['Alpha'])
        self.assertGreater(len(calls), after_first, 'a read with a failed project must be retried on the next request')

    def test_incomplete_project_inventory_does_not_claim_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                if params.get('continuationToken'):
                    return Response([], status=403)
                return Response([{'name': 'Alpha'}], token='next')
            return Response([])
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True, project_scoped=True)
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')
        self.assertFalse(result['cacheStatus']['projectDiscoveryComplete'])
        self.assertFalse(result['cacheStatus']['complete'])

    def test_more_than_25_projects_are_scanned_without_claiming_organization_completeness(self):
        names = [f'Project-{i}' for i in range(26)]
        calls = []
        def fetch(url, *, headers, params, timeout):
            path = urlparse(url).path
            if path.endswith('/_apis/projects'):
                return Response([{'name': name} for name in names])
            calls.append(path)
            return Response([])
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True, project_scoped=True)
        self.assertEqual(len(calls), 26)
        self.assertTrue(result['cacheStatus']['projectDiscoveryComplete'])
        self.assertFalse(result['cacheStatus']['organizationSnapshotComplete'])
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')

    def test_build_pagination_failure_is_partial(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                return Response([{'name': 'Alpha'}, {'name': 'Beta'}])
            if '/Alpha/' in url:
                return Response([])
            return Response([{'id': 1, 'project': {'name': 'Beta'}}], token='repeat')
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True, project_scoped=True)
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')
        self.assertFalse(result['cacheStatus']['complete'])
        self.assertEqual(result['cacheStatus']['successfulProjects'], ['Alpha'])

    def test_full_project_page_without_continuation_is_not_certified_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                return Response([{'name': f'Project-{i}'} for i in range(100)])
            return Response([])
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True)
        self.assertFalse(result['cacheStatus']['projectDiscoveryComplete'])
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')

    def test_full_build_page_without_continuation_is_not_certified_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                return Response([{'name': 'Alpha'}, {'name': 'Beta'}])
            if '/Alpha/' in url:
                return Response([])
            return Response([{'id': i, 'project': {'name': 'Beta'}} for i in range(pipeline_service.BUILD_PAGE_SIZE)])
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True)
        self.assertEqual(result['cacheStatus']['successfulProjects'], ['Alpha'])
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')

    def test_live_api_uses_project_scoped_mode(self):
        import app as api_app
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                patch.object(api_app, 'get_devops_org_url', return_value='https://dev.azure.com/org'), \
                patch.object(api_app, 'get_devops_pat', return_value='synthetic'), \
                patch.object(pipeline_service, 'sync_live_pipeline_runs', return_value={}) as sync:
            api_app._load_all_pipelines(days=7, force_refresh=True)
        sync.assert_called_once_with('https://dev.azure.com/org', 'synthetic', days=7, force_refresh=True, include_cache_status=True, project_scoped=True)


class AccessibleScopeCompletenessTests(unittest.TestCase):
    """accessibleScopeComplete separates a finished accessible-project read from an unfinished one.

    `outcome` and `organizationSnapshotComplete` keep their organization-wide meaning (covered above).
    """
    setUp = PipelineProjectScopeTests.setUp
    _scoped_fetch = PipelineProjectScopeTests._scoped_fetch

    def _sync(self, fetch, **kwargs):
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.azure_http, 'get', side_effect=fetch):
            return pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', include_cache_status=True, **kwargs)

    def test_finished_read_is_accessible_scope_complete_and_stays_so_from_the_cache(self):
        calls, fetch = self._scoped_fetch()
        first = self._sync(fetch)
        second = self._sync(fetch)
        self.assertEqual(len(calls), 3, 'second read must be served from the cache')
        for result in (first, second):
            status = result['cacheStatus']
            self.assertTrue(status['accessibleScopeComplete'])
            self.assertTrue(status['projectDiscoveryComplete'])
            self.assertFalse(status['organizationSnapshotComplete'])
            self.assertEqual(status['outcome'], 'partial')
            self.assertFalse(status['stale'])
            self.assertEqual({x['id'] for x in result['items']}, {1, 2})

    def test_successful_empty_result_is_complete_and_has_no_rows(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                return Response([{'name': 'Alpha'}, {'name': 'Beta'}])
            return Response([])
        result = self._sync(fetch, force_refresh=True)
        self.assertEqual(result['items'], [])
        self.assertTrue(result['cacheStatus']['accessibleScopeComplete'])
        self.assertFalse(result['cacheStatus']['stale'])

    def test_failed_project_query_is_not_accessible_scope_complete(self):
        _, fetch = self._scoped_fetch(fail_beta=True)
        status = self._sync(fetch)['cacheStatus']
        self.assertFalse(status['accessibleScopeComplete'])
        self.assertEqual(status['successfulProjects'], ['Alpha'])

    def test_unreadable_project_inventory_is_not_accessible_scope_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                return Response([], status=401)
            return Response([])
        status = self._sync(fetch, force_refresh=True)['cacheStatus']
        self.assertFalse(status['accessibleScopeComplete'])
        self.assertFalse(status['projectDiscoveryComplete'])

    def test_incomplete_inventory_pagination_is_not_accessible_scope_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                if params.get('continuationToken'):
                    return Response([], status=403)
                return Response([{'name': 'Alpha'}], token='next')
            return Response([])
        self.assertFalse(self._sync(fetch, force_refresh=True)['cacheStatus']['accessibleScopeComplete'])

    def test_unfinished_build_pagination_is_not_accessible_scope_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                return Response([{'name': 'Alpha'}, {'name': 'Beta'}])
            if '/Alpha/' in url:
                return Response([])
            return Response([{'id': 1, 'project': {'name': 'Beta'}}], token='repeat')
        self.assertFalse(self._sync(fetch, force_refresh=True)['cacheStatus']['accessibleScopeComplete'])

    def test_full_page_without_continuation_is_not_accessible_scope_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                return Response([{'name': 'Alpha'}])
            return Response([{'id': i, 'project': {'name': 'Alpha'}} for i in range(pipeline_service.BUILD_PAGE_SIZE)])
        self.assertFalse(self._sync(fetch, force_refresh=True)['cacheStatus']['accessibleScopeComplete'])

    def test_failed_refresh_does_not_reuse_a_complete_flag_from_an_earlier_read(self):
        calls, fetch = self._scoped_fetch()
        self.assertTrue(self._sync(fetch)['cacheStatus']['accessibleScopeComplete'])
        _, failing = self._scoped_fetch(fail_beta=True)
        status = self._sync(failing, force_refresh=True)['cacheStatus']
        self.assertFalse(status['accessibleScopeComplete'])
        # the failed attempt must not leave a cacheable state behind
        after = self._sync(failing)['cacheStatus']
        self.assertFalse(after['accessibleScopeComplete'])

