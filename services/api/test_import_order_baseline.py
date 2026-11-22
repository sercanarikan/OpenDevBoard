"""Characterize staging cleanup under each import order in separate offline processes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

API_DIR = Path(__file__).resolve().parent


@unittest.skipUnless(os.name == 'posix', 'stale cleanup requires POSIX flock')
class ImportOrderTests(unittest.TestCase):
    def run_order(self, first):
        with tempfile.TemporaryDirectory(prefix='staging-import-') as root:
            stage = Path(root) / 'devops_stage.db'
            stage.write_text('synthetic stale stage', encoding='utf-8')
            env = {'PATH': os.defpath, 'PYTHONPATH': str(API_DIR), 'DEVOPS_DATA_DIR': root,
                   'DEVOPS_FIXTURE_MODE': '1', 'DISABLE_BACKGROUND_SYNC': '1',
                   'PYTHONDONTWRITEBYTECODE': '1'}
            script = textwrap.dedent('''
                import socket
                def blocked(*args, **kwargs): raise AssertionError('network disabled')
                socket.socket.connect = blocked
                import importlib, os, sys
                importlib.import_module(sys.argv[1])
                import sync_service, sync_staging
                path = os.path.join(os.environ['DEVOPS_DATA_DIR'], 'devops_stage.db')
                print('stage_present=' + str(os.path.exists(path)))
                print('explicit_cleanup=' + str(sync_staging.cleanup_stale_stage()))
                print('after_cleanup=' + str(os.path.exists(path)))
            ''')
            result = subprocess.run([sys.executable, '-c', script, first], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('after_cleanup=False', result.stdout)
            return result

    def test_sync_first_performs_boot_cleanup(self):
        result = self.run_order('sync_service')
        self.assertIn('stage_present=False', result.stdout)
        self.assertIn('explicit_cleanup=[]', result.stdout)

    def test_staging_first_currently_skips_boot_cleanup(self):
        result = self.run_order('sync_staging')
        self.assertIn('stage_present=True', result.stdout)
        self.assertIn('devops_stage.db', result.stdout)
        self.assertIn('Stale staging cleanup skipped', result.stderr)
