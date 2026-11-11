import os
import sys
import time
import logging
from datetime import datetime
from pathlib import Path
from threading import Thread
from dotenv import load_dotenv

# Local development: load the repository-root .env (services/api -> repo root).
# Under Docker the variables come from compose env_file, so no file is needed.
api_dir = Path(__file__).resolve().parent
repo_root = api_dir.parent.parent

for candidate in (repo_root / '.env', api_dir / '.env'):
    if candidate.exists():
        load_dotenv(candidate)
        break

sys.path.insert(0, str(api_dir))

from app import app  # noqa: E402
import sync_service  # noqa: E402
import fixture_data  # noqa: E402

logger = logging.getLogger("run_backend")

SYNC_INTERVAL_SEC = int(os.environ.get('SYNC_INTERVAL_SEC', 300))
RECONCILE_INTERVAL_SEC = int(os.environ.get('RECONCILE_INTERVAL_SEC', 21600))


def _full_sync_due(last_full):
    """A full sync is due on first start, or when the last one is older than RECONCILE_INTERVAL_SEC (0 disables)."""
    if not last_full:
        return True
    if RECONCILE_INTERVAL_SEC <= 0:
        return False
    try:
        age = (datetime.utcnow() - datetime.fromisoformat(last_full).replace(tzinfo=None)).total_seconds()
    except ValueError:
        return True
    return age >= RECONCILE_INTERVAL_SEC


def background_sync_loop():
    """First start: full sync. Afterwards: incremental sync every SYNC_INTERVAL_SEC, with a periodic full
    reconcile every RECONCILE_INTERVAL_SEC (read-only against Azure DevOps)."""
    org_url = (os.environ.get('AZURE_DEVOPS_ORG_URL') or '').rstrip('/')
    pat = os.environ.get('AZURE_DEVOPS_PAT')
    if not org_url or not pat:
        logger.warning("Sync disabled: AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_PAT not configured.")
        return

    backoff = 5
    while True:
        try:
            force_full = _full_sync_due(sync_service.get_sync_meta('last_full_sync'))
            result = sync_service.sync_work_items(org_url, pat, force_full=force_full)
            status = result.get('status')
            if status == 'error':
                logger.warning("Sync failed, retrying in %ss", backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, max(SYNC_INTERVAL_SEC, 5))
                continue
            if status == 'partial':
                logger.warning("Sync finished partially: %s", result.get('message', ''))
            backoff = 5
        except Exception as ex:  # keep loop alive
            logger.error("Background sync crashed: %s", ex)
        time.sleep(SYNC_INTERVAL_SEC)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    host = os.environ.get('BIND_HOST', '127.0.0.1')
    if sync_service.is_fixture_mode():
        if not fixture_data.ensure_fixture_database():
            logger.error("refusing fixture mode on a database that contains non-fixture data")
            sys.exit(3)
        logger.info("Fixture mode: serving the offline fixture; Azure DevOps sync is disabled.")
    elif os.environ.get('DISABLE_BACKGROUND_SYNC') != '1':
        Thread(target=background_sync_loop, daemon=True).start()
    app.run(host=host, port=port, debug=False, threaded=True)
