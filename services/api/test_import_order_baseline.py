"""Characterize staging cleanup under each import order in separate offline processes."""
import os
import contextlib
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

API_DIR = Path(__file__).resolve().parent


@unittest.skipUnless(os.name == 'posix', 'stale cleanup requires POSIX flock')
class ImportOrderTests(unittest.TestCase):
    def run_order(self, first, *, locked=False, unsupported=False):
        with tempfile.TemporaryDirectory(prefix='staging-import-') as root:
            stage = Path(root) / 'devops_stage.db'
            stage.write_text('synthetic stale stage', encoding='utf-8')
            env = {'PATH': os.defpath, 'PYTHONPATH': str(API_DIR), 'DEVOPS_DATA_DIR': root,
                   'DEVOPS_FIXTURE_MODE': '1', 'DISABLE_BACKGROUND_SYNC': '1',
                   'PYTHONDONTWRITEBYTECODE': '1'}
            lock = contextlib.nullcontext()
            if locked:
                import fcntl
                lock = open(Path(root) / 'devops_stage.lock', 'w')
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            script = textwrap.dedent('''
                import socket
                def blocked(*args, **kwargs): raise AssertionError('network disabled')
                socket.socket.connect = blocked
                import importlib, os, sys
                if sys.argv[2] == 'unsupported': sys.modules['fcntl'] = None
                importlib.import_module(sys.argv[1])
                import sync_service, sync_staging
                path = os.path.join(os.environ['DEVOPS_DATA_DIR'], 'devops_stage.db')
                print('stage_present=' + str(os.path.exists(path)))
                print('explicit_cleanup=' + str(sync_staging.cleanup_stale_stage()))
                print('after_cleanup=' + str(os.path.exists(path)))
                if os.path.exists(path):
                    with open(path, encoding='utf-8') as stage: print('contents=' + stage.read())
            ''')
            with lock:
                result = subprocess.run([sys.executable, '-c', script, first, 'unsupported' if unsupported else 'normal'], cwd=root, env=env,
                                        capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result

    def test_both_import_orders_cleanup_stale_stage(self):
        for first in ('sync_service', 'sync_staging'):
            with self.subTest(first=first):
                result = self.run_order(first)
                self.assertIn('stage_present=False', result.stdout)
                self.assertIn('explicit_cleanup=[]', result.stdout)
                self.assertIn('after_cleanup=False', result.stdout)
                self.assertNotIn('Stale staging cleanup skipped', result.stderr)

    def test_both_import_orders_preserve_locked_stage(self):
        for first in ('sync_service', 'sync_staging'):
            with self.subTest(first=first):
                result = self.run_order(first, locked=True)
                self.assertIn('stage_present=True', result.stdout)
                self.assertIn('explicit_cleanup=[]', result.stdout)
                self.assertIn('after_cleanup=True', result.stdout)
                self.assertIn('contents=synthetic stale stage', result.stdout)
                self.assertNotIn('Stale staging cleanup skipped', result.stderr)

    def test_both_import_orders_preserve_stage_without_flock(self):
        for first in ('sync_service', 'sync_staging'):
            with self.subTest(first=first):
                result = self.run_order(first, unsupported=True)
                self.assertIn('stage_present=True', result.stdout)
                self.assertIn('explicit_cleanup=[]', result.stdout)
                self.assertIn('after_cleanup=True', result.stdout)
                self.assertIn('contents=synthetic stale stage', result.stdout)
                self.assertNotIn('Stale staging cleanup skipped', result.stderr)
