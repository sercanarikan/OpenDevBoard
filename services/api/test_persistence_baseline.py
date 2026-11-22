"""Isolated process contracts for cache path, locks, connection and snapshot ownership.

The tests record current behavior and do not endorse sharing files or separate locks as a design.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

API_DIR = Path(__file__).resolve().parent


class PersistenceProcessTests(unittest.TestCase):
    def run_isolated(self, body, *, shared=False):
        with tempfile.TemporaryDirectory(prefix='persistence-baseline-') as root:
            cwd = Path(root) / 'cwd'
            data = cwd if shared else Path(root) / 'data'
            cwd.mkdir()
            data.mkdir(exist_ok=True)
            env = {'PATH': os.defpath, 'PYTHONPATH': str(API_DIR), 'DEVOPS_DATA_DIR': str(data),
                   'DEVOPS_FIXTURE_MODE': '1', 'DISABLE_BACKGROUND_SYNC': '1',
                   'PYTHONDONTWRITEBYTECODE': '1'}
            script = 'import socket\ndef blocked(*a, **kw): raise AssertionError("network disabled")\nsocket.socket.connect = blocked\n' + textwrap.dedent(body)
            result = subprocess.run([sys.executable, '-c', script], cwd=cwd, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, f'{result.stdout}\n{result.stderr}')

    def test_shared_connection_configuration_and_dynamic_path(self):
        self.run_isolated('''
            import os, sqlite3, persistence, sync_service as s
            assert s.db_lock is persistence.db_lock
            s.DB_PATH = os.path.join(os.environ['DEVOPS_DATA_DIR'], 'other.db')
            conn = s.get_db_connection()
            assert conn.row_factory is sqlite3.Row
            assert conn.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
            assert conn.execute('PRAGMA busy_timeout').fetchone()[0] == 5000
            assert os.path.realpath(conn.execute('PRAGMA database_list').fetchone()[2]) == os.path.realpath(s.DB_PATH)
            conn.close()
        ''')

    def test_feature_initializers_honor_compatibility_patches(self):
        self.run_isolated('''
            import os
            from unittest.mock import patch
            import sync_service as s
            import pipeline_service, deployment_service, pr_service, team_service, history_service
            s.DB_PATH = os.path.join(os.environ['DEVOPS_DATA_DIR'], 'features.db')
            s.init_db()
            class RecordingLock:
                def __init__(self): self.entries = 0
                def __enter__(self): self.entries += 1
                def __exit__(self, *args): pass
            lock = RecordingLock()
            initializers = (pipeline_service.init_pipeline_db, deployment_service.init_deployment_db,
                            pr_service.init_pr_db, team_service.init_team_db, history_service.init_history_db)
            with patch.object(s, 'db_lock', lock), patch.object(s, 'get_db_connection', wraps=s.get_db_connection) as connect:
                for initialize in initializers: initialize()
                assert connect.call_count == len(initializers)
                assert lock.entries == len(initializers)
            with s.get_db_connection() as conn:
                names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert {'pipeline_runs', 'work_items'} <= names
        ''')

    def test_distinct_and_shared_cache_paths_use_separate_locks(self):
        for shared in (False, True):
            with self.subTest(shared=shared):
                self.run_isolated('''
                    import os, sqlite3, app, sync_service
                    same = os.path.realpath(app.DB_PATH) == os.path.realpath(sync_service.DB_PATH)
                    assert same == EXPECTED
                    assert app.db_lock is not sync_service.db_lock
                    app.set_cache('synthetic', '{"ok":true}')
                    assert app.get_cache('synthetic')[0] == '{"ok":true}'
                    with sqlite3.connect(sync_service.DB_PATH) as c:
                        names = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    assert 'work_items' in names
                    assert ('projects_cache' in names) == EXPECTED
                '''.replace('EXPECTED', repr(shared)), shared=shared)

    def test_connection_context_commits_rolls_back_but_does_not_close(self):
        self.run_isolated('''
            import sqlite3, sync_service as s
            c = s.get_db_connection()
            with c:
                c.execute("CREATE TABLE baseline (value TEXT)")
                c.execute("INSERT INTO baseline VALUES ('committed')")
            try:
                with c:
                    c.execute("INSERT INTO baseline VALUES ('rolled back')")
                    raise ValueError('synthetic failure')
            except ValueError:
                pass
            assert c.execute('SELECT value FROM baseline').fetchall()[0][0] == 'committed'
            assert c.execute('SELECT count(*) FROM baseline').fetchone()[0] == 1
            c.close()
            try: c.execute('SELECT 1')
            except sqlite3.ProgrammingError: pass
            else: raise AssertionError('connection remained usable after close')
        ''')

    def test_snapshot_pins_committed_state_and_closes(self):
        self.run_isolated('''
            import sqlite3, sync_service as s
            with s.get_db_connection() as writer:
                writer.execute('CREATE TABLE baseline (value INTEGER)')
                writer.execute('INSERT INTO baseline VALUES (1)')
            writer.close()
            with s.read_snapshot() as reader:
                assert reader.execute('SELECT value FROM baseline').fetchone()[0] == 1
                writer = s.get_db_connection()
                with writer: writer.execute('UPDATE baseline SET value = 2')
                writer.close()
                assert reader.execute('SELECT value FROM baseline').fetchone()[0] == 1
            try: reader.execute('SELECT 1')
            except sqlite3.ProgrammingError: pass
            else: raise AssertionError('snapshot did not close')
            with s.read_snapshot() as newer:
                assert newer.execute('SELECT value FROM baseline').fetchone()[0] == 2
        ''')
