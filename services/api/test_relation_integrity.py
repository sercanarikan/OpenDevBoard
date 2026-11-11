"""Relation integrity regression tests (offline).

Covers the dependency placeholder regression: relation targets that are completed or context-only (not in the active
scope) must resolve to their REAL title/state, and targets that cannot be verified must stay "unknown" instead of
getting an invented state or a Blocked/Clear verdict.
"""
import os
import tempfile
import unittest

os.environ.setdefault('DEVOPS_DATA_DIR', tempfile.mkdtemp(prefix='devopsflow-relint-'))

import sync_service  # noqa: E402
from test_sync_hardening import FakeAzure, raw_item, reset_db, row, run_sync  # noqa: E402


def only(fake, ids):
    """Restrict the WIQL scope to `ids` (everything else is reachable only as hierarchy / dependency context)."""
    original = fake._match_wiql
    fake._match_wiql = lambda q: [i for i in original(q) if i in ids]


def snapshot(item_id, kind, target_id):
    r = sync_service.get_single_item(item_id)
    return next(e for e in r['relations'][kind] if e['id'] == target_id)


class CompletedAndContextTargets(unittest.TestCase):
    def setUp(self):
        reset_db()

    def test_done_predecessor_outside_the_active_scope_resolves_to_its_real_data(self):
        # 2000 is Done (not in the active WIQL) and only reachable as a dependency target
        fake = FakeAzure([
            raw_item(10, state='In Progress', preds=[2000], title='Dependent'),
            raw_item(2000, state='Done', succs=[10], title='Real predecessor title'),
        ])
        only(fake, {10})
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')

        ctx = row(2000)
        self.assertEqual(ctx['is_context'], 1)
        self.assertEqual(ctx['state'], 'Done')

        pred = snapshot(10, 'predecessors', 2000)
        self.assertEqual(pred['title'], 'Real predecessor title')
        self.assertEqual(pred['state'], 'Done')
        self.assertNotEqual(pred['state'], 'New')

        served = sync_service.get_single_item(10)
        self.assertFalse(served['isBlocked'])                 # completed predecessor is not a blocker
        self.assertFalse(served['hasUnresolvedPredecessors'])  # and nothing is unresolved

    def test_pool_exposes_completed_and_context_rows_for_the_graph(self):
        fake = FakeAzure([
            raw_item(10, state='In Progress', preds=[2000, 2001]),
            raw_item(2000, state='Done', succs=[10], assigned='Grace'),
            raw_item(2001, state='Closed', succs=[10]),
        ])
        only(fake, {10})
        run_sync(fake, force_full=True)
        pool = sync_service.build_pool_from_cache()
        self.assertEqual([i['id'] for i in pool['flat_items']], [10])
        ctx = {c['id']: c for c in pool['context_items']}
        for tid in (2000, 2001):
            self.assertIn(tid, ctx)
            self.assertTrue(ctx[tid]['title'])
            self.assertIn(ctx[tid]['state'], ('Done', 'Closed'))
        self.assertEqual(ctx[2000]['assignedTo'], 'Grace')   # graph nodes show the real assignee
        self.assertIn('priority', ctx[2000])
        self.assertEqual(ctx[2000]['successorIds'], [10])      # and can keep walking the graph
        self.assertEqual(ctx[2000]['predecessorIds'], [])

    def test_resolved_predecessor_still_blocks(self):
        fake = FakeAzure([raw_item(10, preds=[2000]), raw_item(2000, state='Resolved', succs=[10])])
        only(fake, {10})
        run_sync(fake, force_full=True)
        self.assertEqual(row(10)['is_blocked'], 1)


class UnknownPredecessors(unittest.TestCase):
    def setUp(self):
        reset_db()

    def _world(self, known_state=None):
        rels = [{'rel': 'System.LinkTypes.Dependency-Reverse', 'url': 'https://x/_apis/wit/workItems/999',
                 'attributes': {'name': 'Predecessor'}}]
        item = raw_item(10, preds=[2000] if known_state else [])
        item['relations'] += rels
        items = [item]
        if known_state:
            items.append(raw_item(2000, state=known_state, succs=[10]))
        fake = FakeAzure(items)
        only(fake, {10})
        return fake

    def test_unknown_only_is_neither_blocked_nor_clear(self):
        run_sync(self._world(), force_full=True)
        served = sync_service.get_single_item(10)
        self.assertFalse(served['isBlocked'])
        self.assertTrue(served['hasUnresolvedPredecessors'])   # the UI must say "unresolved", not "clear"
        pred = snapshot(10, 'predecessors', 999)
        self.assertIsNone(pred.get('state'))
        self.assertIsNone(pred.get('title'))
        self.assertNotIn(pred.get('assignedTo'), ('Unassigned',))

    def test_known_incomplete_predecessor_wins_over_an_unknown_one(self):
        run_sync(self._world(known_state='Active'), force_full=True)
        served = sync_service.get_single_item(10)
        self.assertTrue(served['isBlocked'])
        self.assertTrue(served['hasUnresolvedPredecessors'])

    def test_known_completed_plus_unknown_is_not_blocked_but_still_unresolved(self):
        run_sync(self._world(known_state='Done'), force_full=True)
        served = sync_service.get_single_item(10)
        self.assertFalse(served['isBlocked'])
        self.assertTrue(served['hasUnresolvedPredecessors'])

    def test_unknown_target_does_not_count_in_blocked_totals(self):
        run_sync(self._world(), force_full=True)
        self.assertEqual(sync_service.get_counts()['blocked_total'], 0)

    def test_missing_targets_are_reported_not_invented(self):
        res = run_sync(self._world(), force_full=True)
        self.assertTrue(any(w.startswith('context_missing') for w in res['warnings']))
        with sync_service.get_db_connection() as c:
            n = c.execute('SELECT COUNT(*) FROM work_items WHERE id = 999').fetchone()[0]
        self.assertEqual(n, 0)   # no placeholder row is ever written for a target we could not read

    def test_hollow_completed_row_is_reconciled_and_healed(self):
        # Simulate a legacy pre-existing row 17850 that was written with relations_json IS NULL and is_active = 0
        with sync_service.get_db_connection() as conn:
            conn.execute('''
                INSERT INTO work_items (id, title, type, state, project, is_active, is_context, relations_json, last_seen_at)
                VALUES (17850, 'Legacy Hollow', 'Task', 'Done', 'Alpha', 0, 0, NULL, NULL)
            ''')
            conn.commit()

        # In Azure, 17850 has real relations pointing to successor 91007
        raw_17850 = raw_item(17850, state='Done', succs=[91007])
        raw_91007 = raw_item(91007, state='Active', preds=[17850])
        fake = FakeAzure([raw_17850, raw_91007])
        only(fake, {91007})  # Active WIQL only returns 91007

        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')

        # Row 17850 must be healed in SQLite: relations_json must not be NULL and successors must include 91007
        with sync_service.get_db_connection() as conn:
            r = conn.execute('SELECT relations_json, is_active, last_seen_at FROM work_items WHERE id = 17850').fetchone()
            self.assertIsNotNone(r['relations_json'])
            import json
            rels = json.loads(r['relations_json'])
            succ_ids = [s['id'] for s in rels.get('successors', [])]
            self.assertIn(91007, succ_ids)
            self.assertIsNotNone(r['last_seen_at'])

    def test_build_pool_from_cache_projects_all_distinct(self):
        with sync_service.get_db_connection() as conn:
            conn.execute("INSERT OR REPLACE INTO work_items (id, title, type, state, project, is_active, is_context, relations_json) VALUES (101, 'A', 'Task', 'New', 'Proj1', 1, 0, '{}')")
            conn.execute("INSERT OR REPLACE INTO work_items (id, title, type, state, project, is_active, is_context, relations_json) VALUES (102, 'B', 'Task', 'Done', 'Proj2', 0, 1, '{}')")
            sync_service._set_meta(conn, 'last_full_sync', '2026-11-06T12:00:00Z')
            conn.commit()

        pool = sync_service.build_pool_from_cache('Proj1')
        self.assertIsNotNone(pool)
        self.assertIn('Proj1', pool['projects'])
        self.assertIn('Proj2', pool['projects'])


if __name__ == '__main__':
    unittest.main()
