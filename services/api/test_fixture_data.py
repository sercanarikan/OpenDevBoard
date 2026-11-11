"""Offline unit tests for the deterministic fixture (no Azure DevOps access required).

Run:  .venv\\Scripts\\python.exe -m unittest test_fixture_data -v
"""
import json
import os
import tempfile
import time
import unittest

os.environ['DEVOPS_DATA_DIR'] = tempfile.mkdtemp(prefix='devopsflow-fixture-test-')

import sync_service  # noqa: E402
import fixture_data  # noqa: E402
from fixture_data import FIXTURE_USER, PROJECTS, COLUMNS  # noqa: E402
from fixture_data import UNRESOLVED_TARGET_ID, UNRESOLVED_DEPENDENT_TITLE  # noqa: E402


def _use_fresh_db():
    """Points sync_service at a brand-new empty SQLite file and initialises its schema."""
    sync_service.DB_PATH = os.path.join(tempfile.mkdtemp(prefix='devopsflow-db-'), 'cache.db')
    sync_service.init_db()


def _count_rows():
    conn = sync_service.get_db_connection()
    try:
        return conn.execute('SELECT COUNT(*) FROM work_items').fetchone()[0]
    finally:
        conn.close()


def _meta_snapshot():
    conn = sync_service.get_db_connection()
    try:
        return {r['key']: r['val'] for r in conn.execute('SELECT key, val FROM sync_state')}
    finally:
        conn.close()


class FixtureDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = fixture_data.build_fixture()
        cls.by_id = {r['id']: r for r in cls.rows}
        cls.inv = fixture_data.expected_invariants(cls.rows)
        cls.active = [r for r in cls.rows if r['is_active'] == 1 and r['is_context'] == 0]

    def test_determinism(self):
        self.assertEqual(fixture_data.build_fixture(), fixture_data.build_fixture())

    def test_build_is_fast(self):
        started = time.perf_counter()
        fixture_data.build_fixture()
        self.assertLess(time.perf_counter() - started, 0.5)

    def test_row_shape(self):
        for r in self.rows:
            self.assertEqual(set(r.keys()), set(COLUMNS))
            self.assertIsInstance(r['relations_json'], str)
            json.loads(r['relations_json'])
            self.assertEqual(r['assigned_avatar'], '')

    def test_ids_unique_and_start_at_10001(self):
        ids = [r['id'] for r in self.rows]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(min(ids), 10001)

    def test_urls(self):
        for r in self.rows:
            self.assertEqual(r['url'], f"https://dev.azure.com/fixture-org/{r['project']}/_workitems/edit/{r['id']}")

    def test_projects_and_volumes(self):
        self.assertEqual(PROJECTS, ['Alpha', 'Beta', 'Gamma'])
        self.assertEqual(set(r['project'] for r in self.rows), set(PROJECTS))
        self.assertGreaterEqual(self.inv['total_active'], 700)
        self.assertLessEqual(self.inv['total_active'], 740)
        self.assertGreaterEqual(self.inv['completed_count'], 60)
        self.assertEqual(self.inv['total_context'], 12)
        for p in PROJECTS:
            self.assertGreater(self.inv['per_project_active'][p], 0)

    def test_context_rows(self):
        for r in self.rows:
            if r['is_context'] == 1:
                self.assertEqual(r['is_active'], 0)
                self.assertIn(r['type'], ('Epic', 'Feature'))
                self.assertIn(r['state'], ('Done', 'Closed'))

    def test_states(self):
        states = set(self.inv['per_state_active'])
        for s in ('New', 'To Do', 'In Progress', 'Active', 'Committed', 'Resolved'):
            self.assertIn(s, states)
        self.assertGreaterEqual(self.inv['new_state_active'], 170)
        self.assertEqual(self.inv['weird_state_count'], 1)
        self.assertEqual(self.inv['weird_state_count'], sum(1 for r in self.active if r['state'] == 'Weird State'))
        completed_states = {r['state'] for r in self.rows if r['is_active'] == 0 and r['is_context'] == 0}
        self.assertEqual(completed_states, {'Done', 'Closed'})

    def test_resolved_is_not_completed(self):
        for r in self.rows:
            if r['state'] == 'Resolved':
                self.assertEqual(r['is_active'], 1)

    def test_active_flag_rule(self):
        for r in self.rows:
            if r['is_context'] == 1:
                continue
            completed = r['state'] in {'Done', 'Closed', 'Completed'}
            self.assertEqual(r['is_active'], 0 if (completed or r['state'] == 'Removed') else 1)

    def test_hierarchy_consistent(self):
        kinds = set()
        for r in self.rows:
            if r['parent_id'] is None:
                if r['title'] == UNRESOLVED_DEPENDENT_TITLE:
                    continue  # deliberate standalone case, covered by test_unresolved_predecessor_case
                self.assertIn(r['type'], ('Epic',))
                continue
            parent = self.by_id[r['parent_id']]
            self.assertEqual(r['parent_title'], parent['title'])
            self.assertEqual(r['parent_type'], parent['type'])
            kinds.add((parent['type'], r['type']))
        self.assertIn(('Epic', 'Feature'), kinds)
        self.assertIn(('Feature', 'User Story'), kinds)
        self.assertIn(('Feature', 'Product Backlog Item'), kinds)
        self.assertTrue(any(t in ('Task', 'Bug') and p in ('User Story', 'Product Backlog Item') for p, t in kinds))

    def test_every_epic_and_feature_has_children(self):
        parent_ids = {r['parent_id'] for r in self.rows if r['parent_id']}
        for r in self.rows:
            if r['type'] in ('Epic', 'Feature') and r['is_context'] == 0:
                self.assertIn(r['id'], parent_ids, r['title'])

    def test_some_stories_atomic(self):
        parent_ids = {r['parent_id'] for r in self.rows if r['parent_id']}
        stories = [r for r in self.rows if r['type'] in ('User Story', 'Product Backlog Item')]
        self.assertTrue(any(s['id'] not in parent_ids for s in stories))

    def test_assignments(self):
        n = len(self.active)
        mine = self.inv['my_tasks_active']
        self.assertGreaterEqual(mine, 60)
        self.assertGreater(mine / n, 0.25)
        self.assertLess(mine / n, 0.45)
        unassigned = self.inv['unassigned_active']
        self.assertGreater(unassigned / n, 0.18)
        self.assertLess(unassigned / n, 0.32)
        for r in self.rows:
            if r['is_unassigned'] == 1:
                self.assertEqual(r['assigned_to'], 'Unassigned')
        names = {r['assigned_to'] for r in self.active}
        for name in ('Fixture Person A', 'Fixture Person B', 'Fixture Person E'):
            self.assertIn(name, names)

    def test_needles_and_turkish(self):
        needle_titles = [r['title'] for r in self.active if 'needle' in r['title'].lower()]
        self.assertEqual(self.inv['needle_count'], len(needle_titles))
        self.assertGreaterEqual(self.inv['needle_count'], 12)
        self.assertEqual(self.inv['needle_capital_count'], 3)
        needle_projects = {r['project'] for r in self.active if 'needle' in r['title'].lower()}
        self.assertEqual(needle_projects, set(PROJECTS))
        self.assertEqual(self.inv['turkish_title_count'], 1)

    def test_priorities(self):
        self.assertEqual({r['priority'] for r in self.rows}, {1, 2, 3, 4})
        self.assertGreater(self.inv['p1_active'], 0)

    def test_bug_task_flags(self):
        for r in self.rows:
            self.assertEqual(r['is_bug'], 1 if 'bug' in r['type'].lower() else 0)
            self.assertEqual(r['is_task'], 1 if 'task' in r['type'].lower() else 0)
        self.assertGreater(self.inv['bugs_active'], 0)

    def test_relation_symmetry(self):
        pairs = 0
        for r in self.rows:
            rel = json.loads(r['relations_json'])
            self.assertEqual(rel['total'], len(rel['predecessors']) + len(rel['successors']) + len(rel['related']))
            for s in rel['successors']:
                pairs += 1
                other = json.loads(self.by_id[s['id']]['relations_json'])
                self.assertIn(r['id'], [p['id'] for p in other['predecessors']])
            for p in rel['predecessors']:
                if p['id'] == UNRESOLVED_TARGET_ID:
                    continue  # deliberately unreadable target (see test_unresolved_predecessor_case)
                other = json.loads(self.by_id[p['id']]['relations_json'])
                self.assertIn(r['id'], [s['id'] for s in other['successors']])
            for x in rel['related']:
                other = json.loads(self.by_id[x['id']]['relations_json'])
                self.assertIn(r['id'], [y['id'] for y in other['related']])
        self.assertGreaterEqual(pairs, 40)
        self.assertGreaterEqual(self.inv['predecessor_links'], 40)

    def test_relation_entries_are_filled(self):
        for r in self.rows:
            rel = json.loads(r['relations_json'])
            for kind, rel_type in (('predecessors', 'predecessor'), ('successors', 'successor'), ('related', 'related')):
                for e in rel[kind]:
                    self.assertEqual(e['relType'], rel_type)
                    if e['id'] == UNRESOLVED_TARGET_ID:
                        self.assertNotIn('state', e)   # unreadable target: nothing is invented
                        self.assertNotIn('title', e)
                        continue
                    target = self.by_id[e['id']]
                    self.assertEqual(e['state'], target['state'])
                    self.assertEqual(e['title'], target['title'])
                    self.assertEqual(e['project'], target['project'])
                    self.assertEqual(e['url'], target['url'])

    def test_blocked_and_blocking_rule(self):
        blocked_seen = unblocked_with_pred = False
        for r in self.rows:
            rel = json.loads(r['relations_json'])
            unresolved = any(p.get('state') and p['state'] not in ('Done', 'Closed', 'Completed') for p in rel['predecessors'])
            self.assertEqual(r['is_blocked'], 1 if unresolved else 0)
            self.assertEqual(r['is_blocking'], 1 if rel['successors'] else 0)
            if unresolved:
                blocked_seen = True
            if rel['predecessors'] and not unresolved and all(p.get('state') for p in rel['predecessors']):
                unblocked_with_pred = True
        self.assertTrue(blocked_seen)
        self.assertTrue(unblocked_with_pred)
        self.assertGreater(self.inv['blocked_active'], 0)
        self.assertGreater(self.inv['blocking_active'], 0)

    def test_unresolved_predecessor_case(self):
        """One active task whose only predecessor cannot be read: neither blocked nor clear, nothing invented."""
        rows = [r for r in self.rows if r['title'] == UNRESOLVED_DEPENDENT_TITLE]
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r['is_active'], r['is_context'], r['assigned_to']), (1, 0, FIXTURE_USER))
        rel = json.loads(r['relations_json'])
        self.assertEqual([p['id'] for p in rel['predecessors']], [UNRESOLVED_TARGET_ID])
        self.assertNotIn(UNRESOLVED_TARGET_ID, self.by_id)
        self.assertEqual(r['is_blocked'], 0)

    def test_dependency_chain_of_four(self):
        def chain_len(node_id, seen=()):
            succs = [s['id'] for s in json.loads(self.by_id[node_id]['relations_json'])['successors']]
            if not succs:
                return 1
            return 1 + max(chain_len(s, seen + (node_id,)) for s in succs if s not in seen)

        longest = 0
        for r in self.rows:
            if not json.loads(r['relations_json'])['predecessors']:
                longest = max(longest, chain_len(r['id']))
        self.assertGreaterEqual(longest, 4)

    def test_cross_project_relations(self):
        cross = 0
        for r in self.rows:
            for s in json.loads(r['relations_json'])['successors']:
                if s['project'] != r['project']:
                    cross += 1
        self.assertGreater(cross, 0)

    def test_related_links(self):
        self.assertGreaterEqual(self.inv['related_links'], 6)

    def test_changed_date_ties(self):
        shared = self.inv['shared_changed_date_rows']
        self.assertGreaterEqual(shared / len(self.rows), 0.25)
        self.assertTrue(all(r['changed_date'].endswith('Z') for r in self.rows))

    def test_my_tasks_active_matches_rows(self):
        self.assertEqual(self.inv['my_tasks_active'],
                         sum(1 for r in self.rows if r['assigned_to'] == FIXTURE_USER and r['is_active'] == 1
                             and r['is_context'] == 0))

    def test_invariant_keys_exposed(self):
        for key in ('total_active', 'per_project_active', 'my_tasks_active', 'unassigned_active',
                    'blocked_active', 'bugs_active', 'completed_count', 'per_state_active',
                    'needle_count', 'kanban_todo_active', 'p1_active', 'total_org_active'):
            self.assertIn(key, self.inv)
        self.assertEqual(self.inv['total_active'], sum(self.inv['per_project_active'].values()))


class SeedAndGuardTests(unittest.TestCase):
    def setUp(self):
        _use_fresh_db()

    def test_seed_writes_rows_and_meta(self):
        summary = fixture_data.seed_fixture()
        self.assertTrue(summary['seeded'])
        self.assertEqual(_count_rows(), summary['total_rows'])
        meta = _meta_snapshot()
        self.assertEqual(meta['fixture_mode'], '1')
        self.assertEqual(meta['sync_status'], 'idle')
        self.assertEqual(meta['total_org_active'], str(summary['total_org_active']))
        self.assertEqual(meta['watermark'], summary['max_changed_date'])
        self.assertTrue(meta['last_full_sync'])
        self.assertEqual(json.loads(meta['last_sync_result'])['fixture'], True)

    def test_seed_idempotent(self):
        first = fixture_data.seed_fixture()
        before = _meta_snapshot()
        second = fixture_data.seed_fixture()
        self.assertFalse(second['seeded'])
        self.assertEqual(second['total_active'], first['total_active'])
        self.assertEqual(_count_rows(), first['total_rows'])
        self.assertEqual(_meta_snapshot()['last_full_sync'], before['last_full_sync'])

    def test_ensure_on_empty_db_returns_true(self):
        self.assertTrue(fixture_data.ensure_fixture_database())
        self.assertEqual(_meta_snapshot()['fixture_mode'], '1')
        self.assertGreater(_count_rows(), 700)

    def test_ensure_refuses_non_fixture_data(self):
        conn = sync_service.get_db_connection()
        conn.execute(
            "INSERT INTO work_items (id, title, type, state, project, is_active) VALUES (1, 'Real', 'Task', 'New', 'Real', 1)"
        )
        conn.commit()
        conn.close()
        before_rows = _count_rows()
        before_meta = _meta_snapshot()
        self.assertFalse(fixture_data.ensure_fixture_database())
        self.assertEqual(_count_rows(), before_rows)
        self.assertEqual(_meta_snapshot(), before_meta)
        self.assertNotIn('fixture_mode', before_meta)


if __name__ == '__main__':
    unittest.main()
