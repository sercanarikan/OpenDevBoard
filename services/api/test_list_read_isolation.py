"""Work item read endpoints versus the sync write phase (offline, synthetic rows, isolated SQLite).

Two guarantees:
  * a read request never waits for ``sync_service.db_lock`` (the writer lock the sync apply phase holds), and
  * what a read request returns is ONE committed snapshot, and its ``dataVersion`` / ``lastSyncedAt`` belong to it.

The tests delete and rewrite ``work_items`` / ``sync_state``, so they never use whatever database
``sync_service`` happens to point at. ``setUpModule`` binds ``sync_service.DB_PATH`` to a fresh temporary
directory; ``tearDownModule`` restores the previous path and removes the directory. Neither a pre-set
``DEVOPS_DATA_DIR`` nor an earlier import of ``sync_service`` can redirect the destructive statements.

Run:  python -m unittest discover -s services/api -p "test_list_read_isolation.py" -v
"""
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from unittest import mock

import testsupport  # noqa: E402  (imports sync_service against a throwaway directory)
import query_service as qs  # noqa: E402

sync_service = testsupport.sync_service

ROWS = 200
CHUNK = 20
_STATE = {}


def setUpModule():
    _STATE['previous_db_path'] = sync_service.DB_PATH
    _STATE['dir'] = tempfile.mkdtemp(prefix='devopsflow-isolation-test-')
    sync_service.DB_PATH = os.path.join(_STATE['dir'], 'work_items_isolation.db')
    sync_service.init_db()


def tearDownModule():
    sync_service.DB_PATH = _STATE.pop('previous_db_path')
    shutil.rmtree(_STATE.pop('dir'), ignore_errors=True)


def _seed(generation=0):
    # Safety net before any destructive statement: only ever wipe the database created in setUpModule.
    if not _STATE.get('dir') or os.path.dirname(os.path.abspath(sync_service.DB_PATH)) != os.path.abspath(_STATE['dir']):
        raise RuntimeError(f'refusing to wipe a database outside the test directory: {sync_service.DB_PATH}')
    sync_service.init_db()
    conn = sync_service.get_db_connection()
    try:
        with sync_service.db_lock:
            conn.execute('DELETE FROM work_items')
            conn.execute('DELETE FROM sync_state')
            for i in range(1, ROWS + 1):
                conn.execute(
                    'INSERT INTO work_items (id, title, type, state, project, assigned_to, priority, changed_date, '
                    'is_bug, is_task, is_unassigned, is_active, is_blocked, is_blocking, is_context, deleted_at, '
                    'relations_json, last_synced_at) '
                    "VALUES (?, ?, 'Task', ?, 'Alpha', 'Ada', 2, '2026-10-01T00:00:00Z', 0, 1, 0, 1, 0, 0, 0, NULL, '{}', ?)",
                    (i, f'T{generation}', 'Active' if generation % 2 else 'New', f'g{generation}'))
            sync_service._set_meta(conn, 'last_success_at', f'g{generation}')
            conn.commit()
    finally:
        conn.close()


def _apply_generation(generation, pause=0.003):
    """Mimics sync_service._apply_phase: ONE transaction under the writer lock, rows rewritten in chunks, the
    completion meta committed together with the rows."""
    conn = sync_service.get_db_connection()
    conn.isolation_level = None
    try:
        with sync_service.db_lock:
            conn.execute('BEGIN IMMEDIATE')
            try:
                for start in range(1, ROWS + 1, CHUNK):
                    conn.execute(
                        'UPDATE work_items SET title = ?, state = ?, last_synced_at = ? WHERE id BETWEEN ? AND ?',
                        (f'T{generation}', 'Active' if generation % 2 else 'New', f'g{generation}',
                         start, start + CHUNK - 1))
                    time.sleep(pause)  # readers arrive while the transaction is still open
                sync_service._set_meta(conn, 'last_success_at', f'g{generation}')
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise
    finally:
        conn.close()


def _generation_of_version(version):
    # "<alive>:<max last_synced_at>:<last_success_at>:<deleted>" with the synthetic generation labels (no colons)
    parts = version.split(':')
    return parts[1], parts[2]


class ReadEndpointsDoNotWaitForWriterLock(unittest.TestCase):
    def setUp(self):
        _seed(0)

    def _blocked(self, call):
        out = []
        with sync_service.db_lock:  # a sync apply phase in progress
            t = threading.Thread(target=lambda: out.append(call()), daemon=True)
            t.start()
            t.join(timeout=3)
            waiting = t.is_alive()
        t.join(timeout=10)
        return waiting, out

    def test_every_read_endpoint_answers_while_the_writer_lock_is_held(self):
        calls = {
            'list': lambda: qs.list_work_items(qs.parse_list_params({})),
            'summary': lambda: qs.summary('all', 'Ada'),
            'children': lambda: qs.children(1),
            'batch': lambda: qs.batch('1,2,3'),
            'progress': lambda: qs.progress_for([1, 2]),
            'kanban': lambda: qs.kanban(qs.parse_list_params({})),
        }
        for name, call in calls.items():
            with self.subTest(endpoint=name):
                waiting, out = self._blocked(call)
                self.assertFalse(waiting, f'{name} waited for the sync writer lock')
                self.assertEqual(len(out), 1)


class ReadersSeeOneSnapshot(unittest.TestCase):
    def setUp(self):
        _seed(0)

    def test_list_and_summary_never_mix_generations_during_apply(self):
        stop = threading.Event()
        violations, reads = [], []

        def reader():
            while not stop.is_set():
                page = qs.list_work_items(qs.parse_list_params({'limit': '200'}))
                titles = {i['title'] for i in page['items']}
                max_synced, last_success = _generation_of_version(page['dataVersion'])
                gens = {t[1:] for t in titles}
                if len(titles) != 1 or page['lastSyncedAt'] != last_success or max_synced != last_success \
                        or gens != {last_success[1:]}:
                    violations.append(('list', sorted(titles), page['lastSyncedAt'], page['dataVersion']))
                summ = qs.summary('all', '')
                states = summ['facets']['states']
                max_synced, last_success = _generation_of_version(summ['dataVersion'])
                expected = 'Active' if int(last_success[1:]) % 2 else 'New'
                if states != {expected: ROWS} or summ['scope']['total'] != ROWS:
                    violations.append(('summary', states, summ['dataVersion']))
                reads.append(1)

        threads = [threading.Thread(target=reader, daemon=True) for _ in range(4)]
        for t in threads:
            t.start()
        for generation in range(1, 9):
            _apply_generation(generation)
        time.sleep(0.05)
        stop.set()
        for t in threads:
            t.join(timeout=10)

        self.assertEqual(violations[:3], [])
        self.assertGreater(len(reads), 8, 'readers must actually run while the apply transactions are open')


class SnapshotConnectionLifecycle(unittest.TestCase):
    """The read connection is closed on normal return, early return and error, and the read transaction is
    not kept open while a request does its in-memory work."""

    def setUp(self):
        _seed(0)
        self.conns = []
        real = sync_service.read_snapshot
        conns = self.conns

        @contextmanager
        def recording():
            with real() as conn:
                conns.append(conn)
                yield conn

        patcher = mock.patch.object(sync_service, 'read_snapshot', recording)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _all_closed(self):
        for conn in self.conns:
            with self.assertRaises(sqlite3.ProgrammingError):
                conn.execute('SELECT 1')

    def test_connection_closed_after_each_read_endpoint(self):
        calls = {
            'list': lambda: qs.list_work_items(qs.parse_list_params({})),
            'summary': lambda: qs.summary('all', 'Ada'),
            'children': lambda: qs.children(1),
            'batch': lambda: qs.batch('1,2'),
            'progress': lambda: qs.progress_for([1]),
            'kanban_none': lambda: qs.kanban(qs.parse_list_params({})),
            'kanban_parent': lambda: qs.kanban(qs.parse_list_params({'swimlane': 'parent'})),
        }
        for name, call in calls.items():
            with self.subTest(endpoint=name):
                del self.conns[:]
                call()
                self.assertEqual(len(self.conns), 1)
                self._all_closed()

    def test_connection_closed_on_early_return(self):
        self.assertIsNone(qs.children(999999))  # the parent does not exist: returns from inside the block
        self.assertEqual(len(self.conns), 1)
        self._all_closed()

    def test_connection_closed_when_the_request_fails(self):
        with mock.patch.object(sync_service, 'get_data_version', side_effect=RuntimeError('boom')):
            for call in (lambda: qs.list_work_items(qs.parse_list_params({})), lambda: qs.summary('all', ''),
                         lambda: qs.kanban(qs.parse_list_params({}))):
                del self.conns[:]
                with self.assertRaises(RuntimeError):
                    call()
                self.assertEqual(len(self.conns), 1)
                self._all_closed()

    def test_in_memory_work_runs_after_the_snapshot_is_closed(self):
        def assert_closed_then(real):
            def wrapper(*args, **kwargs):
                self._all_closed()
                return real(*args, **kwargs)
            return wrapper

        with mock.patch.object(qs, 'compute_progress_map', assert_closed_then(qs.compute_progress_map)), \
                mock.patch.object(qs, '_rows_to_items', assert_closed_then(qs._rows_to_items)):
            del self.conns[:]
            qs.progress_for([1])
            qs.kanban(qs.parse_list_params({'swimlane': 'parent'}))
            qs.list_work_items(qs.parse_list_params({}))
            qs.batch('1')
            qs.children(1)
        self.assertGreater(len(self.conns), 4)


if __name__ == '__main__':
    unittest.main()
