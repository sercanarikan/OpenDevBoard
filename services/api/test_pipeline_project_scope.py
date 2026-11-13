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
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.requests, 'get', side_effect=fetch):
            result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True)
        self.assertEqual({x['id'] for x in result['items']}, {1, 2, 3})
        self.assertFalse(any(p == '/org/_apis/build/builds' for p, _ in calls))
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')
        self.assertTrue(result['cacheStatus']['projectDiscoveryComplete'])
        self.assertEqual(len([p for p, _ in calls if p.endswith('/Beta/_apis/build/builds')]), 2)

    def test_incomplete_project_inventory_does_not_claim_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                if params.get('continuationToken'):
                    return Response([], status=403)
                return Response([{'name': 'Alpha'}], token='next')
            return Response([])
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.requests, 'get', side_effect=fetch):
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
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.requests, 'get', side_effect=fetch):
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
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.requests, 'get', side_effect=fetch):
            result = pipeline_service.sync_live_pipeline_runs('https://dev.azure.com/org', 'synthetic', force_refresh=True, include_cache_status=True, project_scoped=True)
        self.assertEqual(result['cacheStatus']['outcome'], 'partial')
        self.assertFalse(result['cacheStatus']['complete'])
        self.assertEqual(result['cacheStatus']['successfulProjects'], ['Alpha'])

    def test_full_project_page_without_continuation_is_not_certified_complete(self):
        def fetch(url, *, headers, params, timeout):
            if urlparse(url).path.endswith('/_apis/projects'):
                return Response([{'name': f'Project-{i}'} for i in range(100)])
            return Response([])
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.requests, 'get', side_effect=fetch):
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
        with patch.object(sync_service, 'is_fixture_mode', return_value=False), patch.object(sync_service, 'get_devops_headers', return_value={}), patch.object(pipeline_service.requests, 'get', side_effect=fetch):
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
