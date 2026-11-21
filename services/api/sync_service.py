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
from contextlib import contextmanager, nullcontext
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
CONTEXT_POLICY_ENV = 'SYNC_CONTEXT_POLICY'


def context_budgets():
    """Return explicit opt-in closure item/request budgets; defaults preserve the historical fixed cap."""
    if os.environ.get(CONTEXT_POLICY_ENV, '').strip().lower() != 'budgeted':
        return MAX_CONTEXT_ITEMS, None
    try:
        items = int(os.environ['SYNC_CONTEXT_MAX_ITEMS'])
        requests = int(os.environ['SYNC_CONTEXT_MAX_REQUESTS'])
    except (KeyError, TypeError, ValueError):
        raise SyncError('context_budget_config_invalid: set positive SYNC_CONTEXT_MAX_ITEMS and '
                        'SYNC_CONTEXT_MAX_REQUESTS')
    if items <= 0 or requests <= 0:
        raise SyncError('context_budget_config_invalid: context budgets must be positive')
    return items, requests
MASS_DELETE_FLOOR = 50
MASS_DELETE_RATIO = 0.10
MAX_WARNINGS = 20
# An incremental run whose WIQL window holds more ids than this first asks Azure DevOps for the cheap
# (Rev, ChangedDate) pair of the ids it already has cached and only reads full details (with relations) for the
# ids that really changed. Within one batch of ids the probe costs a request without saving one, so smaller
# windows go straight to the full read.
PROBE_MIN_IDS = azure_client.BATCH_SIZE
PROBE_FIELDS = ('System.Rev', 'System.ChangedDate')
# Relation targets that Azure DevOps could not return (deleted, or not accessible yet) are asked for again on every
# run while the run that first missed them is still inside the incremental WIQL window (the window starts one day
# before the watermark's day). That is exactly how long the item linking to them used to be re-read in full, and
# therefore how long the target was retried before the probe existed; afterwards the periodic full sync is what
# picks the target up, as before. The list is capped, newest first.
CLOSURE_RETRY_MAX = 2000
# Rows remembered per unreachable target; a target linked from more rows than this is simply always retried.
CLOSURE_SOURCES_MAX = 50

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
            ('repro_steps', 'TEXT'),
            ('rev', 'INTEGER'),
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


@contextmanager
def read_snapshot():
    """A read-only connection pinned to ONE committed snapshot, taken without ``db_lock``.

    ``db_lock`` serialises writers (the sync apply phase holds it for its whole transaction). Readers do not need
    it: the database is in WAL mode, so a reader keeps seeing the last committed state while a write transaction is
    open and never sees a half-applied sync. The explicit ``BEGIN`` matters: without it every statement would run in
    its own autocommit snapshot and one request could mix rows from two syncs. Everything a request returns
    (rows, counts, ``get_data_version(conn)``, ``get_sync_meta(..., conn=conn)``) must be read through this
    connection so that the version belongs to the data.
    """
    conn = get_db_connection()
    conn.isolation_level = None
    try:
        conn.execute('BEGIN')  # deferred: the snapshot is fixed by the first read below
        yield conn
    finally:
        try:
            conn.execute('ROLLBACK')
        except sqlite3.Error:
            pass
        conn.close()


def get_sync_meta(key, default=None, conn=None):
    """``conn`` reads inside the caller's snapshot (see read_snapshot); without it the call is self-contained."""
    if conn is not None:
        row = conn.execute('SELECT val FROM sync_state WHERE key = ?', (key,)).fetchone()
        return row['val'] if row else default
    with db_lock, get_db_connection() as own:
        cursor = own.cursor()
        cursor.execute('SELECT val FROM sync_state WHERE key = ?', (key,))
        row = cursor.fetchone()
        return row['val'] if row else default


def set_sync_meta(key, val):
    now_iso = _utcnow().isoformat()
    with db_lock, get_db_connection() as conn:
        _set_meta(conn, key, val, now_iso)
        conn.commit()


def set_sync_meta_many(values):
    """Atomically update related sync metadata values in one SQLite transaction."""
    now_iso = _utcnow().isoformat()
    with db_lock, get_db_connection() as conn:
        for key, val in values.items():
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


def _rev_of(item):
    """Revision number of a raw work item (top-level ``rev``, or ``System.Rev`` when requested as a field)."""
    rev = item.get("rev")
    if rev is None:
        rev = (item.get("fields") or {}).get("System.Rev")
    if isinstance(rev, bool):
        return None
    if isinstance(rev, int):
        return rev
    if isinstance(rev, str) and rev.isdigit():
        return int(rev)
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
    # Azure DevOps omits empty fields, so a fetched item that lacks them is a *known* empty description ('').
    # NULL in the cache is reserved for rows synced before descriptions were stored (unknown).
    description = _text_field(fields.get("System.Description"))
    repro_steps = _text_field(fields.get("Microsoft.VSTS.TCM.ReproSteps"))
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
        "description": description,
        "repro_steps": repro_steps,
        "rev": _rev_of(item),
        "relations": {
            "predecessors": predecessors,
            "successors": successors,
            "related": related,
            "total": len(predecessors) + len(successors) + len(related)
        },
        "_child_ids": child_ids,
        "_dep_ids": dep_ids,
    }


def _text_field(value):
    return value if isinstance(value, str) else ""


_UPSERT_COLUMNS = (
    "id, title, type, state, project, assigned_to, assigned_avatar, priority, iteration, area_path, "
    "parent_id, parent_title, parent_type, story_points, changed_date, created_date, is_bug, is_task, "
    "is_unassigned, is_active, is_blocked, is_blocking, url, relations_json, last_synced_at, "
    "last_seen_at, deleted_at, is_context, description, repro_steps, rev"
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
    is_context = excluded.is_context,
    description = excluded.description,
    repro_steps = excluded.repro_steps,
    rev = excluded.rev
'''

_UPSERT_MAIN_SQL = (
    f"INSERT INTO work_items ({_UPSERT_COLUMNS}) VALUES ({', '.join('?' for _ in range(31))}) "
    f"ON CONFLICT(id) DO UPDATE SET {_UPSERT_UPDATE}"
)

# Context data must never overwrite an in-scope active row: only context rows, inactive/completed rows, or hollow rows are refreshed.
_UPSERT_CONTEXT_SQL = (
    f"INSERT INTO work_items ({_UPSERT_COLUMNS}) VALUES ({', '.join('?' for _ in range(31))}) "
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
        now_iso, None, 1 if is_context else 0,
        item.get("description"), item.get("repro_steps"), item.get("rev")
    )


# ----------------------------------------------------------------------------------------------
# Derived data (relation snapshots, blocked / blocking flags, parent titles)
# ----------------------------------------------------------------------------------------------

def recompute_derived(conn):
    """Dispatches to the chunked implementation when SYNC_CHUNKED=1 (identical result, bounded memory)."""
    if sync_staging.chunked_enabled():
        return sync_staging.recompute_derived_bounded(conn)
    return recompute_derived_inmemory(conn)


def recompute_derived_inmemory(conn):
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
    if sync_staging.chunked_enabled():
        return sync_staging.find_orphan_context_ids_bounded(conn)
    return find_orphan_context_ids_inmemory(conn)


def find_orphan_context_ids_inmemory(conn):
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
        self.probed = 0
        self.unchanged_skipped = 0
        self.closure_missing = {}  # relation targets that could not be read in this run: id -> 'hier' | 'dep'
        self.details_fetched = 0
        self.partitions = 1
        self.derived = None
        self.total_scope = None
        self.request_start = None
        self.request_limit = None

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
            "probed": self.probed,
            "unchanged_skipped": self.unchanged_skipped,
            "details_fetched": self.details_fetched,
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


def _collect_context(client, org_url, main_rows, run, alive, retry=None, retry_sources=None):
    """Fetches ancestors, descendants (needed for canonical progress) and dependency targets that are not cached."""
    known = {r['id'] for r in main_rows}
    context = {}
    frontier = list(main_rows)
    dep_only = {}
    retry = retry or {}
    retry_sources = retry_sources or {}
    context_limit, request_limit = context_budgets()
    stats = getattr(client, 'stats', None)
    request_start = run.request_start if run.request_start is not None else (
        stats.get('requests', 0) if isinstance(stats, dict) else None)
    refs = defaultdict(dict)  # target id -> {id of a row read in this run that links to it: 'hier' | 'dep'}

    for round_no in range(MAX_CLOSURE_ROUNDS):
        want_hier, want_dep = set(), set()
        if round_no == 0:
            # targets that could not be read earlier (see CLOSURE_RETRY_DAYS)
            want_hier.update(i for i, kind in retry.items() if kind == 'hier')
            want_dep.update(i for i, kind in retry.items() if kind != 'hier')
        for r in frontier:
            for t in r['_dep_ids']:
                refs[t].setdefault(r['id'], 'dep')
            for t in list(r['_child_ids']) + ([r['parent_id']] if r['parent_id'] else []):
                refs[t][r['id']] = 'hier'  # a hierarchy link wins over a dependency link from the same row
            if r['parent_id']:
                want_hier.add(r['parent_id'])
            want_hier.update(r['_child_ids'])
            want_dep.update(r['_dep_ids'])

        skip = known | set(context) | alive | set(dep_only)
        want_hier -= skip
        want_dep -= skip | want_hier
        if not want_hier and not want_dep:
            break

        if len(context) + len(dep_only) + len(want_hier) + len(want_dep) > context_limit:
            run.warn(f"context_cap_reached:{context_limit}", partial=True)
            break

        if request_limit is not None and request_start is not None:
            attempted = stats.get('requests', 0) - request_start
            projected = (len(want_hier) + len(want_dep) + azure_client.BATCH_SIZE - 1) // azure_client.BATCH_SIZE
            if attempted + projected > request_limit:
                run.warn(f"context_request_budget_reached:{request_limit}", partial=True)
                break

        ids = sorted(want_hier | want_dep)
        fr = client.get_items(ids, expand_relations=True, error_policy_omit=True)
        if any('http_attempt_budget_exhausted' in e for e in fr.errors):
            run.warn(f"context_request_budget_reached:{request_limit}", partial=True)
        if fr.failed_batches:
            run.warn(f"context_fetch_failed:{sum(len(b) for b in fr.failed_batches)}", partial=True)
        if fr.missing:
            run.warn(f"context_missing:{len(fr.missing)}")  # dangling link (deleted / inaccessible), not a data gap
            for i in fr.missing:
                carried = retry_sources.get(i, [])
                if carried is None:
                    sources = None
                else:
                    merged = dict(carried)
                    merged.update(refs[i])
                    sources = None if len(merged) > CLOSURE_SOURCES_MAX else sorted(merged.items())
                run.closure_missing[i] = ('hier' if i in want_hier else 'dep', sources)

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
        if any('http_attempt_budget_exhausted' in e for e in fr.errors):
            run.warn(f"request_budget_reached:{run.request_limit}", partial=True)
        run.warn(f"reconcile_fetch_failed:{sum(len(b) for b in fr.failed_batches)}", partial=True)
        # Absence is unknown for failed batches: rows are untouched and nothing is deleted this run.
        rows = [parse_work_item(raw, org_url) for raw in fr.items.values()]
        return rows, []

    rows = [parse_work_item(raw, org_url) for raw in fr.items.values()]
    return rows, list(fr.missing)


def _load_closure_missing():
    try:
        raw = json.loads(get_sync_meta('closure_missing') or '{}')
        out = {}
        for i, v in raw.items():
            sources = None
            if len(v) > 2 and v[2] is not None:
                # [[row id, 'hier' | 'dep'], ...]; a plain id (earlier format) takes the entry's kind
                sources = [(int(x[0]), x[1]) if isinstance(x, list) else (int(x), v[0]) for x in v[2]]
            out[int(i)] = (v[0], v[1], sources)
        return out
    except (ValueError, TypeError, IndexError, AttributeError):
        return {}


def _retry_expired(first_seen, last_watermark):
    """True once the run that first missed a target has left the incremental window."""
    if not last_watermark:
        return False
    try:
        window_start = (dtparser.parse(last_watermark) - timedelta(days=1)).strftime('%Y-%m-%d')
        return first_seen[:10] < window_start
    except Exception:  # noqa: BLE001 - an unreadable timestamp must not keep a target in the retry list forever
        return True


def _probe_unchanged(client, ids, run):
    """Splits an incremental window into ids that must be read in full and ids that provably did not change.

    An id is skipped only when the cache already holds it as a live, in-scope (not context) row with relations,
    a stored revision and the same (Rev, ChangedDate) that Azure DevOps reports now. Everything else is read in
    full exactly as before: uncached ids, context rows (they must be promoted to in-scope), soft-deleted rows
    (they must be restored), rows without a stored revision (cache written before revisions were kept) and any id
    the probe could not answer (failed batch, omitted item). The probe is an optimisation only: its failure never
    fails the sync and never skips a read.
    Returns (ids_to_read_in_full, [(id, changed_date) of skipped ids]).
    """
    cached = {}
    with db_lock, get_db_connection() as conn:
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            marks = ','.join('?' for _ in chunk)
            for r in conn.execute(
                f'SELECT id, rev, changed_date FROM work_items WHERE id IN ({marks}) AND deleted_at IS NULL '
                'AND is_context = 0 AND rev IS NOT NULL AND relations_json IS NOT NULL AND last_seen_at IS NOT NULL',
                chunk,
            ):
                cached[r['id']] = (r['rev'], r['changed_date'])
    candidates = [i for i in ids if i in cached]
    if not candidates:
        return ids, []

    unchanged = []
    for start in range(0, len(candidates), azure_client.BATCH_SIZE):
        batch = candidates[start:start + azure_client.BATCH_SIZE]
        fr = client.get_items(batch, expand_relations=False, fields=PROBE_FIELDS, error_policy_omit=True)
        run.probed += len(batch)
        for item_id, raw in fr.items.items():
            remote = (_rev_of(raw), (raw.get('fields') or {}).get('System.ChangedDate'))
            if remote[0] is not None and remote[1] and remote == cached[item_id]:
                unchanged.append((item_id, remote[1]))
        if fr.failed_batches:
            # The client already spent its retries (and honoured Retry-After) on this batch. Stop probing: the ids
            # from here on are read in full below, so a throttled or failing probe costs one batch of attempts,
            # not one per remaining batch.
            run.warn(f"probe_failed:{len(candidates) - start}")
            break
    skip = {i for i, _ in unchanged}
    return [i for i in ids if i not in skip], unchanged


def _select_ids(run, force_full, max_items, client):
    """Decides the mode and returns the ids to read: the WIQL result (truncated by ``max_items``), minus the ids an
    incremental probe proved unchanged. Shared by the in-memory and the staged (bounded-memory) fetch."""
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

    unchanged = []
    read_ids = ids
    if is_incremental and len(ids) > PROBE_MIN_IDS and get_sync_meta('closure_dirty') != '1':
        # A partial run may have left holes in the ancestor / descendant / dependency closure that only a full
        # re-read of the window heals, so the probe is skipped until a complete run clears the flag.
        read_ids, unchanged = _probe_unchanged(client, ids, run)
    run.unchanged_skipped = len(unchanged)
    return {"is_incremental": is_incremental, "last_watermark": last_watermark, "ids": ids, "truncated": truncated,
            "unchanged": unchanged, "read_ids": read_ids}


def _fetch_phase(org_url, pat, run, force_full, max_items, client):
    sel = _select_ids(run, force_full, max_items, client)
    is_incremental, last_watermark = sel["is_incremental"], sel["last_watermark"]
    ids, truncated, unchanged, read_ids = sel["ids"], sel["truncated"], sel["unchanged"], sel["read_ids"]

    main_rows = []
    returned_ids = set()
    if read_ids:
        fr = client.get_items(read_ids, expand_relations=True, error_policy_omit=True)
        if fr.failed_batches:
            raise SyncError(f"details_fetch_failed:{sum(len(b) for b in fr.failed_batches)} ids "
                            f"({'; '.join(fr.errors[:2])})")
        if fr.missing:
            run.warn(f"missing_detail:{len(fr.missing)}")
        for raw in fr.items.values():
            main_rows.append(parse_work_item(raw, org_url))
        returned_ids = set(fr.items)
    run.details_fetched = len(main_rows)
    run.fetched = len(main_rows) + len(unchanged)  # rows brought up to date in this window, as before

    with db_lock:
        alive = _alive_ids()
    prior_missing = _load_closure_missing()
    now_iso = _utcnow().isoformat()
    # A remembered target is retried only while a row that linked to it still does and was not re-read in this run
    # (a re-read row decides for itself: the normal closure asks for what it still links to). Removing the link
    # therefore ends the retry instead of creating a context row nobody needs.
    read_now = {r['id'] for r in main_rows}
    retry, retry_sources = {}, {}
    for i, (kind, first_seen, sources) in prior_missing.items():
        if _retry_expired(first_seen, last_watermark):
            continue
        if sources is None:
            retry[i], retry_sources[i] = kind, None
            continue
        still_linked = [(s, k) for s, k in sources if s in alive and s not in read_now]
        if still_linked:
            # the target is read the way the rows that still link to it would read it: as a child / parent (its own
            # children and ancestors follow) if one of them links by hierarchy, otherwise as a dependency only
            retry[i] = 'hier' if any(k == 'hier' for _, k in still_linked) else 'dep'
            retry_sources[i] = still_linked
    context_rows = _collect_context(client, org_url, main_rows, run, alive, retry, retry_sources)
    closure_missing = {str(i): [kind, prior_missing[i][1] if i in retry else now_iso, sources]
                       for i, (kind, sources) in run.closure_missing.items()}

    # Reconcile hollow / unverified cached rows (missing relations or last_seen_at) during full sync
    if not is_incremental and run.complete and not truncated:
        with db_lock, get_db_connection() as conn:
            hollow_ids = [r['id'] for r in conn.execute(
                'SELECT id FROM work_items WHERE deleted_at IS NULL AND (relations_json IS NULL OR last_seen_at IS NULL)'
            ).fetchall()]
        hollow_needed = [i for i in hollow_ids if i not in returned_ids and i not in {r['id'] for r in context_rows}]
        if hollow_needed:
            fr_hollow = client.get_items(hollow_needed, expand_relations=True, error_policy_omit=True)
            if any('http_attempt_budget_exhausted' in e for e in fr_hollow.errors):
                run.warn(f"request_budget_reached:{run.request_limit}", partial=True)
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
        "unchanged": unchanged,
        "closure_missing": closure_missing,
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
    unchanged = plan.get("unchanged") or []
    for cd in [r.get("changed_date") for r in main_rows] + [cd for _, cd in unchanged]:
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
                if unchanged:
                    # Same content as Azure DevOps reports: only the "seen in this sync" bookkeeping moves.
                    conn.executemany(
                        'UPDATE work_items SET last_synced_at = ?, last_seen_at = ? '
                        'WHERE id = ? AND deleted_at IS NULL AND is_context = 0',
                        [(now_iso, now_iso, i) for i, _ in unchanged])
                run.upserted = len(seen) + len(unchanged)

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

                cm = plan.get("closure_missing") or {}
                cm_overflow = len(cm) > CLOSURE_RETRY_MAX
                if cm_overflow:
                    # More unreachable targets than the retry list can hold: keep the newest and let the next run
                    # re-read its whole window (probe off, as for a partial run) so none of them is forgotten.
                    cm = dict(sorted(cm.items(), key=lambda kv: kv[1][1], reverse=True)[:CLOSURE_RETRY_MAX])
                _set_meta(conn, 'closure_dirty', '0' if run.complete and not cm_overflow else '1', now_iso)
                if run.complete:
                    _set_meta(conn, 'closure_missing', json.dumps(cm), now_iso)
                    if new_watermark:
                        _set_meta(conn, 'watermark', new_watermark, now_iso)
                    if not plan["is_incremental"]:
                        _set_meta(conn, 'last_full_sync', now_iso, now_iso)
                        _set_meta(conn, 'total_org_active', run.total_scope or 0, now_iso)
                        _set_meta(conn, 'initial_full_partial_count', 0, now_iso)
                        _set_meta(conn, 'initial_full_retry_at', '', now_iso)
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
    plan = None
    try:
        set_sync_meta('sync_status', 'syncing')
        client = client or azure_client.AzureClient(org_url, pat, sleep=lambda s: _sleep(s))
        _, request_limit = context_budgets()
        stats = getattr(client, 'stats', None)
        run.request_start = stats.get('requests', 0) if isinstance(stats, dict) else None
        run.request_limit = request_limit
        if sync_staging.chunked_enabled():
            fetch, apply = sync_staging.fetch_phase, sync_staging.apply_phase
        else:
            fetch, apply = _fetch_phase, _apply_phase
        request_scope = (client.request_budget(request_limit)
                         if request_limit is not None and hasattr(client, 'request_budget') else nullcontext())
        with request_scope:
            plan = fetch(org_url, pat, run, force_full, max_items, client)
        apply(plan, run)
        status = 'success' if run.complete else 'partial'
    except Exception as e:  # noqa: BLE001 - every failure must end in a persisted error state
        logger.error("Error in sync_work_items: %s", e, exc_info=True)
        error = str(e)[:300]
        status = 'error'
    finally:
        if plan and plan.get('stage'):
            plan['stage'].discard()  # the staging file belongs to this run only
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


def _data_version_from(conn):
    row = conn.execute(
        'SELECT COUNT(*) AS n, MAX(last_synced_at) AS m FROM work_items WHERE deleted_at IS NULL').fetchone()
    deleted = conn.execute('SELECT COUNT(*) FROM work_items WHERE deleted_at IS NOT NULL').fetchone()[0]
    return f"{row['n']}:{row['m'] or ''}:{get_sync_meta('last_success_at', conn=conn) or ''}:{deleted}"


def get_data_version(conn=None):
    """Token that changes whenever the served data may have changed (format unchanged).

    Pass the request's ``read_snapshot()`` connection so the token describes the very rows being returned."""
    if conn is not None:
        return _data_version_from(conn)
    with db_lock, get_db_connection() as own:
        return _data_version_from(own)


# ----------------------------------------------------------------------------------------------
# Read paths (all exclude soft-deleted rows; lists / counts exclude context rows)
# ----------------------------------------------------------------------------------------------

def body_payload(description, repro_steps):
    """Description fields of a work item detail response.

    ``descriptionStatus`` keeps three situations apart: ``available`` (text exists), ``empty`` (Azure DevOps
    confirmed there is none) and ``unavailable`` (the text could not be read, so nothing can be said about it).
    """
    if description is None and repro_steps is None:
        return {"description": "", "reproSteps": "", "descriptionStatus": "unavailable"}
    description, repro_steps = description or "", repro_steps or ""
    has_text = bool(description.strip() or repro_steps.strip())
    return {"description": description, "reproSteps": repro_steps,
            "descriptionStatus": "available" if has_text else "empty"}


def row_to_work_item_dict(row, include_body=False):
    """Converts a SQLite row into DevOpsFlow WorkItem format.

    Description bodies can be large, so list/batch payloads leave them out; only the single-item detail
    response (``include_body=True``) carries them."""
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
        "children": [],
        **(body_payload(row['description'], row['repro_steps']) if include_body else {}),
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


def _fetch_body_fields(item_id, org_url, pat):
    """Reads only the description fields of one work item. Returns (description, repro_steps) or None on failure."""
    try:
        url = (f"{org_url}/_apis/wit/workitems/{item_id}"
               "?fields=System.Description,Microsoft.VSTS.TCM.ReproSteps&api-version=7.1")
        res = requests.get(url, headers=get_devops_headers(pat), timeout=10)
        if res.status_code != 200:
            return None
        fields = (res.json() or {}).get("fields") or {}
        return _text_field(fields.get("System.Description")), _text_field(fields.get("Microsoft.VSTS.TCM.ReproSteps"))
    except Exception as ex:
        logger.warning(f"Error fetching description of item {item_id}: {ex}")
        return None


def get_single_item(item_id, org_url=None, pat=None):
    """Retrieves a single item from SQLite (alive rows, context rows included) or, outside fixture mode,
    reads it live from Azure DevOps when it is not cached."""
    with db_lock, get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM work_items WHERE id = ? AND deleted_at IS NULL", (item_id,))
        row = cursor.fetchone()
    if row:
        if row['description'] is None and row['repro_steps'] is None and not is_fixture_mode() and org_url and pat:
            # Row cached before descriptions were stored: read just the body fields live (GET only) and keep them.
            body = _fetch_body_fields(item_id, org_url, pat)
            if body is not None:
                with db_lock, get_db_connection() as conn:
                    conn.execute('UPDATE work_items SET description = ?, repro_steps = ? WHERE id = ?',
                                 (body[0], body[1], item_id))
                    conn.commit()
                    row = conn.execute("SELECT * FROM work_items WHERE id = ? AND deleted_at IS NULL", (item_id,)).fetchone() or row
        return row_to_work_item_dict(row, include_body=True)

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
                    "children": [],
                    **body_payload(parsed["description"], parsed["repro_steps"]),
                }
        except Exception as ex:
            logger.warning(f"Error on-demand fetching item {item_id}: {ex}")

    return None


import sync_staging  # noqa: E402  (bottom import: sync_staging needs the names above; used only at call time)

try:
    sync_staging.cleanup_stale_stage()  # boot: drop the staging files of an interrupted run (own files, lock-checked)
except Exception as _cleanup_error:  # noqa: BLE001 - housekeeping must never stop the backend from starting
    logger.warning("Stale staging cleanup skipped: %s", _cleanup_error)
