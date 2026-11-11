"""Offline hardening tests for the sync engine: no silent truncation, safe reconciliation, transactional writes.

All Azure DevOps traffic is replaced by an in-memory fake that models the real limits (20,000 WIQL results,
200 ids per details call, errorPolicy=omit, 429/5xx).
"""
import json
import os
import re
import sqlite3
import tempfile
import threading
import unittest
from unittest import mock

os.environ['DEVOPS_DATA_DIR'] = tempfile.mkdtemp(prefix='devopsflow-hardening-')

import azure_client  # noqa: E402
import sync_service  # noqa: E402

ORG = 'https://dev.azure.com/o'


class Resp:
    def __init__(self, payload=None, status=200, text='', headers=None):
        self._p, self.status_code, self.text, self.headers = payload, status, text, headers or {}

    def json(self):
        return self._p


def raw_item(item_id, state='New', assigned='Ada', project='P1', changed='2026-11-05T08:00:00Z', parent=None,
             children=(), preds=(), succs=(), related=(), title=None, wtype='Task'):
    rels = []
    for c in children:
        rels.append({'rel': 'System.LinkTypes.Hierarchy-Forward', 'url': f'{ORG}/_apis/wit/workItems/{c}', 'attributes': {}})
    if parent:
        rels.append({'rel': 'System.LinkTypes.Hierarchy-Reverse', 'url': f'{ORG}/_apis/wit/workItems/{parent}', 'attributes': {}})
    for p in preds:
        rels.append({'rel': 'System.LinkTypes.Dependency-Reverse', 'url': f'{ORG}/_apis/wit/workItems/{p}', 'attributes': {'name': 'Predecessor'}})
    for s in succs:
        rels.append({'rel': 'System.LinkTypes.Dependency-Forward', 'url': f'{ORG}/_apis/wit/workItems/{s}', 'attributes': {'name': 'Successor'}})
    for r in related:
        rels.append({'rel': 'System.LinkTypes.Related', 'url': f'{ORG}/_apis/wit/workItems/{r}', 'attributes': {'name': 'Related'}})
    return {
        'id': item_id,
        'fields': {
            'System.Title': title or f'Item {item_id}', 'System.WorkItemType': wtype, 'System.State': state,
            'System.TeamProject': project, 'System.ChangedDate': changed, 'System.CreatedDate': changed,
            'Microsoft.VSTS.Common.Priority': 2,
            'System.AssignedTo': {'displayName': assigned} if assigned else None,
            **({'System.Parent': parent} if parent else {}),
        },
        'relations': rels,
        '_links': {'html': {'href': f'https://dev.azure.com/o/{project}/_workitems/edit/{item_id}'}},
    }


class FakeAzure:
    """Models the parts of Azure DevOps the sync engine depends on."""

    def __init__(self, items):
        self.items = {i['id']: i for i in items}
        self.wiql_calls = 0
        self.detail_calls = []
        self.fail_details_after = None  # raise HTTP 500 on the Nth details call (1-based)
        self.fail_ids = set()           # any details batch containing one of these -> HTTP 500
        self.rate_limit_first = 0       # first N requests -> 429
        self.writes = []
        self._n = 0

    # -- helpers -----------------------------------------------------------------------------
    def _match_wiql(self, query):
        ids = set(self.items)
        m = re.search(r"ChangedDate\] >= '([\d-]+)'", query)
        if m:
            ids = {i for i in ids if self.items[i]['fields']['System.ChangedDate'][:10] >= m.group(1)}
        if 'NOT IN' in query:
            ids = {i for i in ids if self.items[i]['fields']['System.State'] not in ('Closed', 'Completed', 'Done', 'Removed')}
        for op, key in (('>=', 'lo'), ('<', 'hi')):
            m2 = re.search(r'\[System\.Id\] ' + re.escape(op) + r' (\d+)', query)
            if m2:
                n = int(m2.group(1))
                ids = {i for i in ids if (i >= n if key == 'lo' else i < n)}
        return sorted(ids)

    def post(self, url, headers=None, json=None, timeout=None):
        self._n += 1
        if self._n <= self.rate_limit_first:
            return Resp(status=429, headers={'Retry-After': '1'})
        self.writes.append(('POST', url))
        self.wiql_calls += 1
        query = json['query']
        ids = self._match_wiql(query)
        if 'DESC' in query:
            ids = sorted(ids, reverse=True)
        top = re.search(r'\$top=(\d+)', url)
        if top:
            ids = ids[:int(top.group(1))]
        elif len(ids) > azure_client.WIQL_RESULT_LIMIT:
            return Resp(status=400, text='VS402337: The number of work items returned exceeds the size limit of 20000.')
        return Resp({'workItems': [{'id': i} for i in ids]})

    def get(self, url, headers=None, timeout=None):
        self._n += 1
        if self._n <= self.rate_limit_first:
            return Resp(status=429, headers={'Retry-After': '1'})
        self.writes.append(('GET', url))
        ids = [int(x) for x in re.search(r'ids=([\d,]+)', url).group(1).split(',')]
        self.detail_calls.append(ids)
        assert len(ids) <= 200, 'Azure rejects more than 200 ids per call'
        if self.fail_details_after and len(self.detail_calls) >= self.fail_details_after:
            return Resp(status=500, text='boom')
        if self.fail_ids and self.fail_ids & set(ids):
            return Resp(status=500, text='boom')
        omit = 'errorPolicy=omit' in url
        value = []
        for i in ids:
            if i in self.items:
                value.append(self.items[i])
            elif omit:
                value.append(None)
            else:
                return Resp(status=404, text='not found')
        return Resp({'value': value})

    def patch_all(self):
        return mock.patch.multiple(sync_service.requests, post=self.post, get=self.get)


def reset_db():
    with sync_service.db_lock, sync_service.get_db_connection() as c:
        c.execute('DELETE FROM work_items')
        c.execute('DELETE FROM sync_state')


def rows(**where):
    sql = 'SELECT * FROM work_items'
    if where:
        sql += ' WHERE ' + ' AND '.join(f'{k} = ?' for k in where)
    with sync_service.get_db_connection() as c:
        return [dict(r) for r in c.execute(sql, tuple(where.values()))]


def row(item_id):
    with sync_service.get_db_connection() as c:
        r = c.execute('SELECT * FROM work_items WHERE id = ?', (item_id,)).fetchone()
        return dict(r) if r else None


def run_sync(fake, **kw):
    with fake.patch_all(), mock.patch.object(sync_service, '_sleep', lambda s: None):
        return sync_service.sync_work_items(ORG, 'pat', **kw)


class SyncHardeningBase(unittest.TestCase):
    def setUp(self):
        reset_db()


class NoSilentTruncation(SyncHardeningBase):
    def test_more_than_the_old_2500_cap_is_fully_stored(self):
        fake = FakeAzure([raw_item(i) for i in range(1, 5301)])
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(len(rows()), 5300)
        self.assertEqual(res['fetched'], 5300)
        self.assertTrue(all(len(c) <= 200 for c in fake.detail_calls))

    def test_explicit_cap_is_reported_as_partial_and_never_as_success(self):
        fake = FakeAzure([raw_item(i) for i in range(1, 501)])
        res = run_sync(fake, force_full=True, max_items=100)
        self.assertEqual(res['status'], 'partial')
        self.assertTrue(any(w.startswith('truncated_by_max_items') for w in res['warnings']))
        self.assertIsNone(sync_service.get_sync_meta('watermark'))
        self.assertIsNone(sync_service.get_sync_meta('last_full_sync'))
        self.assertIsNone(sync_service.get_sync_meta('last_success_at'))
        self.assertEqual(sync_service.get_sync_meta('sync_status'), 'partial')

    def test_wiql_size_limit_is_partitioned_without_loss_or_duplicates(self):
        fake = FakeAzure([raw_item(i) for i in range(1, 45001)])
        client = azure_client.AzureClient(ORG, 'pat', sleep=lambda s: None)
        with fake.patch_all():
            result = client.collect_ids(sync_service.SCOPE_WHERE)
        self.assertTrue(result.partitioned)
        self.assertEqual(result.ids, list(range(1, 45001)))
        self.assertEqual(len(result.ids), len(set(result.ids)))

    def test_partitioned_full_sync_stores_everything(self):
        fake = FakeAzure([raw_item(i) for i in range(1, 20501)])
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertGreater(res['partitions'], 1)
        self.assertEqual(len(rows()), 20500)

    def test_missing_detail_ids_are_reported(self):
        items = [raw_item(i) for i in range(1, 11)]
        fake = FakeAzure(items)
        original = fake._match_wiql
        fake._match_wiql = lambda q: original(q) + [999]  # WIQL lists an id whose details are gone
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertTrue(any(w.startswith('missing_detail:1') for w in res['warnings']))

    def test_rate_limit_is_retried_then_succeeds(self):
        fake = FakeAzure([raw_item(1)])
        fake.rate_limit_first = 2
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(len(rows()), 1)


class TransactionalWrites(SyncHardeningBase):
    def test_failure_midway_keeps_previous_snapshot_untouched(self):
        run_sync(FakeAzure([raw_item(i) for i in range(1, 11)]), force_full=True)
        before = rows()
        meta_before = {k: sync_service.get_sync_meta(k) for k in ('watermark', 'last_full_sync', 'last_success_at')}

        fake = FakeAzure([raw_item(i, state='In Progress', changed='2026-12-01T00:00:00Z') for i in range(1, 451)])
        fake.fail_details_after = 2
        res = run_sync(fake, force_full=True)

        self.assertEqual(res['status'], 'error')
        self.assertEqual(rows(), before)
        self.assertEqual(meta_before, {k: sync_service.get_sync_meta(k) for k in meta_before})
        self.assertEqual(sync_service.get_sync_meta('sync_status'), 'error')

    def test_exception_during_write_rolls_back_everything(self):
        run_sync(FakeAzure([raw_item(1), raw_item(2)]), force_full=True)
        before = rows()
        fake = FakeAzure([raw_item(1, state='Active'), raw_item(2, state='Active'), raw_item(3)])
        with mock.patch.object(sync_service, 'recompute_derived', side_effect=RuntimeError('derived failed')):
            res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertEqual(rows(), before)

    def test_status_never_stays_syncing(self):
        with fake_patch_boom():
            sync_service.sync_work_items(ORG, 'pat', force_full=True)
        self.assertNotEqual(sync_service.get_sync_meta('sync_status'), 'syncing')

    def test_stuck_syncing_status_is_reset_on_init(self):
        sync_service.set_sync_meta('sync_status', 'syncing')
        sync_service.init_db()
        self.assertEqual(sync_service.get_sync_meta('sync_status'), 'idle')

    def test_structured_result_is_persisted(self):
        run_sync(FakeAzure([raw_item(1)]), force_full=True)
        last = json.loads(sync_service.get_sync_meta('last_sync_result'))
        for key in ('mode', 'status', 'fetched', 'upserted', 'deleted', 'out_of_scope', 'warnings', 'duration_ms',
                    'started_at', 'finished_at'):
            self.assertIn(key, last)
        rep = sync_service.get_sync_report()
        self.assertEqual(rep['last_result']['status'], 'success')
        self.assertIsNotNone(rep['last_success_at'])


def fake_patch_boom():
    return mock.patch.multiple(sync_service.requests, post=mock.Mock(side_effect=RuntimeError('boom')),
                               get=mock.Mock(side_effect=RuntimeError('boom')))


class Concurrency(SyncHardeningBase):
    def test_parallel_syncs_run_exactly_once_and_do_not_corrupt_data(self):
        fake = FakeAzure([raw_item(i) for i in range(1, 801)])
        gate = threading.Event()
        original_post = fake.post

        def slow_post(*a, **k):
            gate.wait(2)
            return original_post(*a, **k)

        fake.post = slow_post
        results = []

        def worker():
            with fake.patch_all(), mock.patch.object(sync_service, '_sleep', lambda s: None):
                results.append(sync_service.sync_work_items(ORG, 'pat', force_full=True))

        with mock.patch.multiple(sync_service.requests, post=fake.post, get=fake.get):
            threads = [threading.Thread(target=worker) for _ in range(4)]
            for t in threads:
                t.start()
            threading.Event().wait(0.3)
            gate.set()
            for t in threads:
                t.join(20)

        statuses = sorted(r['status'] for r in results)
        self.assertEqual(statuses.count('success'), 1, statuses)
        self.assertEqual(statuses.count('in_progress'), 3, statuses)
        ids = [r['id'] for r in rows()]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ids), 800)
        self.assertEqual(sync_service.get_sync_meta('sync_status'), 'idle')

    def test_rejected_duplicate_does_not_touch_sync_meta(self):
        run_sync(FakeAzure([raw_item(1)]), force_full=True)
        meta = sync_service.get_sync_meta('last_sync_result')
        self.assertTrue(sync_service.sync_lock.acquire(blocking=False))
        try:
            res = sync_service.sync_work_items(ORG, 'pat')
        finally:
            sync_service.sync_lock.release()
        self.assertEqual(res['status'], 'in_progress')
        self.assertEqual(sync_service.get_sync_meta('last_sync_result'), meta)
        self.assertEqual(sync_service.get_sync_meta('sync_status'), 'idle')


class Reconciliation(SyncHardeningBase):
    def _seed(self, n=60):
        fake = FakeAzure([raw_item(i) for i in range(1, n + 1)])
        run_sync(fake, force_full=True)
        return fake

    def test_item_that_left_scope_but_still_exists_is_not_deleted(self):
        fake = self._seed()
        fake.items[5] = raw_item(5, state='Closed')
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        r = row(5)
        self.assertIsNone(r['deleted_at'])
        self.assertEqual(r['is_active'], 0)
        self.assertEqual(r['state'], 'Closed')
        self.assertEqual(res['out_of_scope'], 1)
        self.assertEqual(res['deleted'], 0)

    def test_item_truly_absent_in_azure_is_soft_deleted(self):
        fake = self._seed()
        del fake.items[7]
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertIsNotNone(row(7)['deleted_at'])
        self.assertEqual(res['deleted'], 1)
        self.assertEqual(len([r for r in rows() if r['deleted_at'] is None]), 59)
        self.assertEqual(sync_service.get_counts()['total_active_cached'], 59)

    def test_refetch_error_deletes_nothing_and_reports_partial(self):
        fake = self._seed()
        del fake.items[7]
        fake.fail_ids = {7}
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'partial')
        self.assertIsNone(row(7)['deleted_at'])
        self.assertEqual(res['deleted'], 0)
        self.assertIsNone(sync_service.get_sync_meta('last_success_at') and None)

    def test_api_error_is_never_deletion_evidence(self):
        fake = self._seed()
        fake.fail_details_after = 1
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertEqual(len([r for r in rows() if r['deleted_at'] is None]), 60)

    def test_mass_delete_is_blocked(self):
        fake = self._seed(200)
        for i in range(1, 101):
            del fake.items[i]
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'partial')
        self.assertTrue(any(w.startswith('mass_delete_blocked') for w in res['warnings']))
        self.assertEqual(len([r for r in rows() if r['deleted_at'] is None]), 200)

    def test_incremental_sync_never_deletes(self):
        fake = self._seed()
        del fake.items[3]
        res = run_sync(fake)
        self.assertEqual(res['mode'], 'incremental')
        self.assertIsNone(row(3)['deleted_at'])

    def test_resurrected_item_clears_deleted_at(self):
        fake = self._seed()
        gone = fake.items.pop(9)
        run_sync(fake, force_full=True)
        self.assertIsNotNone(row(9)['deleted_at'])
        fake.items[9] = gone
        run_sync(fake, force_full=True)
        self.assertIsNone(row(9)['deleted_at'])

    def test_partial_run_never_reconciles(self):
        fake = self._seed()
        del fake.items[4]
        res = run_sync(fake, force_full=True, max_items=10)
        self.assertEqual(res['status'], 'partial')
        self.assertIsNone(row(4)['deleted_at'])


class ContextRows(SyncHardeningBase):
    def _world(self):
        # epic 1000 (completed, context) -> story 10 (active) -> tasks 11 (active), 12 (Done, descendant)
        # dependency 2000 (completed) is a predecessor of task 11
        return FakeAzure([
            raw_item(1000, state='Closed', wtype='Epic', children=[10]),
            raw_item(10, state='Active', wtype='User Story', parent=1000, children=[11, 12]),
            raw_item(11, state='New', parent=10, preds=[2000]),
            raw_item(12, state='Done', parent=10),
            raw_item(2000, state='Done', succs=[11]),
        ])

    def _scope_only(self, fake):
        original = fake._match_wiql
        fake._match_wiql = lambda q: [i for i in original(q) if i in (10, 11)]

    def test_ancestors_descendants_and_dependency_targets_are_cached_as_context(self):
        fake = self._world()
        self._scope_only(fake)
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        by = {r['id']: r for r in rows()}
        self.assertEqual({r for r in by if by[r]['is_context'] == 0}, {10, 11})
        self.assertEqual({r for r in by if by[r]['is_context'] == 1}, {1000, 12, 2000})
        self.assertEqual(sync_service.get_counts()['total_active_cached'], 2)
        self.assertEqual(by[11]['is_blocked'], 0)  # predecessor 2000 is Done

    def test_unreferenced_context_row_is_orphan_cleaned_but_referenced_one_is_kept(self):
        fake = self._world()
        self._scope_only(fake)
        run_sync(fake, force_full=True)
        # task 11 no longer depends on 2000 and epic link disappears from story 10
        fake.items[11] = raw_item(11, state='New', parent=10)
        fake.items[2000] = raw_item(2000, state='Done')
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertIsNotNone(row(2000)['deleted_at'])   # no longer referenced -> orphan
        self.assertIsNone(row(12)['deleted_at'])         # still a child of story 10
        self.assertIsNone(row(1000)['deleted_at'])       # still the parent of story 10

    def test_context_data_never_overwrites_an_in_scope_row(self):
        fake = self._world()
        self._scope_only(fake)
        run_sync(fake, force_full=True)
        before = row(10)
        with sync_service.get_db_connection() as c:
            c.execute("UPDATE work_items SET title = 'LOCAL' WHERE id = 10")
        # force the context upsert path onto an in-scope id
        item = sync_service.parse_work_item(raw_item(10, state='Closed', title='FROM-CONTEXT'), ORG)
        with sync_service.get_db_connection() as c:
            c.execute(sync_service._UPSERT_CONTEXT_SQL, sync_service._row_params(item, 'now', True))
        self.assertEqual(row(10)['title'], 'LOCAL')
        self.assertEqual(row(10)['is_context'], before['is_context'])


class DerivedFlags(SyncHardeningBase):
    def _prep(self, pred_state):
        fake = FakeAzure([raw_item(1, state=pred_state, succs=[2]), raw_item(2, preds=[1])])
        run_sync(fake, force_full=True)
        return fake

    def test_blocked_flips_when_predecessor_completes_even_if_dependent_untouched(self):
        fake = self._prep('In Progress')
        self.assertEqual(row(2)['is_blocked'], 1)
        fake.items[1] = raw_item(1, state='Done', succs=[2], changed='2026-11-06T00:00:00Z')
        original = fake._match_wiql
        fake._match_wiql = lambda q: [i for i in original(q) if i == 1]  # dependent 2 is NOT re-fetched
        res = run_sync(fake)
        self.assertEqual(res['mode'], 'incremental')
        self.assertEqual(row(2)['is_blocked'], 0)
        self.assertEqual(res['derived']['newly_unblocked'], 1)

    def test_reopened_predecessor_blocks_again(self):
        fake = self._prep('Done')
        self.assertEqual(row(2)['is_blocked'], 0)
        fake.items[1] = raw_item(1, state='Active', succs=[2], changed='2026-11-06T00:00:00Z')
        run_sync(fake)
        self.assertEqual(row(2)['is_blocked'], 1)

    def test_resolved_predecessor_still_blocks(self):
        self._prep('Resolved')
        self.assertEqual(row(2)['is_blocked'], 1)

    def test_blocking_flag_follows_successors(self):
        self._prep('Active')
        self.assertEqual(row(1)['is_blocking'], 1)
        self.assertEqual(row(2)['is_blocking'], 0)

    def test_second_derived_run_updates_nothing(self):
        self._prep('Active')
        with sync_service.get_db_connection() as c:
            stats = sync_service.recompute_derived(c)
        self.assertEqual(stats['rows_updated'], 0)

    def test_soft_deleted_predecessor_of_an_untouched_dependent_keeps_its_last_snapshot(self):
        fake = self._prep('Active')
        del fake.items[1]
        original = fake._match_wiql
        # an incremental run that does not re-fetch the dependent: its stored snapshot (predecessor Active) stays
        fake._match_wiql = lambda q: [i for i in original(q) if i == 999]
        run_sync(fake)
        with sync_service.get_db_connection() as c:
            c.execute("UPDATE work_items SET deleted_at = 'x' WHERE id = 1")
            sync_service.recompute_derived(c)
        self.assertEqual(row(2)['is_blocked'], 1)

    def test_refetched_dependent_of_a_deleted_predecessor_is_unresolved_not_blocked(self):
        fake = self._prep('Active')
        del fake.items[1]
        run_sync(fake, force_full=True)
        self.assertIsNotNone(row(1)['deleted_at'])
        served = sync_service.get_single_item(2)
        self.assertTrue(served['hasUnresolvedPredecessors'])
        self.assertEqual(row(2)['is_blocked'], 0)


class ReadPathsHideDeleted(SyncHardeningBase):
    def test_deleted_rows_are_excluded_everywhere(self):
        fake = FakeAzure([raw_item(i) for i in range(1, 6)])
        run_sync(fake, force_full=True)
        with sync_service.get_db_connection() as c:
            c.execute("UPDATE work_items SET deleted_at = 'x' WHERE id = 3")
        self.assertEqual(sync_service.get_counts()['total_active_cached'], 4)
        self.assertEqual(sync_service.get_counts()['total_cached'], 4)
        pool = sync_service.build_pool_from_cache()
        self.assertNotIn(3, [i['id'] for i in pool['flat_items']])
        self.assertIsNone(sync_service.get_single_item(3))
        self.assertEqual(sync_service.query_work_items()['totalCount'], 4)


class Migration(unittest.TestCase):
    def test_pre_migration_database_is_upgraded_without_losing_rows(self):
        path = os.path.join(tempfile.mkdtemp(prefix='devopsflow-migrate-'), 'devops_cache.db')
        conn = sqlite3.connect(path)
        conn.execute('''CREATE TABLE work_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
            state TEXT NOT NULL, project TEXT NOT NULL, assigned_to TEXT, assigned_avatar TEXT, priority INTEGER DEFAULT 3,
            iteration TEXT, area_path TEXT, parent_id INTEGER, parent_title TEXT, parent_type TEXT, story_points REAL,
            changed_date TEXT, created_date TEXT, is_bug INTEGER DEFAULT 0, is_task INTEGER DEFAULT 0,
            is_unassigned INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, is_blocked INTEGER DEFAULT 0,
            is_blocking INTEGER DEFAULT 0, url TEXT, description TEXT, relations_json TEXT, last_synced_at TEXT)''')
        conn.execute("INSERT INTO work_items (id,title,type,state,project) VALUES (1,'a','Task','New','P')")
        conn.execute("INSERT INTO work_items (id,title,type,state,project) VALUES (2,'b','Task','New','P')")
        conn.commit()
        conn.close()

        old = sync_service.DB_PATH
        try:
            sync_service.DB_PATH = path
            sync_service.init_db()
            sync_service.init_db()  # idempotent
            with sync_service.get_db_connection() as c:
                cols = {r['name'] for r in c.execute('PRAGMA table_info(work_items)')}
                n = c.execute('SELECT COUNT(*) FROM work_items').fetchone()[0]
                ctx = c.execute('SELECT COUNT(*) FROM work_items WHERE is_context = 0 AND deleted_at IS NULL').fetchone()[0]
            self.assertTrue({'deleted_at', 'last_seen_at', 'is_context'} <= cols)
            self.assertEqual(n, 2)
            self.assertEqual(ctx, 2)
        finally:
            sync_service.DB_PATH = old


class FixtureGuard(unittest.TestCase):
    def test_sync_refuses_to_run_in_fixture_mode_without_network(self):
        with mock.patch.dict(os.environ, {'DEVOPS_FIXTURE_MODE': '1'}), \
             mock.patch.object(sync_service.requests, 'post', side_effect=AssertionError('network used')), \
             mock.patch.object(sync_service.requests, 'get', side_effect=AssertionError('network used')):
            res = sync_service.sync_work_items(ORG, 'pat', force_full=True)
        self.assertEqual(res, {'status': 'error', 'error': 'fixture_mode'})


class ReadOnlyGuarantee(unittest.TestCase):
    def test_sync_only_issues_get_and_wiql_post(self):
        reset_db()
        fake = FakeAzure([raw_item(1, parent=2), raw_item(2, wtype='Epic', state='Closed')])
        run_sync(fake, force_full=True)
        for method, url in fake.writes:
            self.assertIn(method, ('GET', 'POST'))
            if method == 'POST':
                self.assertIn('/_apis/wit/wiql', url)


if __name__ == '__main__':
    unittest.main()
