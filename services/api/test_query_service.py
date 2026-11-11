"""Offline tests for query_service and the new /api routes (no Azure DevOps access).

Run:  .venv\\Scripts\\python.exe -m unittest test_query_service -v
"""
import os
import tempfile
import time
import unittest

os.environ['DEVOPS_DATA_DIR'] = tempfile.mkdtemp(prefix='devopsflow-qs-test-')

_PREVIOUS_FIXTURE_MODE = os.environ.get('DEVOPS_FIXTURE_MODE')


def setUpModule():
    # Scoped to this module: `unittest discover` runs every test file in one process, and a leaked
    # DEVOPS_FIXTURE_MODE would make the sync engine refuse to run in the other modules.
    os.environ['DEVOPS_FIXTURE_MODE'] = '1'


def tearDownModule():
    if _PREVIOUS_FIXTURE_MODE is None:
        os.environ.pop('DEVOPS_FIXTURE_MODE', None)
    else:
        os.environ['DEVOPS_FIXTURE_MODE'] = _PREVIOUS_FIXTURE_MODE


import sync_service  # noqa: E402
import fixture_data  # noqa: E402
import query_service as qs  # noqa: E402

QUICK = ['all', 'my-tasks', 'unassigned', 'blocked', 'blocking', 'bugs']
SORTS = ['changedDate', 'priority', 'id', 'title', 'state']


def params(**kw):
    args = {k: str(v) for k, v in kw.items()}
    return qs.parse_list_params(args)


def all_pages(**kw):
    first = qs.list_work_items(params(limit=50, **kw))
    total = first['total']
    ids = [i['id'] for i in first['items']]
    offset = len(first['items'])
    while offset < total:
        page = qs.list_work_items(params(limit=50, offset=offset, **kw))
        ids.extend(i['id'] for i in page['items'])
        offset += len(page['items'])
        if not page['items']:
            break
    return total, ids


def hand_db(rows):
    """Creates a fresh isolated cache and inserts rows. Rows are dicts with work_items columns."""
    sync_service.init_db()
    conn = sync_service.get_db_connection()
    try:
        with sync_service.db_lock:
            conn.execute('DELETE FROM work_items')
            base = {
                'title': 't', 'type': 'Task', 'state': 'New', 'project': 'Alpha', 'assigned_to': 'Ada',
                'priority': 2, 'parent_id': None, 'parent_title': None, 'parent_type': None,
                'changed_date': '2026-10-01T00:00:00Z', 'is_bug': 0, 'is_task': 1, 'is_unassigned': 0,
                'is_active': 1, 'is_blocked': 0, 'is_blocking': 0, 'is_context': 0, 'deleted_at': None,
                'relations_json': '{}', 'last_synced_at': '2026-10-01T00:00:00Z',
            }
            for r in rows:
                d = {**base, **r}
                cols = ', '.join(d)
                conn.execute(f'INSERT INTO work_items ({cols}) VALUES ({", ".join("?" * len(d))})',
                             tuple(d.values()))
            conn.commit()
    finally:
        conn.close()


def reseed_fixture():
    sync_service.init_db()
    conn = sync_service.get_db_connection()
    try:
        with sync_service.db_lock:
            conn.execute('DELETE FROM work_items')
            conn.execute("DELETE FROM sync_state WHERE key = 'fixture_mode'")
            conn.commit()
    finally:
        conn.close()
    return fixture_data.seed_fixture()


class FixtureTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.summary_seed = reseed_fixture()

    def setUp(self):
        reseed_fixture()


class PaginationTests(FixtureTestBase):
    def test_every_sort_and_order_returns_each_id_once(self):
        expected_total = self.summary_seed['total_active']
        for sort in SORTS:
            for order in ('asc', 'desc'):
                with self.subTest(sort=sort, order=order):
                    total, ids = all_pages(sortBy=sort, sortOrder=order)
                    self.assertEqual(total, expected_total)
                    self.assertEqual(len(ids), total)
                    self.assertEqual(len(set(ids)), total)

    def test_total_is_stable_across_pages_and_offset_past_end(self):
        first = qs.list_work_items(params(limit=50))
        last = qs.list_work_items(params(limit=50, offset=first['total'] + 500))
        self.assertEqual(last['items'], [])
        self.assertEqual(last['total'], first['total'])
        self.assertEqual(last['limit'], 50)
        self.assertEqual(last['offset'], first['total'] + 500)
        for key in ('dataVersion', 'total', 'limit', 'offset'):
            self.assertIn(key, first)

    def test_limit_is_clamped_and_invalid_rejected(self):
        self.assertEqual(qs.list_work_items(params(limit=999))['limit'], 200)
        for bad in ({'limit': 0}, {'limit': 'abc'}, {'quickFilter': 'nope'}, {'sortBy': 'x'},
                    {'sortOrder': 'up'}, {'column': 'later'}, {'swimlane': 'zzz'},
                    {'quickFilter': 'my-tasks'}, {'priority': 9}):
            with self.subTest(bad=bad):
                with self.assertRaises(qs.ParamError):
                    params(**bad)

    def test_page_param_maps_to_offset(self):
        r = qs.list_work_items(params(limit=10, page=3))
        self.assertEqual(r['offset'], 20)
        self.assertEqual(r['page'], 3)

    def test_priority_sort_order(self):
        items = qs.list_work_items(params(limit=200, sortBy='priority', sortOrder='asc'))['items']
        prios = [i['priority'] for i in items]
        self.assertEqual(prios, sorted(prios))

    def test_changed_date_nulls_last_is_deterministic(self):
        hand_db([
            {'id': 1, 'changed_date': None},
            {'id': 2, 'changed_date': '2026-10-02T00:00:00Z'},
            {'id': 3, 'changed_date': None},
        ])
        ids = [i['id'] for i in qs.list_work_items(params(limit=50, sortOrder='desc'))['items']]
        self.assertEqual(ids, [2, 1, 3])


class FilterTests(FixtureTestBase):
    def test_filters_combine(self):
        r = qs.list_work_items(params(limit=200, project='Alpha', assignee=fixture_data.FIXTURE_USER,
                                      priority='1,2', type='Task', quickFilter='all'))
        for it in r['items']:
            self.assertEqual(it['project'], 'Alpha')
            self.assertEqual(it['assignedTo'], fixture_data.FIXTURE_USER)
            self.assertIn(it['priority'], (1, 2))
            self.assertEqual(it['type'], 'Task')

    def test_search_needle_variants_match(self):
        base = qs.list_work_items(params(limit=200, search='needle'))['total']
        self.assertGreaterEqual(base, 1)
        self.assertEqual(qs.list_work_items(params(limit=200, search='Needle'))['total'], base)
        self.assertEqual(qs.list_work_items(params(limit=200, search='NEEDLE'))['total'], base)

    def test_turkish_search_both_directions(self):
        hand_db([{'id': 1, 'title': 'İğdır raporu'}, {'id': 2, 'title': 'iğdır notu'},
                 {'id': 3, 'title': 'ŞABLON dosyası'}, {'id': 4, 'title': 'şablon'}, {'id': 5, 'title': 'other'}])
        for needle in ('iğdır', 'İğdır', 'IĞDIR', 'ığdır'):
            with self.subTest(needle=needle):
                ids = sorted(i['id'] for i in qs.list_work_items(params(limit=50, search=needle))['items'])
                self.assertEqual(ids, [1, 2], needle)
        for needle in ('şablon', 'ŞABLON', 'Şablon'):
            with self.subTest(needle=needle):
                ids = sorted(i['id'] for i in qs.list_work_items(params(limit=50, search=needle))['items'])
                self.assertEqual(ids, [3, 4], needle)

    def test_multi_word_search_is_and(self):
        hand_db([{'id': 1, 'title': 'alpha beta gamma'}, {'id': 2, 'title': 'alpha only'},
                 {'id': 3, 'title': 'beta only', 'assigned_to': 'alpha'}])
        ids = sorted(i['id'] for i in qs.list_work_items(params(limit=50, search='alpha beta'))['items'])
        self.assertEqual(ids, [1, 3])

    def test_percent_and_underscore_are_literal(self):
        hand_db([{'id': 1, 'title': '100% done'}, {'id': 2, 'title': '1000 done'},
                 {'id': 3, 'title': 'a_b'}, {'id': 4, 'title': 'axb'}])
        self.assertEqual([i['id'] for i in qs.list_work_items(params(search='100%'))['items']], [1])
        self.assertEqual([i['id'] for i in qs.list_work_items(params(search='a_b'))['items']], [3])

    def test_search_by_id(self):
        r = qs.list_work_items(params(limit=50, search='1'))
        self.assertTrue(all(i['id'] is not None for i in r['items']))
        target = self._some_active_id()
        ids = [i['id'] for i in qs.list_work_items(params(limit=200, search=str(target)))['items']]
        self.assertIn(target, ids)

    def _some_active_id(self):
        return qs.list_work_items(params(limit=1))['items'][0]['id']

    def test_column_filter_state_categories(self):
        hand_db([
            {'id': 1, 'state': 'New'}, {'id': 2, 'state': 'Committed'}, {'id': 3, 'state': 'Testing'},
            {'id': 4, 'state': 'Closed', 'is_active': 0}, {'id': 5, 'state': 'Weird State'},
            {'id': 6, 'state': 'Removed', 'is_active': 0}, {'id': 7, 'state': '  Resolved '},
        ])
        cols = {}
        for c in ('todo', 'in-progress', 'resolved', 'done'):
            cols[c] = sorted(i['id'] for i in qs.list_work_items(
                params(limit=50, column=c, includeCompleted='true'))['items'])
        self.assertEqual(cols['todo'], [1])
        self.assertEqual(cols['in-progress'], [2, 5, 6])
        self.assertEqual(cols['resolved'], [3, 7])
        self.assertEqual(cols['done'], [4])

    def test_include_completed_toggle(self):
        hand_db([{'id': 1, 'state': 'Done', 'is_active': 0}, {'id': 2, 'state': 'New'},
                 {'id': 3, 'state': 'Done', 'is_active': 1}])
        self.assertEqual(sorted(i['id'] for i in qs.list_work_items(params(limit=50))['items']), [2, 3])
        self.assertEqual(sorted(i['id'] for i in qs.list_work_items(
            params(limit=50, includeCompleted='true'))['items']), [1, 2, 3])


class SoftDeleteAndContextTests(unittest.TestCase):
    def setUp(self):
        hand_db([
            {'id': 10, 'title': 'story', 'type': 'User Story'},
            {'id': 11, 'title': 'child', 'parent_id': 10, 'state': 'New'},
            {'id': 12, 'title': 'ctx', 'is_context': 1},
            {'id': 13, 'title': 'gone', 'parent_id': 10, 'deleted_at': '2026-10-02T00:00:00Z'},
        ])

    def test_deleted_and_context_rows_hidden(self):
        ids = sorted(i['id'] for i in qs.list_work_items(params(limit=50, includeCompleted='true'))['items'])
        self.assertEqual(ids, [10, 11])
        self.assertEqual(qs.summary()['scope']['total'], 2)
        self.assertEqual(qs.progress_for([10])['progress']['10']['totalUnits'], 1)

    def test_soft_deleted_child_vanishes_from_kanban_and_progress(self):
        kb = qs.kanban(params(swimlane='parent', limit=50))
        all_ids = [i['id'] for lane in kb['lanes'] for col in lane['columns'].values() for i in col]
        self.assertNotIn(13, all_ids)
        self.assertEqual(kb['total'], 2)

    def test_hidden_via_http(self):
        import app as app_module
        client = app_module.app.test_client()
        ids = [i['id'] for i in client.get('/api/work-items?includeCompleted=true&limit=50').get_json()['items']]
        self.assertNotIn(13, ids)
        self.assertNotIn(12, ids)


class SummaryAndKanbanTests(FixtureTestBase):
    def test_summary_equals_list_total_for_every_quick_filter_and_project(self):
        for project in ('all', 'Alpha', 'Beta', 'Gamma'):
            s = qs.summary(project=project, current_user=fixture_data.FIXTURE_USER)
            for qf, key in (('all', 'total'), ('my-tasks', 'myTasks'), ('unassigned', 'unassigned'),
                            ('blocked', 'blocked'), ('blocking', 'blocking'), ('bugs', 'bugs')):
                with self.subTest(project=project, quickFilter=qf):
                    lst = qs.list_work_items(params(limit=1, project=project, quickFilter=qf,
                                                    currentUser=fixture_data.FIXTURE_USER))
                    self.assertEqual(lst['total'], s['scope'][key])
            my_blocked_lst = qs.list_work_items(params(limit=1, project=project, quickFilter='blocked',
                                                       assignee=fixture_data.FIXTURE_USER,
                                                       currentUser=fixture_data.FIXTURE_USER))
            self.assertEqual(my_blocked_lst['total'], s['scope']['myBlocked'])

    def test_summary_projects_ignore_project_filter_and_completed_count(self):
        s = qs.summary(project='Alpha')
        names = {p['name'] for p in s['projects']}
        self.assertEqual(names, set(fixture_data.PROJECTS))
        self.assertEqual(s['scope']['project'], 'Alpha')
        self.assertEqual(qs.summary(project='all')['completed'], self.summary_seed['completed_count'])

    def test_summary_completed_follows_project_scope(self):
        conn = sync_service.get_db_connection()
        try:
            expected = conn.execute(
                'SELECT COUNT(*) FROM work_items WHERE deleted_at IS NULL AND is_context = 0 '
                'AND is_active = 0 AND project = ?', ('Alpha',)).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(qs.summary(project='Alpha')['completed'], expected)

    def test_kanban_column_totals_equal_lane_cell_sums(self):
        for mode in ('none', 'parent', 'assignee', 'priority'):
            with self.subTest(swimlane=mode):
                kb = qs.kanban(params(swimlane=mode, laneLimit=100, cardLimit=50, limit=50))
                for col in qs.COLUMNS:
                    cell_sum = sum(lane['counts'][col] for lane in kb['lanes'])
                    if mode == 'none' or kb['laneTotal'] <= 100:
                        self.assertEqual(cell_sum, kb['columns'][col], col)
                self.assertEqual(sum(kb['columns'].values()), kb['total'])

    def test_kanban_cards_respect_card_limit_and_list_order(self):
        kb = qs.kanban(params(swimlane='assignee', cardLimit=3, sortBy='priority', sortOrder='asc'))
        for lane in kb['lanes']:
            for col, cards in lane['columns'].items():
                self.assertLessEqual(len(cards), 3)
                self.assertLessEqual(len(cards), lane['counts'][col])
                listed = qs.list_work_items(params(
                    limit=3, sortBy='priority', sortOrder='asc', column=col,
                    lane=f"assignee:{lane['key']}"))['items']
                self.assertEqual([c['id'] for c in cards], [c['id'] for c in listed])

    def test_lane_filter_and_column_continuation_no_duplicates(self):
        kb = qs.kanban(params(swimlane='parent', cardLimit=2, laneLimit=100, sortBy='id', sortOrder='asc'))
        checked = 0
        for lane in kb['lanes']:
            for col in qs.COLUMNS:
                if lane['counts'][col] <= 2:
                    continue
                checked += 1
                shown = [c['id'] for c in lane['columns'][col]]
                rest = []
                offset = 0
                while True:
                    page = qs.list_work_items(params(limit=2, offset=offset, column=col, lane=f"parent:{lane['key']}",
                                                     sortBy='id', sortOrder='asc', includeCompleted='true'))
                    if not page['items']:
                        break
                    rest.extend(i['id'] for i in page['items'])
                    offset += len(page['items'])
                self.assertEqual(rest[:len(shown)], shown)
                self.assertEqual(len(rest), len(set(rest)))
                self.assertEqual(len(rest), lane['counts'][col])
        self.assertGreater(checked, 0)

    def test_hide_completed_empties_done_column(self):
        kb = qs.kanban(params(swimlane='none', hideCompleted='true', includeCompleted='true'))
        self.assertEqual(kb['columns']['done'], 0)
        for lane in kb['lanes']:
            self.assertEqual(lane['counts']['done'], 0)

    def test_parent_lane_progress_equals_progress_for(self):
        kb = qs.kanban(params(swimlane='parent', laneLimit=100, cardLimit=1))
        checked = 0
        for lane in kb['lanes']:
            if lane['key'] == 'none':
                continue
            checked += 1
            pid = int(lane['key'])
            expected = qs.progress_for([pid])['progress'][str(pid)]
            self.assertEqual(lane['progress']['totalUnits'], expected['totalUnits'])
            self.assertEqual(lane['progress']['completedUnits'], expected['completedUnits'])
            self.assertEqual(lane['progress']['percent'], expected['percent'])
        self.assertGreater(checked, 0)

    def test_fixture_progress_matches_full_hierarchy_for_every_parent(self):
        rows = sync_service.get_db_connection().execute(
            'SELECT id, parent_id, state, is_blocked, is_unassigned FROM work_items WHERE deleted_at IS NULL'
        ).fetchall()
        full = qs.compute_progress_map(rows)
        ids = [r['id'] for r in rows if r['parent_id'] is None][:200]
        got = qs.progress_for(ids)['progress']
        for i in ids:
            self.assertEqual(got[str(i)]['totalUnits'], full[i]['totalUnits'])

    def test_progress_rejects_too_many_ids(self):
        with self.assertRaises(qs.ParamError):
            qs.progress_for(list(range(1, 502)))


class ProgressRuleTests(unittest.TestCase):
    def rows(self, spec):
        out = []
        for r in spec:
            d = {'id': r[0], 'parent_id': r[1], 'state': r[2], 'is_blocked': 0, 'is_unassigned': 0}
            if len(r) > 3:
                d.update(r[3])
            out.append(d)
        return out

    def prog(self, spec, pid):
        return qs.compute_progress_map(self.rows(spec))[pid]

    def test_resolved_is_not_completed_and_removed_excluded(self):
        p = self.prog([(1, None, 'User Story'), (2, 1, 'Done'), (3, 1, 'Resolved'), (4, 1, 'Removed')], 1)
        self.assertEqual((p['totalUnits'], p['completedUnits'], p['percent']), (2, 1, 50))

    def test_atomic_story_without_children_is_one_unit(self):
        p = self.prog([(1, None, 'Done')], 1)
        self.assertEqual((p['totalUnits'], p['completedUnits'], p['percent'], p['hasChildren']), (1, 1, 100, False))
        q = self.prog([(1, None, 'Active')], 1)
        self.assertEqual((q['totalUnits'], q['completedUnits'], q['percent']), (1, 0, 0))

    def test_leaves_deduplicated_by_id_under_two_stories(self):
        p = self.prog([(1, None, 'Feature'), (2, 1, 'User Story'), (3, 1, 'User Story'),
                       (4, 2, 'Done'), (5, 3, 'New')], 1)
        self.assertEqual((p['totalUnits'], p['completedUnits']), (2, 1))

    def test_cycle_does_not_loop(self):
        p = qs.compute_progress_map(self.rows([(1, 2, 'New'), (2, 1, 'New')]))
        self.assertEqual(p[1]['totalUnits'], 0)
        self.assertEqual(p[2]['totalUnits'], 0)

    def test_js_rounding_half_up(self):
        self.assertEqual(self.pct(1, 8), 13)
        self.assertEqual(self.pct(5, 8), 63)
        self.assertEqual(self.pct(1, 2), 50)
        self.assertEqual(self.pct(1, 6), 17)
        self.assertEqual(self.pct(0, 0), 0)

    def pct(self, done, total):
        spec = [(1, None, 'Feature')]
        for i in range(total):
            spec.append((100 + i, 1, 'Done' if i < done else 'New'))
        return qs.compute_progress_map(self.rows(spec))[1]['percent']

    def test_blocked_and_unassigned_counts(self):
        p = self.prog([(1, None, 'Feature'), (2, 1, 'New', {'is_blocked': 1, 'is_unassigned': 1}),
                       (3, 1, 'New', {'is_blocked': 1})], 1)
        self.assertEqual((p['blockedCount'], p['unassignedCount']), (2, 1))


class HttpTests(FixtureTestBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import app as app_module
        cls.client = app_module.app.test_client()

    def test_invalid_params_return_400_json(self):
        for url in ('/api/work-items?limit=0', '/api/work-items?limit=abc', '/api/work-items?quickFilter=bad',
                    '/api/work-items?quickFilter=my-tasks', '/api/work-items?sortBy=nope',
                    '/api/work-items?column=later', '/api/kanban?swimlane=zzz', '/api/work-items/progress',
                    '/api/work-items/progress?ids=1,x', '/api/work-items/progress?ids=' + ','.join(str(i) for i in range(1, 502)),
                    '/api/kanban?laneLimit=0', '/api/kanban?cardLimit=99'):
            with self.subTest(url=url[:80]):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 400)
                self.assertIn('error', r.get_json())
                self.assertEqual(r.headers.get('Cache-Control'), 'no-store')

    def test_response_shapes_and_data_version(self):
        r = self.client.get('/api/work-items?limit=5').get_json()
        for key in ('items', 'total', 'limit', 'offset', 'dataVersion', 'dataScope', 'totalPages'):
            self.assertIn(key, r)
        self.assertEqual(r['dataScope'], 'fixture')
        s = self.client.get('/api/work-items/summary').get_json()
        self.assertIn('dataVersion', s)
        self.assertIn('scope', s)
        k = self.client.get('/api/kanban?swimlane=parent').get_json()
        self.assertIn('dataVersion', k)
        self.assertIn('columns', k)
        me = self.client.get('/api/me').get_json()
        self.assertEqual(me, {'displayName': fixture_data.FIXTURE_USER, 'source': 'fixture'})
        ss = self.client.get('/api/sync-status').get_json()
        for key in ('status', 'source', 'totalOrgActive', 'totalCached', 'error', 'dataVersion'):
            self.assertIn(key, ss)

    def test_missing_item_returns_404_json_without_azure(self):
        r = self.client.get('/api/work-items/999999999')
        self.assertEqual(r.status_code, 404)
        self.assertIn('error', r.get_json())

    def test_counts_route_still_works(self):
        r = self.client.get('/api/work-items/counts')
        self.assertEqual(r.status_code, 200)
        self.assertIn('total_active_cached', r.get_json())

    def test_fixture_sync_is_successful_without_credentials_or_network(self):
        from unittest.mock import patch
        import app as app_module

        with patch.dict(os.environ, {'DEVOPS_FIXTURE_MODE': '1'}, clear=False), \
                patch.dict(os.environ, {'AZURE_DEVOPS_ORG_URL': '', 'AZURE_DEVOPS_PAT': ''}), \
                patch.object(app_module.requests, 'get', side_effect=AssertionError('network used')), \
                patch.object(app_module.requests, 'post', side_effect=AssertionError('network used')):
            response = self.client.post('/api/sync', json={'mode': 'full'})

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['status'], 'success')
        self.assertTrue(response.get_json()['fixture'])


class ChildrenAndBatchTests(unittest.TestCase):
    def setUp(self):
        hand_db([
            {'id': 100, 'title': 'story', 'type': 'User Story', 'state': 'Active'},
            {'id': 101, 'title': 'open-low', 'parent_id': 100, 'priority': 3, 'state': 'New'},
            {'id': 102, 'title': 'open-high', 'parent_id': 100, 'priority': 1, 'state': 'Active'},
            {'id': 103, 'title': 'done', 'parent_id': 100, 'priority': 1, 'state': 'Done', 'is_active': 0},
            {'id': 104, 'title': 'ctx-child', 'parent_id': 100, 'priority': 2, 'state': 'Done',
             'is_active': 0, 'is_context': 1},
            {'id': 105, 'title': 'deleted', 'parent_id': 100, 'deleted_at': '2026-10-02T00:00:00Z'},
            {'id': 106, 'title': 'other-story', 'type': 'User Story'},
            {'id': 107, 'title': 'tie-b', 'parent_id': 100, 'priority': 3, 'state': 'New'},
        ])

    def test_children_include_context_and_completed_and_order(self):
        r = qs.children(100)
        self.assertEqual([i['id'] for i in r['items']], [102, 101, 107, 103, 104])
        self.assertEqual(r['total'], 5)
        self.assertFalse(r['truncated'])
        self.assertIn('dataVersion', r)

    def test_children_deleted_parent_and_missing_parent(self):
        self.assertIsNone(qs.children(105))
        self.assertIsNone(qs.children(999999))

    def test_children_truncated_over_cap(self):
        hand_db([{'id': 1000 + i, 'parent_id': 200, 'title': f'c{i}'} for i in range(qs.CHILDREN_LIMIT + 3)]
                + [{'id': 200, 'title': 'big', 'type': 'User Story'}])
        r = qs.children(200)
        self.assertEqual(len(r['items']), qs.CHILDREN_LIMIT)
        self.assertEqual(r['total'], qs.CHILDREN_LIMIT + 3)
        self.assertTrue(r['truncated'])

    def test_batch_order_dedupe_missing_and_context(self):
        r = qs.batch('104,100,999,100,105,101')
        self.assertEqual([i['id'] for i in r['items']], [104, 100, 101])
        self.assertEqual(r['missing'], [999, 105])
        self.assertIn('dataVersion', r)

    def test_batch_rejects_bad_input(self):
        for bad in ('', 'a,1', ','.join(str(i) for i in range(1, 102))):
            with self.subTest(bad=bad[:20]):
                with self.assertRaises(qs.ParamError):
                    qs.batch(bad)

    def test_http_children_batch_and_single_item(self):
        import app as app_module
        client = app_module.app.test_client()
        r = client.get('/api/work-items/100/children')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get('Cache-Control'), 'no-store')
        self.assertEqual(client.get('/api/work-items/999999/children').status_code, 404)
        self.assertEqual(client.get('/api/work-items/105/children').status_code, 404)
        b = client.get('/api/work-items/batch?ids=100,999')
        self.assertEqual(b.status_code, 200)
        self.assertEqual(b.get_json()['missing'], [999])
        self.assertEqual(b.headers.get('Cache-Control'), 'no-store')
        self.assertEqual(client.get('/api/work-items/batch?ids=x').status_code, 400)
        s = client.get('/api/work-items/100')
        self.assertEqual(s.headers.get('Cache-Control'), 'no-store')
        self.assertEqual(client.get('/api/work-items/999999').status_code, 404)


class PerformanceTests(unittest.TestCase):
    def test_synthetic_5000_rows_under_300ms(self):
        import random
        rnd = random.Random(7)
        states = ['New', 'Active', 'Resolved', 'Done', 'Closed', 'Weird State']
        rows = []
        for i in range(1, 5001):
            rows.append({
                'id': i, 'title': f'Item {i} needle' if i % 97 == 0 else f'Item {i}',
                'state': rnd.choice(states), 'project': rnd.choice(['Alpha', 'Beta', 'Gamma']),
                'assigned_to': rnd.choice(['Ada', 'Grace', 'Unassigned']),
                'parent_id': (rnd.randint(1, i - 1) if i > 50 and rnd.random() < 0.5 else None),
                'priority': rnd.choice([1, 2, 3, 4]), 'is_unassigned': 0,
                'is_active': 1, 'changed_date': f'2026-10-{rnd.randint(1, 28):02d}T00:00:00Z',
            })
        hand_db(rows)
        for call in (lambda: qs.list_work_items(params(limit=50, search='needle', sortBy='priority')),
                     lambda: qs.kanban(params(swimlane='parent', cardLimit=15)),
                     lambda: qs.summary()):
            t0 = time.perf_counter()
            call()
            elapsed = (time.perf_counter() - t0) * 1000
            self.assertLess(elapsed, 300, f'{elapsed:.0f} ms')


if __name__ == '__main__':
    unittest.main()
