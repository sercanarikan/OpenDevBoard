"""Offline unit tests for sync_service (no Azure DevOps access required).

Run:  .venv\\Scripts\\python.exe -m unittest test_sync_service -v
"""
import os
import re
import tempfile
import unittest
from unittest import mock

os.environ['DEVOPS_DATA_DIR'] = tempfile.mkdtemp(prefix='devopsflow-test-')

import sync_service  # noqa: E402


def make_item(item_id, state='Active', assigned='Ada', project='P1', changed='2026-11-05T08:00:00Z',
              parent=None, rels=None):
    return {
        'id': item_id,
        'fields': {
            'System.Title': f'Item {item_id}', 'System.WorkItemType': 'Task', 'System.State': state,
            'System.TeamProject': project, 'System.ChangedDate': changed, 'System.CreatedDate': changed,
            'Microsoft.VSTS.Common.Priority': 2, 'System.AssignedTo': {'displayName': assigned} if assigned else None,
            **({'System.Parent': parent} if parent else {}),
        },
        'relations': rels or [],
        '_links': {'html': {'href': f'https://dev.azure.com/o/{project}/_workitems/edit/{item_id}'}},
    }


class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status_code = payload, status

    def json(self):
        return self._p

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f'HTTP {self.status_code}')


class SyncServiceTests(unittest.TestCase):
    def setUp(self):
        with sync_service.get_db_connection() as c:
            c.execute('DELETE FROM work_items')
            c.execute('DELETE FROM sync_state')

    def _run_sync(self, items, wiql_ids=None, **kw):
        wiql_ids = wiql_ids if wiql_ids is not None else [i['id'] for i in items]
        queries = []

        def fake_post(url, headers=None, json=None, timeout=None):
            queries.append(json['query'])
            return FakeResp({'workItems': [{'id': i} for i in wiql_ids]})

        def fake_get(url, headers=None, timeout=None):
            ids = [int(x) for x in re.search(r'ids=([\d,]+)', url).group(1).split(',')]
            return FakeResp({'value': [i for i in items if i['id'] in ids]})

        with mock.patch.object(sync_service.requests, 'post', fake_post), \
             mock.patch.object(sync_service.requests, 'get', fake_get):
            res = sync_service.sync_work_items('https://dev.azure.com/o', 'pat', **kw)
        return res, queries

    def test_incremental_query_uses_date_only_precision(self):
        """Regression: WIQL rejects a time component in ChangedDate comparisons (HTTP 400)."""
        self._run_sync([make_item(1)], force_full=True)
        _, queries = self._run_sync([make_item(1)])
        self.assertEqual(len(queries), 1)
        m = re.search(r"ChangedDate\] >= '([^']+)'", queries[0])
        self.assertIsNotNone(m, queries[0])
        self.assertRegex(m.group(1), r'^\d{4}-\d{2}-\d{2}$')

    def test_duplicate_ids_are_not_duplicated(self):
        items = [make_item(1), make_item(1)]
        self._run_sync(items, wiql_ids=[1], force_full=True)
        self.assertEqual(sync_service.get_counts()['total_cached'], 1)

    def test_completed_items_leave_active_scope_but_stay_cached(self):
        self._run_sync([make_item(1), make_item(2)], force_full=True)
        self._run_sync([make_item(2, state='Done')], wiql_ids=[2])
        c = sync_service.get_counts('Ada')
        self.assertEqual(c['total_cached'], 2)
        self.assertEqual(c['total_active_cached'], 1)
        self.assertEqual(c['my_tasks_active'], 1)
        self.assertEqual(c['my_tasks_completed'], 1)

    def test_resolved_is_not_treated_as_completed(self):
        self._run_sync([make_item(1, state='Resolved')], force_full=True)
        self.assertEqual(sync_service.get_counts()['total_active_cached'], 1)

    def test_pagination_is_stable_and_has_no_duplicates(self):
        items = [make_item(i, changed=f'2026-11-05T08:{i % 60:02d}:00Z') for i in range(1, 121)]
        self._run_sync(items, force_full=True)
        seen = []
        for page in (1, 2, 3):
            r = sync_service.query_work_items(page=page, page_size=50)
            self.assertEqual(r['totalCount'], 120)
            seen += [i['id'] for i in r['items']]
        self.assertEqual(len(seen), 120)
        self.assertEqual(len(set(seen)), 120)

    def test_filtered_total_count_and_search(self):
        self._run_sync([make_item(1, project='A'), make_item(2, project='B'), make_item(3, project='B')], force_full=True)
        self.assertEqual(sync_service.query_work_items(project='B')['totalCount'], 2)
        self.assertEqual(sync_service.query_work_items(search='Item 3')['totalCount'], 1)

    def test_unassigned_and_blocked_counts(self):
        rels = [{'rel': 'System.LinkTypes.Dependency-Reverse', 'url': 'https://x/_apis/wit/workItems/1',
                 'attributes': {'name': 'Predecessor'}}]
        self._run_sync([make_item(1), make_item(2, assigned=None, rels=rels)], force_full=True)
        c = sync_service.get_counts()
        self.assertEqual(c['unassigned_total'], 1)
        self.assertEqual(c['blocked_total'], 1)

    def test_unresolvable_predecessor_is_unknown_not_blocking(self):
        """A predecessor whose state cannot be verified must not produce a Blocked verdict (no evidence), and is
        surfaced as unresolved instead of an invented state."""
        rels = [{'rel': 'System.LinkTypes.Dependency-Reverse', 'url': 'https://x/_apis/wit/workItems/999',
                 'attributes': {'name': 'Predecessor'}}]
        self._run_sync([make_item(2, rels=rels)], force_full=True)
        self.assertEqual(sync_service.get_counts()['blocked_total'], 0)
        served = sync_service.get_single_item(2)
        self.assertTrue(served['hasUnresolvedPredecessors'])
        self.assertFalse(served['isBlocked'])
        pred = served['relations']['predecessors'][0]
        self.assertIsNone(pred.get('state'))   # never an invented 'New'
        self.assertIsNone(pred.get('title'))

    def test_api_failure_sets_error_status_and_keeps_cache(self):
        self._run_sync([make_item(1)], force_full=True)
        with mock.patch.object(sync_service.requests, 'post', side_effect=RuntimeError('boom')):
            res = sync_service.sync_work_items('https://dev.azure.com/o', 'pat')
        self.assertEqual(res['status'], 'error')
        self.assertEqual(sync_service.get_sync_meta('sync_status'), 'error')
        self.assertEqual(sync_service.get_counts()['total_cached'], 1)

    def test_concurrent_sync_is_rejected(self):
        self.assertTrue(sync_service.sync_lock.acquire(blocking=False))
        try:
            res = sync_service.sync_work_items('https://dev.azure.com/o', 'pat')
            self.assertEqual(res['status'], 'in_progress')
        finally:
            sync_service.sync_lock.release()


if __name__ == '__main__':
    unittest.main()
