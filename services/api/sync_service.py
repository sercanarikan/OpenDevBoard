"""SQLite cache + Azure DevOps sync engine (read-only towards Azure DevOps).

Row classes in ``work_items``:
  * in scope  : is_context = 0. Returned by the "active" WIQL (full sync) or by a changed-since query (incremental).
                is_active = 0 when the item reached a terminal / removed state while we still keep it (completed work).
  * context   : is_context = 1. Cached only because an in-scope item points at it (ancestor, descendant needed for
                progress, dependency / related target). Never listed or counted as work, only used for hierarchy,
                canonical progress and relation snapshots.
  * deleted   : deleted_at IS NOT NULL (soft delete). Invisible everywhere; rows are never hard-deleted.
"""
import os
import json
import sqlite3
import logging
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from dateutil import parser as dtparser
from threading import Lock, RLock
import requests
from base64 import b64encode

import azure_client

logger = logging.getLogger("sync_service")

DATA_DIR = os.environ.get('DEVOPS_DATA_DIR') or os.path.dirname(__file__)
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, 'devops_cache.db')
db_lock = RLock()
sync_lock = Lock()

_sleep = time.sleep

MAX_CLOSURE_ROUNDS = 12
MAX_CONTEXT_ITEMS = 25000
MASS_DELETE_FLOOR = 50
MASS_DELETE_RATIO = 0.10
MAX_WARNINGS = 20

SCOPE_WHERE = "[System.State] NOT IN ('Closed', 'Completed', 'Done', 'Removed')"


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.execute('PRAGMA busy_timeout=5000;')
    return conn


def init_db():
    with db_lock, get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS work_items (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                type TEXT NOT NULL,
                state TEXT NOT NULL,
                project TEXT NOT NULL,
                assigned_to TEXT,
                assigned_avatar TEXT,
                priority INTEGER DEFAULT 3,
                iteration TEXT,
                area_path TEXT,
                parent_id INTEGER,
                parent_title TEXT,
                parent_type TEXT,
                story_points REAL,
                changed_date TEXT,
                created_date TEXT,
                is_bug INTEGER DEFAULT 0,
                is_task INTEGER DEFAULT 0,
                is_unassigned INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                is_blocked INTEGER DEFAULT 0,
                is_blocking INTEGER DEFAULT 0,
                url TEXT,
                description TEXT,
                relations_json TEXT,
                last_synced_at TEXT
            )
        ''')

        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_project ON work_items(project)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_assigned ON work_items(assigned_to)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_state ON work_items(state)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_active ON work_items(is_active)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_priority ON work_items(priority)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_changed ON work_items(changed_date)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_parent ON work_items(parent_id)')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                val TEXT,
                updated_at TEXT
            )
        ''')

        existing_cols = {r['name'] for r in cursor.execute('PRAGMA table_info(work_items)').fetchall()}
        for col, ddl in (
            ('deleted_at', 'TEXT'),
            ('last_seen_at', 'TEXT'),
            ('is_context', 'INTEGER DEFAULT 0'),
        ):
            if col not in existing_cols:
                cursor.execute(f'ALTER TABLE work_items ADD COLUMN {col} {ddl}')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_deleted ON work_items(deleted_at)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_wi_parent_deleted ON work_items(parent_id, deleted_at)')
        cursor.execute(
            'CREATE INDEX IF NOT EXISTS idx_wi_scope ON work_items(is_active, is_context, deleted_at, project)'
        )

        # A sync that was killed mid-run must not leave the status stuck at 'syncing'.
        cursor.execute(
            "UPDATE sync_state SET val = 'idle', updated_at = ? WHERE key = 'sync_status' AND val = 'syncing'",
            (_utcnow().isoformat(),),
        )
        conn.commit()


init_db()


def get_sync_meta(key, default=None):
    with db_lock, get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT val FROM sync_state WHERE key = ?', (key,))
        row = cursor.fetchone()
        return row['val'] if row else default


def set_sync_meta(key, val):
    now_iso = _utcnow().isoformat()
    with db_lock, get_db_connection() as conn:
        _set_meta(conn, key, val, now_iso)
        conn.commit()


def _set_meta(conn, key, val, now_iso=None):
    conn.execute('''
        INSERT INTO sync_state (key, val, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at
    ''', (key, str(val), now_iso or _utcnow().isoformat()))


# Terminal states where item is deemed completed (Resolved is NOT completed).
TERMINAL_STATES = {'done', 'closed', 'completed'}


def is_state_completed(state, w_type=''):
    s = (state or '').strip().lower()
    return s in TERMINAL_STATES


def is_state_out_of_active_scope(state):
    """Completed or removed work leaves the active scope (is_active = 0)."""
    s = (state or '').strip().lower()
    return s in TERMINAL_STATES or s == 'removed'


def is_fixture_mode():
    return os.environ.get('DEVOPS_FIXTURE_MODE') == '1'


def get_devops_headers(pat):
    token = b64encode(f':{pat}'.encode()).decode()
    return {
        'Authorization': f'Basic {token}',
        'Content-Type': 'application/json'
    }


# ----------------------------------------------------------------------------------------------
# Parsing
# ----------------------------------------------------------------------------------------------

def _rel_target_id(url):
    try:
        return int(url.rstrip('/').split('/')[-1])
    except Exception:
        return None


def parse_work_item(item, org_url):
    """Converts a raw Azure DevOps work item (with relations) into a cache row.

    Besides the column values it returns the link ids needed by the sync closure:
    ``_child_ids`` (hierarchy children), ``_hier_ids`` (parent) and ``_dep_ids`` (dependency / related targets).
    """
    item_id = item.get("id")
    fields = item.get("fields", {})
    title = (fields.get("System.Title") or "").strip()
    w_type = (fields.get("System.WorkItemType") or "Task").strip()
    state = (fields.get("System.State") or "Active").strip()
    project = (fields.get("System.TeamProject") or "General").strip()
    parent_id = fields.get("System.Parent")
    changed_date = fields.get("System.ChangedDate", "")
    created_date = fields.get("System.CreatedDate", "")
    priority = fields.get("Microsoft.VSTS.Common.Priority", 3)

    assigned_obj = fields.get("System.AssignedTo")
    assigned_name = ""
    assigned_avatar = ""
    if assigned_obj:
        if isinstance(assigned_obj, dict):
            assigned_name = (assigned_obj.get("displayName") or "").strip()
            assigned_avatar = assigned_obj.get("_links", {}).get("avatar", {}).get("href", "")
        else:
            assigned_name = str(assigned_obj).strip()
    is_unassigned = not bool(assigned_name) or assigned_name.lower() == 'unassigned'

    predecessors, successors, related = [], [], []
    child_ids, dep_ids = [], []
    for r in item.get("relations") or []:
        r_url = r.get("url", "")
        r_rel = r.get("rel", "")
        r_name = (r.get("attributes") or {}).get("name", "")
        r_comment = (r.get("attributes") or {}).get("comment", "")
        if "/workitems/" not in r_url.lower():
            continue
        target_id = _rel_target_id(r_url)
        if target_id is None:
            continue

        if r_rel == "System.LinkTypes.Hierarchy-Forward":
            child_ids.append(target_id)
            continue
        if r_rel == "System.LinkTypes.Hierarchy-Reverse":
            if not parent_id:
                parent_id = target_id
            continue

        entry = {
            "id": target_id,
            "relType": "other",
            "relName": r_name,
            "comment": r_comment,
            "url": f"{org_url}/{project}/_workitems/edit/{target_id}"
        }
        if r_rel == "System.LinkTypes.Dependency-Reverse" or r_name == "Predecessor":
            entry["relType"], entry["relName"] = "predecessor", "Predecessor"
            predecessors.append(entry)
            dep_ids.append(target_id)
        elif r_rel == "System.LinkTypes.Dependency-Forward" or r_name == "Successor":
            entry["relType"], entry["relName"] = "successor", "Successor"
            successors.append(entry)
            dep_ids.append(target_id)
        elif r_rel == "System.LinkTypes.Related" or r_name == "Related":
            entry["relType"], entry["relName"] = "related", "Related"
            related.append(entry)
            dep_ids.append(target_id)

    story_points = fields.get("Microsoft.VSTS.Scheduling.StoryPoints")
    url = item.get("_links", {}).get("html", {}).get("href") or f"{org_url}/{project}/_workitems/edit/{item_id}"

    return {
        "id": item_id,
        "title": title,
        "type": w_type,
        "state": state,
        "project": project,
        "assigned_to": "Unassigned" if is_unassigned else assigned_name,
        "assigned_avatar": assigned_avatar,
        "priority": int(priority) if isinstance(priority, (int, float)) and 1 <= priority <= 4 else 3,
        "iteration": fields.get("System.IterationPath", ""),
        "area_path": fields.get("System.AreaPath", ""),
        "parent_id": int(parent_id) if parent_id else None,
        "parent_title": None,
        "parent_type": None,
        "story_points": float(story_points) if story_points is not None else None,
        "changed_date": changed_date,
        "created_date": created_date,
        "is_bug": 1 if "bug" in w_type.lower() else 0,
        "is_task": 1 if "task" in w_type.lower() else 0,
        "is_unassigned": 1 if is_unassigned else 0,
        "is_active": 0 if is_state_out_of_active_scope(state) else 1,
        "is_blocked": 0,
        "is_blocking": 0,
        "url": url,
        "relations": {
            "predecessors": predecessors,
            "successors": successors,
            "related": related,
            "total": len(predecessors) + len(successors) + len(related)
        },
        "_child_ids": child_ids,
        "_dep_ids": dep_ids,
    }


_UPSERT_COLUMNS = (
    "id, title, type, state, project, assigned_to, assigned_avatar, priority, iteration, area_path, "
    "parent_id, parent_title, parent_type, story_points, changed_date, created_date, is_bug, is_task, "
    "is_unassigned, is_active, is_blocked, is_blocking, url, relations_json, last_synced_at, "
    "last_seen_at, deleted_at, is_context"
)

_UPSERT_UPDATE = '''
    title = excluded.title,
    type = excluded.type,
    state = excluded.state,
    project = excluded.project,
    assigned_to = excluded.assigned_to,
    assigned_avatar = COALESCE(NULLIF(excluded.assigned_avatar, ''), work_items.assigned_avatar),
    priority = excluded.priority,
    iteration = excluded.iteration,
    area_path = excluded.area_path,
    parent_id = excluded.parent_id,
    parent_title = COALESCE(excluded.parent_title, work_items.parent_title),
    parent_type = COALESCE(excluded.parent_type, work_items.parent_type),
    story_points = excluded.story_points,
    changed_date = excluded.changed_date,
    created_date = COALESCE(excluded.created_date, work_items.created_date),
    is_bug = excluded.is_bug,
    is_task = excluded.is_task,
    is_unassigned = excluded.is_unassigned,
    is_active = excluded.is_active,
    url = excluded.url,
    relations_json = excluded.relations_json,
    last_synced_at = excluded.last_synced_at,
    last_seen_at = excluded.last_seen_at,
    deleted_at = NULL,
    is_context = excluded.is_context
'''

_UPSERT_MAIN_SQL = (
    f"INSERT INTO work_items ({_UPSERT_COLUMNS}) VALUES ({', '.join('?' for _ in range(28))}) "
    f"ON CONFLICT(id) DO UPDATE SET {_UPSERT_UPDATE}"
)

# Context data must never overwrite an in-scope active row: only context rows, inactive/completed rows, or hollow rows are refreshed.
_UPSERT_CONTEXT_SQL = (
    f"INSERT INTO work_items ({_UPSERT_COLUMNS}) VALUES ({', '.join('?' for _ in range(28))}) "
    f"ON CONFLICT(id) DO UPDATE SET {_UPSERT_UPDATE} WHERE work_items.is_context = 1 OR work_items.is_active = 0 OR work_items.relations_json IS NULL"
)


def _row_params(item, now_iso, is_context):
    return (
        item["id"], item["title"], item["type"], item["state"], item["project"],
        item["assigned_to"], item["assigned_avatar"], item["priority"], item["iteration"],
        item["area_path"], item["parent_id"], item["parent_title"], item["parent_type"],
        item["story_points"], item["changed_date"], item["created_date"], item["is_bug"],
        item["is_task"], item["is_unassigned"], item["is_active"], item["is_blocked"],
        item["is_blocking"], item["url"], json.dumps(item["relations"]), now_iso,
        now_iso, None, 1 if is_context else 0
    )


# ----------------------------------------------------------------------------------------------
# Derived data (relation snapshots, blocked / blocking flags, parent titles)
# ----------------------------------------------------------------------------------------------

def recompute_derived(conn):
    """Refreshes denormalised relation snapshots and the is_blocked / is_blocking flags from the cache itself.

    Runs inside the sync transaction, so a predecessor that became Done (or was deleted) is reflected on dependents
    that were not re-fetched. Rule: blocked = at least one predecessor whose state is KNOWN and not
    Done/Closed/Completed (Resolved is NOT completed). A predecessor whose state could not be resolved (target
    missing, deleted or inaccessible) is UNKNOWN: it neither blocks nor clears an item, and is reported through
    `hasUnresolvedPredecessors` so the UI can say so explicitly instead of inventing a state.
    blocking = has at least one successor.
    """
    rows = conn.execute('''
        SELECT id, title, type, state, project, assigned_to, parent_id, parent_title, parent_type,
               relations_json, is_blocked, is_blocking
        FROM work_items WHERE deleted_at IS NULL
    ''').fetchall()
    by_id = {r['id']: r for r in rows}
    stats = {"rows_scanned": len(rows), "rows_updated": 0, "newly_unblocked": 0, "newly_blocked": 0}

    updates = []
    for r in rows:
        relations = {}
        if r['relations_json']:
            try:
                relations = json.loads(r['relations_json'])
            except Exception:
                relations = {}
        preds = relations.get('predecessors') or []
        succs = relations.get('successors') or []
        related = relations.get('related') or []

        changed = False
        for entry in preds + succs + related:
            target = by_id.get(entry.get('id'))
            if target is None:
                continue
            snapshot = {
                'title': target['title'], 'type': target['type'], 'state': target['state'],
                'assignedTo': target['assigned_to'] or '', 'project': target['project']
            }
            for k, v in snapshot.items():
                if entry.get(k) != v:
                    entry[k] = v
                    changed = True

        blocked = 0
        for p in preds:
            state = p.get('state')
            if state is None or str(state).strip() == '':
                continue  # unknown: neither blocking nor resolved
            if not is_state_completed(state, p.get('type')):
                blocked = 1
                break
        blocking = 1 if len(succs) > 0 else 0

        parent_title, parent_type = r['parent_title'], r['parent_type']
        parent = by_id.get(r['parent_id']) if r['parent_id'] else None
        if parent is not None:
            parent_title, parent_type = parent['title'], parent['type']

        if (changed or blocked != (r['is_blocked'] or 0) or blocking != (r['is_blocking'] or 0)
                or parent_title != r['parent_title'] or parent_type != r['parent_type']):
            if changed:
                relations['total'] = len(preds) + len(succs) + len(related)
            if blocked != (r['is_blocked'] or 0):
                stats['newly_blocked' if blocked else 'newly_unblocked'] += 1
            updates.append((json.dumps(relations) if (changed and relations) else r['relations_json'],
                            blocked, blocking, parent_title, parent_type, r['id']))

    if updates:
        conn.executemany(
            'UPDATE work_items SET relations_json = ?, is_blocked = ?, is_blocking = ?, parent_title = ?, '
            'parent_type = ? WHERE id = ?', updates)
    stats['rows_updated'] = len(updates)
    return stats


def _find_orphan_context_ids(conn):
    """Context rows that no in-scope row needs any more.

    Needed = in-scope rows, their ancestors, every descendant of those (completed children count for progress)
    and the relation targets of in-scope rows.
    """
    rows = conn.execute(
        'SELECT id, parent_id, is_context, relations_json FROM work_items WHERE deleted_at IS NULL'
    ).fetchall()
    parent = {r['id']: r['parent_id'] for r in rows}
    children = defaultdict(list)
    for rid, pid in parent.items():
        if pid in parent:
            children[pid].append(rid)

    needed = set()
    scope_rows = [r for r in rows if not r['is_context']]
    for r in scope_rows:
        cur, seen = r['id'], set()
        while cur and cur in parent and cur not in seen:
            seen.add(cur)
            needed.add(cur)
            cur = parent[cur]

    stack = list(needed)
    while stack:
        n = stack.pop()
        for c in children.get(n, ()):
            if c not in needed:
                needed.add(c)
                stack.append(c)

    for r in scope_rows:
        if not r['relations_json']:
            continue
        try:
            rel = json.loads(r['relations_json'])
        except Exception:
            continue
        for key in ('predecessors', 'successors', 'related'):
            for e in rel.get(key) or []:
                if e.get('id') in parent:
                    needed.add(e['id'])

    return [r['id'] for r in rows if r['is_context'] and r['id'] not in needed]


# ----------------------------------------------------------------------------------------------
# Sync
# ----------------------------------------------------------------------------------------------

class _Run:
    """Mutable bookkeeping for one sync run."""

    def __init__(self, mode):
        self.mode = mode
        self.started = _utcnow()
        self.warnings = []
        self.complete = True  # becomes False for anything that makes the run partial
        self.fetched = 0
        self.upserted = 0
        self.deleted = 0
        self.out_of_scope = 0
        self.context_upserted = 0
        self.orphans_removed = 0
        self.skipped = 0
        self.partitions = 1
        self.derived = None
        self.total_scope = None

    def warn(self, msg, partial=False):
        if len(self.warnings) < MAX_WARNINGS:
            self.warnings.append(msg)
        if partial:
            self.complete = False

    def result(self, status, error=None):
        finished = _utcnow()
        return {
            "mode": self.mode,
            "status": status,
            "fetched": self.fetched,
            "upserted": self.upserted,
            "deleted": self.deleted,
            "out_of_scope": self.out_of_scope,
            "context_upserted": self.context_upserted,
            "orphans_removed": self.orphans_removed,
            "skipped": self.skipped,
            "partitions": self.partitions,
            "warnings": list(self.warnings),
            "derived": self.derived,
            "duration_ms": int((finished - self.started).total_seconds() * 1000),
            "started_at": self.started.isoformat(),
            "finished_at": finished.isoformat(),
            "error": error,
        }


class SyncError(Exception):
    pass


def _alive_ids(conn=None):
    owns = conn is None
    conn = conn or get_db_connection()
    try:
        return {r['id'] for r in conn.execute(
            'SELECT id FROM work_items WHERE deleted_at IS NULL AND relations_json IS NOT NULL'
        )}
    finally:
        if owns:
            conn.close()


def _collect_context(client, org_url, main_rows, run, alive):
    """Fetches ancestors, descendants (needed for canonical progress) and dependency targets that are not cached."""
    known = {r['id'] for r in main_rows}
    context = {}
    frontier = list(main_rows)
    dep_only = {}

    for _ in range(MAX_CLOSURE_ROUNDS):
        want_hier, want_dep = set(), set()
        for r in frontier:
            if r['parent_id']:
                want_hier.add(r['parent_id'])
            want_hier.update(r['_child_ids'])
            want_dep.update(r['_dep_ids'])

        skip = known | set(context) | alive | set(dep_only)
        want_hier -= skip
        want_dep -= skip | want_hier
        if not want_hier and not want_dep:
            break

        if len(context) + len(dep_only) + len(want_hier) + len(want_dep) > MAX_CONTEXT_ITEMS:
            run.warn(f"context_cap_reached:{MAX_CONTEXT_ITEMS}", partial=True)
            break

        ids = sorted(want_hier | want_dep)
        fr = client.get_items(ids, expand_relations=True, error_policy_omit=True)
        if fr.failed_batches:
            run.warn(f"context_fetch_failed:{sum(len(b) for b in fr.failed_batches)}", partial=True)
        if fr.missing:
            run.warn(f"context_missing:{len(fr.missing)}")  # dangling link (deleted / inaccessible), not a data gap

        frontier = []
        for item_id, raw in fr.items.items():
            row = parse_work_item(raw, org_url)
            if item_id in want_hier:
                context[item_id] = row
                frontier.append(row)
            else:
                dep_only[item_id] = row
    else:
        run.warn("context_rounds_exhausted", partial=True)

    rows = list(context.values()) + list(dep_only.values())
    return rows


def _plan_reconciliation(client, org_url, scope_ids, run):
    """Finds cached in-scope rows that the full WIQL no longer returns and classifies them without trusting absence.

    Returns (rows_to_upsert, ids_to_soft_delete).
    """
    with db_lock, get_db_connection() as conn:
        cached_scope = {
            r['id'] for r in conn.execute(
                'SELECT id FROM work_items WHERE deleted_at IS NULL AND is_active = 1 AND is_context = 0')
        }
    candidates = sorted(cached_scope - scope_ids)
    if not candidates:
        return [], []

    limit = max(MASS_DELETE_FLOOR, int(len(cached_scope) * MASS_DELETE_RATIO))
    if len(candidates) > limit:
        run.warn(f"mass_delete_blocked:{len(candidates)}>{limit}", partial=True)
        return [], []

    fr = client.get_items(candidates, expand_relations=True, error_policy_omit=True)
    if fr.failed_batches:
        run.warn(f"reconcile_fetch_failed:{sum(len(b) for b in fr.failed_batches)}", partial=True)
        # Absence is unknown for failed batches: rows are untouched and nothing is deleted this run.
        rows = [parse_work_item(raw, org_url) for raw in fr.items.values()]
        return rows, []

    rows = [parse_work_item(raw, org_url) for raw in fr.items.values()]
    return rows, list(fr.missing)


def _fetch_phase(org_url, pat, run, force_full, max_items, client):
    last_watermark = get_sync_meta('watermark')
    is_incremental = bool(last_watermark) and not force_full
    run.mode = 'incremental' if is_incremental else 'full'

    if is_incremental:
        # WIQL compares System.ChangedDate with DATE precision: a time component returns HTTP 400. Query from the
        # watermark's day minus one (controlled overlap); upserts are idempotent.
        try:
            wm_str = (dtparser.parse(last_watermark) - timedelta(days=1)).strftime('%Y-%m-%d')
        except Exception:
            wm_str = (_utcnow() - timedelta(days=2)).strftime('%Y-%m-%d')
        where = f"[System.ChangedDate] >= '{wm_str}'"
        logger.info("Running incremental sync since %s...", wm_str)
    else:
        where = SCOPE_WHERE
        logger.info("Running full sync for all active work items...")

    collected = client.collect_ids(where)
    run.partitions = collected.partitions
    for w in collected.warnings:
        run.warn(w)
    ids = list(collected.ids)
    run.total_scope = len(ids)

    truncated = False
    if max_items is not None and len(ids) > max_items:
        run.warn(f"truncated_by_max_items:{max_items}/{len(ids)}", partial=True)
        ids = ids[:max_items]
        truncated = True

    main_rows = []
    returned_ids = set()
    if ids:
        fr = client.get_items(ids, expand_relations=True, error_policy_omit=True)
        if fr.failed_batches:
            raise SyncError(f"details_fetch_failed:{sum(len(b) for b in fr.failed_batches)} ids "
                            f"({'; '.join(fr.errors[:2])})")
        if fr.missing:
            run.warn(f"missing_detail:{len(fr.missing)}")
        for raw in fr.items.values():
            main_rows.append(parse_work_item(raw, org_url))
        returned_ids = set(fr.items)
    run.fetched = len(main_rows)

    with db_lock:
        alive = _alive_ids()
    context_rows = _collect_context(client, org_url, main_rows, run, alive)

    # Reconcile hollow / unverified cached rows (missing relations or last_seen_at) during full sync
    if not is_incremental and run.complete and not truncated:
        with db_lock, get_db_connection() as conn:
            hollow_ids = [r['id'] for r in conn.execute(
                'SELECT id FROM work_items WHERE deleted_at IS NULL AND (relations_json IS NULL OR last_seen_at IS NULL)'
            ).fetchall()]
        hollow_needed = [i for i in hollow_ids if i not in returned_ids and i not in {r['id'] for r in context_rows}]
        if hollow_needed:
            fr_hollow = client.get_items(hollow_needed, expand_relations=True, error_policy_omit=True)
            for raw in fr_hollow.items.values():
                context_rows.append(parse_work_item(raw, org_url))

    reconcile_rows, delete_ids = [], []
    if not is_incremental and run.complete and not truncated:
        reconcile_rows, delete_ids = _plan_reconciliation(client, org_url, set(ids) | returned_ids, run)
        for r in reconcile_rows:
            if r['is_active'] == 0:
                run.out_of_scope += 1

    return {
        "is_incremental": is_incremental,
        "ids": ids,
        "main_rows": main_rows + reconcile_rows,
        "context_rows": context_rows,
        "delete_ids": delete_ids,
        "last_watermark": last_watermark,
    }


def _apply_phase(plan, run):
    """Writes everything in ONE SQLite transaction. Any exception rolls back and leaves the previous snapshot."""
    now_iso = _utcnow().isoformat()
    main_rows = plan["main_rows"]
    new_watermark = plan["last_watermark"]
    for r in main_rows:
        cd = r.get("changed_date")
        if cd and (not new_watermark or cd > new_watermark):
            new_watermark = cd

    conn = get_db_connection()
    conn.isolation_level = None
    try:
        with db_lock:
            conn.execute('BEGIN IMMEDIATE')
            try:
                seen = set()
                for r in main_rows:
                    if r['id'] in seen:
                        run.skipped += 1
                        continue
                    seen.add(r['id'])
                    conn.execute(_UPSERT_MAIN_SQL, _row_params(r, now_iso, False))
                run.upserted = len(seen)

                ctx_count = 0
                for r in plan["context_rows"]:
                    if r['id'] in seen:
                        continue
                    conn.execute(_UPSERT_CONTEXT_SQL, _row_params(r, now_iso, True))
                    ctx_count += 1
                run.context_upserted = ctx_count

                if plan["delete_ids"] and run.complete:
                    conn.executemany('UPDATE work_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
                                     [(now_iso, i) for i in plan["delete_ids"]])
                    run.deleted = len(plan["delete_ids"])

                if not plan["is_incremental"] and run.complete:
                    orphans = _find_orphan_context_ids(conn)
                    if orphans:
                        conn.executemany('UPDATE work_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
                                         [(now_iso, i) for i in orphans])
                    run.orphans_removed = len(orphans)

                run.derived = recompute_derived(conn)

                if run.complete:
                    if new_watermark:
                        _set_meta(conn, 'watermark', new_watermark, now_iso)
                    if not plan["is_incremental"]:
                        _set_meta(conn, 'last_full_sync', now_iso, now_iso)
                        _set_meta(conn, 'total_org_active', run.total_scope or 0, now_iso)
                    _set_meta(conn, 'last_incremental_sync', now_iso, now_iso)
                    _set_meta(conn, 'last_success_at', now_iso, now_iso)
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise
    finally:
        conn.close()


def sync_work_items(org_url, pat, force_full=False, max_items=None, client=None):
    """Synchronises work items from Azure DevOps (read-only) into the local SQLite store.

    * full sync        : every in-scope item + ancestors/descendants/dependency targets, then reconciliation
                         (re-fetch before any soft delete, never on partial runs).
    * incremental sync : items changed since the watermark (1 day overlap), never deletes.
    ``max_items`` is an explicit cap: truncation yields status 'partial', never 'success'.
    """
    if is_fixture_mode():
        return {"status": "error", "error": "fixture_mode"}

    if not sync_lock.acquire(blocking=False):
        logger.info("Sync already in progress; skipping duplicate trigger.")
        return {"status": "in_progress", "message": "Sync already running."}

    run = _Run('incremental' if (get_sync_meta('watermark') and not force_full) else 'full')
    status = 'error'
    error = None
    try:
        set_sync_meta('sync_status', 'syncing')
        client = client or azure_client.AzureClient(org_url, pat, sleep=lambda s: _sleep(s))
        plan = _fetch_phase(org_url, pat, run, force_full, max_items, client)
        _apply_phase(plan, run)
        status = 'success' if run.complete else 'partial'
    except Exception as e:  # noqa: BLE001 - every failure must end in a persisted error state
        logger.error("Error in sync_work_items: %s", e, exc_info=True)
        error = str(e)[:300]
        status = 'error'
    finally:
        result = run.result(status, error)
        try:
            set_sync_meta('last_sync_result', json.dumps(result))
            if status == 'success':
                set_sync_meta('sync_status', 'idle')
                set_sync_meta('sync_error', '')
            elif status == 'partial':
                set_sync_meta('sync_status', 'partial')
                set_sync_meta('sync_error', (run.warnings[0] if run.warnings else 'partial sync')[:300])
            else:
                set_sync_meta('sync_status', 'error')
                set_sync_meta('sync_error', error or 'sync failed')
        finally:
            sync_lock.release()

    out = dict(result)
    out["synced_count"] = run.upserted
    out["total_active"] = run.total_scope if run.total_scope is not None else 0
    if error:
        out["error"] = error
    return out


# ----------------------------------------------------------------------------------------------
# Reporting
# ----------------------------------------------------------------------------------------------

def get_sync_report():
    with db_lock, get_db_connection() as conn:
        c = conn.cursor()
        total_cached = c.execute('SELECT COUNT(*) FROM work_items WHERE deleted_at IS NULL').fetchone()[0]
        total_active = c.execute(
            'SELECT COUNT(*) FROM work_items WHERE deleted_at IS NULL AND is_active = 1 AND is_context = 0'
        ).fetchone()[0]
        deleted = c.execute('SELECT COUNT(*) FROM work_items WHERE deleted_at IS NOT NULL').fetchone()[0]
        context = c.execute('SELECT COUNT(*) FROM work_items WHERE deleted_at IS NULL AND is_context = 1').fetchone()[0]

    last_result = None
    raw = get_sync_meta('last_sync_result')
    if raw:
        try:
            last_result = json.loads(raw)
        except Exception:
            last_result = None

    try:
        org_active = int(get_sync_meta('total_org_active') or total_active)
    except ValueError:
        org_active = total_active

    return {
        "status": get_sync_meta('sync_status', 'idle'),
        "last_success_at": get_sync_meta('last_success_at'),
        "last_full_sync_at": get_sync_meta('last_full_sync'),
        "last_incremental_sync_at": get_sync_meta('last_incremental_sync'),
        "last_error": get_sync_meta('sync_error') or None,
        "last_result": last_result,
        "total_org_active": org_active,
        "total_cached": total_cached,
        "total_active_cached": total_active,
        "deleted_count": deleted,
        "context_count": context,
    }


def get_data_version():
    """Cheap token that changes whenever the served data may have changed."""
    with db_lock, get_db_connection() as conn:
        c = conn.cursor()
        row = c.execute(
            'SELECT COUNT(*) AS n, MAX(last_synced_at) AS m FROM work_items WHERE deleted_at IS NULL').fetchone()
        deleted = c.execute('SELECT COUNT(*) FROM work_items WHERE deleted_at IS NOT NULL').fetchone()[0]
    return f"{row['n']}:{row['m'] or ''}:{get_sync_meta('last_success_at') or ''}:{deleted}"


# ----------------------------------------------------------------------------------------------
# Read paths (all exclude soft-deleted rows; lists / counts exclude context rows)
# ----------------------------------------------------------------------------------------------

def row_to_work_item_dict(row):
    """Converts a SQLite row into DevOpsFlow WorkItem format."""
    item_id = row['id']
    relations = {}
    if row['relations_json']:
        try:
            relations = json.loads(row['relations_json'])
        except Exception:
            relations = {}

    if 'predecessors' not in relations: relations['predecessors'] = []
    if 'successors' not in relations: relations['successors'] = []
    if 'related' not in relations: relations['related'] = []
    if 'total' not in relations: relations['total'] = len(relations['predecessors']) + len(relations['successors']) + len(relations['related'])

    return {
        "id": item_id,
        "title": row['title'],
        "type": row['type'],
        "state": row['state'],
        "project": row['project'],
        "assignedTo": row['assigned_to'] or "Unassigned",
        "assignedAvatar": row['assigned_avatar'],
        "priority": row['priority'] or 3,
        "iteration": row['iteration'],
        "areaPath": row['area_path'],
        "parentId": row['parent_id'],
        "parentTitle": row['parent_title'],
        "parentType": row['parent_type'],
        "storyPoints": row['story_points'],
        "changedDate": row['changed_date'],
        "createdDate": row['created_date'],
        "isBug": bool(row['is_bug']),
        "isTask": bool(row['is_task']),
        "isUnassigned": bool(row['is_unassigned']),
        "isBlocked": bool(row['is_blocked']),
        "isBlocking": bool(row['is_blocking']),
        "hasUnresolvedPredecessors": has_unresolved_predecessors(relations),
        "url": row['url'],
        "relations": relations,
        "children": []
    }


def has_unresolved_predecessors(relations):
    """True when at least one predecessor's state is unknown (target missing, deleted or inaccessible)."""
    for p in (relations or {}).get('predecessors') or []:
        st = p.get('state')
        if st is None or str(st).strip() == '':
            return True
    return False


def query_work_items(
    page=1,
    page_size=50,
    cursor=None,
    project='all',
    quick_filter='all',
    search='',
    types=None,
    states=None,
    priorities=None,
    include_completed=False,
    sort_by='changed_date',
    sort_order='desc',
    current_user=''
):
    """Legacy paginated query (kept for backward compatibility; the UI uses query_service)."""
    page = max(1, int(page))
    page_size = max(1, min(200, int(page_size)))

    where_clauses = ["deleted_at IS NULL", "is_context = 0"]
    params = []

    if not include_completed:
        where_clauses.append("is_active = 1")

    if project and project != 'all':
        where_clauses.append("project = ?")
        params.append(project)

    if quick_filter == 'my-tasks':
        if current_user:
            where_clauses.append("assigned_to = ?")
            params.append(current_user)
        else:
            where_clauses.append("is_unassigned = 0")
    elif quick_filter == 'unassigned':
        where_clauses.append("is_unassigned = 1")
    elif quick_filter == 'blocked':
        where_clauses.append("is_blocked = 1")
    elif quick_filter == 'bugs':
        where_clauses.append("is_bug = 1")

    if search and search.strip():
        term = f"%{search.strip()}%"
        where_clauses.append("(title LIKE ? OR CAST(id AS TEXT) LIKE ? OR assigned_to LIKE ? OR parent_title LIKE ?)")
        params.extend([term, term, term, term])

    if types:
        where_clauses.append(f"type IN ({','.join('?' for _ in types)})")
        params.extend(types)
    if states:
        where_clauses.append(f"state IN ({','.join('?' for _ in states)})")
        params.extend(states)
    if priorities:
        where_clauses.append(f"priority IN ({','.join('?' for _ in priorities)})")
        params.extend(priorities)

    where_sql = " AND ".join(where_clauses)

    order_direction = "DESC" if sort_order.lower() == 'desc' else "ASC"
    if sort_by == 'priority':
        order_sql = f"ORDER BY priority {order_direction}, is_blocked DESC, changed_date DESC, id ASC"
    elif sort_by == 'id':
        order_sql = f"ORDER BY id {order_direction}"
    elif sort_by == 'title':
        order_sql = f"ORDER BY title {order_direction}, id ASC"
    else:
        order_sql = f"ORDER BY changed_date {order_direction}, id ASC"

    offset = (page - 1) * page_size

    with db_lock, get_db_connection() as conn:
        cursor_db = conn.cursor()
        cursor_db.execute(f"SELECT COUNT(*) as count FROM work_items WHERE {where_sql}", params)
        total_matching = cursor_db.fetchone()['count']

        cursor_db.execute(f"SELECT * FROM work_items WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?",
                          params + [page_size, offset])
        items = [row_to_work_item_dict(r) for r in cursor_db.fetchall()]

        total_pages = (total_matching + page_size - 1) // page_size if total_matching > 0 else 1
        has_next = page < total_pages

        return {
            "items": items,
            "totalCount": total_matching,
            "page": page,
            "pageSize": page_size,
            "totalPages": total_pages,
            "hasNext": has_next,
            "hasPrev": page > 1,
            "nextCursor": items[-1]["id"] if items and has_next else None,
            "dataScope": "live_cached",
            "lastSyncedAt": get_sync_meta('last_incremental_sync') or get_sync_meta('last_full_sync'),
            "isComplete": True
        }


def _slim_context_item(row):
    """Context / completed rows carry what hierarchy, canonical progress AND a dependency graph node need: the real
    title, type, state, project, assignee and priority (so a completed predecessor is drawn as itself, never as a
    placeholder), plus its own relation ids so the graph can keep walking. Heavy fields (description, url, avatar,
    relation snapshots) are left out to keep the pool response small."""
    relations = {}
    if row['relations_json']:
        try:
            relations = json.loads(row['relations_json'])
        except Exception:
            relations = {}

    def ids(kind):
        return [e['id'] for e in (relations.get(kind) or []) if e.get('id') is not None]

    return {
        "id": row['id'],
        "title": row['title'],
        "type": row['type'],
        "state": row['state'],
        "project": row['project'],
        "assignedTo": row['assigned_to'] or "Unassigned",
        "isUnassigned": bool(row['is_unassigned']),
        "priority": row['priority'] or 3,
        "changedDate": row['changed_date'],
        "parentId": row['parent_id'],
        "isBlocked": bool(row['is_blocked']),
        "isContext": True,
        "predecessorIds": ids('predecessors'),
        "successorIds": ids('successors'),
    }


def build_pool_from_cache(project=''):
    """Full active scope (``flat_items``) plus ``context_items`` (completed descendants, ancestors, dependency
    targets) so Story & Tasks / Dependency Explorer can compute canonical progress over the complete hierarchy.

    Returns None when no full sync has completed yet so callers can fall back to the legacy path."""
    if not get_sync_meta('last_full_sync'):
        return None

    where = "deleted_at IS NULL AND is_active = 1 AND is_context = 0"
    params = []
    if project and project != 'all':
        where += " AND project = ?"
        params.append(project)

    with db_lock, get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(f"SELECT * FROM work_items WHERE {where} ORDER BY changed_date DESC, id ASC", params)
        items = [row_to_work_item_dict(r) for r in cursor.fetchall()]
        cursor.execute(
            "SELECT * FROM work_items WHERE deleted_at IS NULL AND (is_active = 0 OR is_context = 1) "
            "ORDER BY id ASC")
        context_items = [_slim_context_item(r) for r in cursor.fetchall()]
        cursor.execute(
            "SELECT DISTINCT project FROM work_items WHERE deleted_at IS NULL AND project IS NOT NULL AND project != '' "
            "ORDER BY project ASC")
        all_projects = [r['project'] for r in cursor.fetchall()]

    return {
        "summary": {
            "total_items": len(items),
            "total_active_in_org": int(get_sync_meta('total_org_active') or len(items)),
            "unassigned_total": sum(1 for i in items if i["isUnassigned"]),
            "unassigned_tasks": sum(1 for i in items if i["isUnassigned"] and not i["isBug"]),
            "unassigned_bugs": sum(1 for i in items if i["isUnassigned"] and i["isBug"]),
            "assigned_total": sum(1 for i in items if not i["isUnassigned"]),
            "pbi_count": 0
        },
        "stats_by_project": {},
        "hierarchy": [],
        "flat_items": items,
        "context_items": context_items,
        "projects": all_projects or sorted({i["project"] for i in items}),
        "dataScope": "fixture" if is_fixture_mode() else "live_cached",
        "dataVersion": get_data_version(),
        "lastSyncedAt": get_sync_meta('last_success_at') or get_sync_meta('last_incremental_sync')
        or get_sync_meta('last_full_sync')
    }


def get_counts(current_user=''):
    """Global organisation and project metrics (alive, non-context rows only)."""
    base = "deleted_at IS NULL AND is_context = 0"
    with db_lock, get_db_connection() as conn:
        cursor = conn.cursor()

        def one(sql, params=()):
            cursor.execute(sql, params)
            return cursor.fetchone()[0]

        total_active_cached = one(f"SELECT COUNT(*) FROM work_items WHERE {base} AND is_active = 1")
        total_cached = one("SELECT COUNT(*) FROM work_items WHERE deleted_at IS NULL")
        unassigned_total = one(f"SELECT COUNT(*) FROM work_items WHERE {base} AND is_active = 1 AND is_unassigned = 1")
        blocked_total = one(f"SELECT COUNT(*) FROM work_items WHERE {base} AND is_active = 1 AND is_blocked = 1")
        bugs_total = one(f"SELECT COUNT(*) FROM work_items WHERE {base} AND is_active = 1 AND is_bug = 1")

        my_active = 0
        my_completed = 0
        if current_user:
            my_active = one(f"SELECT COUNT(*) FROM work_items WHERE {base} AND assigned_to = ? AND is_active = 1",
                            (current_user,))
            my_completed = one(f"SELECT COUNT(*) FROM work_items WHERE {base} AND assigned_to = ? AND is_active = 0",
                               (current_user,))

        cursor.execute(f'''
            SELECT project,
                   COUNT(*) as total,
                   SUM(CASE WHEN is_unassigned = 1 THEN 1 ELSE 0 END) as unassigned,
                   SUM(CASE WHEN is_unassigned = 0 THEN 1 ELSE 0 END) as assigned
            FROM work_items
            WHERE {base} AND is_active = 1
            GROUP BY project
        ''')
        stats_by_project = {
            r['project']: {"total": r['total'], "unassigned": r['unassigned'], "assigned": r['assigned']}
            for r in cursor.fetchall()
        }

        total_org_active = int(get_sync_meta('total_org_active') or total_active_cached)

        return {
            "total_org_active": total_org_active,
            "total_cached": total_cached,
            "total_active_cached": total_active_cached,
            "my_tasks_active": my_active,
            "my_tasks_completed": my_completed,
            "my_tasks_total": my_active + my_completed,
            "unassigned_total": unassigned_total,
            "blocked_total": blocked_total,
            "bugs_total": bugs_total,
            "stats_by_project": stats_by_project,
            "last_synced_at": get_sync_meta('last_success_at') or get_sync_meta('last_incremental_sync')
            or get_sync_meta('last_full_sync'),
            "sync_status": get_sync_meta('sync_status', 'idle')
        }


def get_single_item(item_id, org_url=None, pat=None):
    """Retrieves a single item from SQLite (alive rows, context rows included) or, outside fixture mode,
    reads it live from Azure DevOps when it is not cached."""
    with db_lock, get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM work_items WHERE id = ? AND deleted_at IS NULL", (item_id,))
        row = cursor.fetchone()
        if row:
            return row_to_work_item_dict(row)

    if is_fixture_mode():
        return None

    if org_url and pat:
        try:
            headers = get_devops_headers(pat)
            url = f"{org_url}/_apis/wit/workitems/{item_id}?$expand=relations&api-version=7.1"
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200:
                raw_item = res.json()
                parsed = parse_work_item(raw_item, org_url)
                return {
                    "id": item_id,
                    "title": parsed["title"] or f'Work Item #{item_id}',
                    "type": parsed["type"],
                    "state": parsed["state"],
                    "project": parsed["project"],
                    "assignedTo": parsed["assigned_to"],
                    "assignedAvatar": parsed["assigned_avatar"],
                    "priority": parsed["priority"],
                    "iteration": parsed["iteration"],
                    "areaPath": parsed["area_path"],
                    "parentId": parsed["parent_id"],
                    "parentTitle": None,
                    "parentType": None,
                    "storyPoints": parsed["story_points"],
                    "changedDate": parsed["changed_date"],
                    "createdDate": parsed["created_date"],
                    "isBug": bool(parsed["is_bug"]),
                    "isTask": bool(parsed["is_task"]),
                    "isUnassigned": bool(parsed["is_unassigned"]),
                    "isBlocked": False,
                    "isBlocking": False,
                    "url": parsed["url"],
                    "relations": parsed["relations"],
                    "children": []
                }
        except Exception as ex:
            logger.warning(f"Error on-demand fetching item {item_id}: {ex}")

    return None
