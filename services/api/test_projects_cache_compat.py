"""Isolated compatibility tests for the legacy Flask response cache."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


API_DIR = Path(__file__).resolve().parent


class ProjectsCacheCompatibilityTests(unittest.TestCase):
    def test_app_cache_uses_patched_path_and_lock_for_reads_and_writes(self):
        with tempfile.TemporaryDirectory(prefix='projects-cache-compat-') as root:
            env = {
                'PATH': os.defpath,
                'PYTHONPATH': str(API_DIR),
                'DEVOPS_DATA_DIR': root,
                'DEVOPS_FIXTURE_MODE': '1',
                'DISABLE_BACKGROUND_SYNC': '1',
                'PYTHONDONTWRITEBYTECODE': '1',
            }
            body = textwrap.dedent('''
                import os
                import app

                class CountingLock:
                    def __init__(self): self.entries = 0
                    def __enter__(self): self.entries += 1
                    def __exit__(self, *args): pass

                expected_path = os.path.join(os.environ['DEVOPS_DATA_DIR'], 'patched-projects.db')
                lock = CountingLock()
                app.DB_PATH = expected_path
                app.db_lock = lock
                app.init_db()
                app.set_cache('synthetic-key', '{"value":1}')
                value, updated_at = app.get_cache('synthetic-key')
                assert value == '{"value":1}'
                assert updated_at
                assert app.get_cache('missing-key') == (None, None)
                assert os.path.exists(expected_path)
                assert lock.entries == 4
            ''')
            result = subprocess.run(
                [sys.executable, '-c', body], cwd=root, env=env,
                text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, f'{result.stdout}\n{result.stderr}')


if __name__ == '__main__':
    unittest.main()
