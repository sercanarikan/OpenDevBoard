import os
import sys
import time
import logging
from datetime import datetime, timedelta, timezone
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
INITIAL_FULL_PARTIAL_COUNT_META = 'initial_full_partial_count'
INITIAL_FULL_RETRY_AT_META = 'initial_full_retry_at'
INITIAL_FULL_BACKOFF_BASE_SEC = 600
INITIAL_FULL_BACKOFF_MAX_SEC = 3600


def _utcnow():
    return datetime.now(timezone.utc)


def _full_sync_due(last_full):
    """A full sync is due on first start, or when the last one is older than RECONCILE_INTERVAL_SEC (0 disables)."""
    if not last_full:
        return True
    if RECONCILE_INTERVAL_SEC <= 0:
        return False
    try:
        last = datetime.fromisoformat(last_full)
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - last).total_seconds()
    except ValueError:
        return True
    return age >= RECONCILE_INTERVAL_SEC


def _record_scheduler_result(result):
    """Persist backoff for repeated partial results from the initial full sync only."""
    status, mode = result.get('status'), result.get('mode')
    last_full = sync_service.get_sync_meta('last_full_sync')
    if status == 'success' and mode == 'full':
        sync_service.set_sync_meta_many({INITIAL_FULL_PARTIAL_COUNT_META: 0,
                                         INITIAL_FULL_RETRY_AT_META: ''})
        return None
    if status != 'partial' or mode != 'full' or last_full:
        return None

    try:
        partial_count = max(0, int(sync_service.get_sync_meta(INITIAL_FULL_PARTIAL_COUNT_META, '0')))
    except (TypeError, ValueError):
        partial_count = 0
    partial_count += 1
    exponent = min(partial_count - 1, 3)
    delay = min(INITIAL_FULL_BACKOFF_BASE_SEC * (2 ** exponent), INITIAL_FULL_BACKOFF_MAX_SEC)
    retry_at = (_utcnow() + timedelta(seconds=delay)).isoformat()
    sync_service.set_sync_meta_many({INITIAL_FULL_PARTIAL_COUNT_META: partial_count,
                                     INITIAL_FULL_RETRY_AT_META: retry_at})
    return delay


def _wait_for_initial_full_retry():
    """Honor a persisted initial-full retry deadline after a process restart."""
    if sync_service.get_sync_meta('last_full_sync'):
        return
    retry_at = sync_service.get_sync_meta(INITIAL_FULL_RETRY_AT_META)
    if not retry_at:
        return
    try:
        retry = datetime.fromisoformat(retry_at)
        if retry.tzinfo is None:
            retry = retry.replace(tzinfo=timezone.utc)
        remaining = (retry - _utcnow()).total_seconds()
    except (TypeError, ValueError):
        return
    if remaining > 0:
        time.sleep(remaining)


def background_sync_loop():
    """First start: full sync. Afterwards: incremental sync every SYNC_INTERVAL_SEC, with a periodic full
    reconcile every RECONCILE_INTERVAL_SEC (read-only against Azure DevOps)."""
    org_url = (os.environ.get('AZURE_DEVOPS_ORG_URL') or '').rstrip('/')
    pat = os.environ.get('AZURE_DEVOPS_PAT')
    if not org_url or not pat:
        logger.warning("Sync disabled: AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_PAT not configured.")
        return

    backoff = 5
    _wait_for_initial_full_retry()
    while True:
        delay = SYNC_INTERVAL_SEC
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
            partial_delay = _record_scheduler_result(result)
            if partial_delay is not None:
                delay = partial_delay
                logger.warning("Initial full sync remains partial; next attempt in %ss", delay)
            backoff = 5
        except Exception as ex:  # keep loop alive
            logger.error("Background sync crashed: %s", ex)
        time.sleep(delay)


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
