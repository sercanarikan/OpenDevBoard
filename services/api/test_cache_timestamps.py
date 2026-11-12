"""UTC cache timestamps are accepted in legacy and ISO 8601 formats."""
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import app as api_app


class CacheTimestampTests(unittest.TestCase):
    def test_devops_info_cache_accepts_naive_and_offset_utc_times(self):
        now = datetime.now(timezone.utc)
        values = [now.replace(tzinfo=None).isoformat(), now.astimezone(timezone(timedelta(hours=3))).isoformat()]
        for stamp in values:
            with self.subTest(stamp=stamp), patch.object(api_app, 'get_cache', return_value=(json.dumps({'fixture': True}), stamp)), \
                    patch.object(api_app, 'get_devops_org_url', side_effect=AssertionError('fresh cache should be used')):
                response = api_app.app.test_client().get('/api/devops-info')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json(), {'fixture': True})


class FullSyncTimestampTests(unittest.TestCase):
    def test_full_sync_due_handles_legacy_and_offset_timestamps(self):
        import run_backend
        now = datetime.now(timezone.utc)
        with patch.object(run_backend, 'RECONCILE_INTERVAL_SEC', 6 * 3600):
            for stamp in ((now - timedelta(hours=7)).replace(tzinfo=None).isoformat(),
                          (now - timedelta(hours=7)).astimezone(timezone(timedelta(hours=3))).isoformat()):
                with self.subTest(stamp=stamp):
                    self.assertTrue(run_backend._full_sync_due(stamp))
            self.assertFalse(run_backend._full_sync_due((now - timedelta(hours=1)).isoformat()))
