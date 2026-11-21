"""Bounded-memory sync (prototype, opt-in with SYNC_CHUNKED=1).

The classic sync keeps the whole run in Python: the parsed HTTP responses, every parsed row, every context row, and
then ``recompute_derived`` / the orphan scan load the whole table again. Peak memory therefore grows with the number
of work items. This module keeps the same algorithm and the same result, but moves the per-run working set into a
*staging* SQLite file next to the cache:

  1. detail batches are streamed (``AzureClient.iter_batches``), parsed and appended to ``devops_stage.db`` in small
     transactions; nothing but one bounded window of responses is ever held in Python;
  2. the ancestor / descendant / dependency closure runs as set operations over the staged link table;
  3. ONE transaction on the real cache copies the staged rows (``INSERT ... SELECT``), soft-deletes, removes orphans,
     recomputes the derived fields in id-ordered chunks and writes the watermark, exactly like ``_apply_phase``.

Safety: the real cache is only written by step 3, inside a single ``BEGIN IMMEDIATE`` ... ``COMMIT``. A crash, an
HTTP error or a partial run before that point leaves the cache, its watermark and its previous snapshot untouched
(readers keep seeing the last committed state, as before). The staging file is private to one run: it is deleted
before a run starts and after it ends, and it is never read by any query.
"""
import fcntl
import json
import os
import shutil
import sqlite3
from urllib.parse import quote

import sync_service as ss

STAGE_FILE = 'devops_stage.db'
LOCK_FILE = 'devops_stage.lock'
# The only files this feature ever creates or removes (inside the cache directory): the staging database, its
# sidecars and the lock that proves a live run owns them.
OWNED_SUFFIXES = ('', '-journal', '-wal', '-shm')
# Disk budget. Measured (synthetic, 2 KB descriptions): staging file ~4.2 KB per cached row, publish transaction WAL
# ~= staging size, and the cache grows by about the same amount when the WAL is checkpointed, i.e. a run needs
# remaining staging growth + 2 x staging size (WAL + cache growth) + a fixed margin.
MIN_FREE_BYTES = 256 * 1024 * 1024
ESTIMATED_ROW_BYTES = 4096       # only used before the first chunk is staged; measured numbers replace it afterwards
CONTEXT_ROW_FACTOR = 1.3         # context rows per in-scope row (measured 0.25-0.30 in the synthetic org)
PUBLISH_FACTOR = 2.0
KIND_MAIN, KIND_CTX_HIER, KIND_CTX_DEP, KIND_RECONCILE, KIND_HOLLOW = 0, 1, 2, 3, 4
MAIN_KINDS = (KIND_MAIN, KIND_RECONCILE)       # upserted as in-scope rows
CONTEXT_KINDS = (KIND_CTX_HIER, KIND_CTX_DEP, KIND_HOLLOW)
DERIVED_CHUNK = 2000        # rows per recompute_derived chunk
LOOKUP_CHUNK = 500          # ids per ``WHERE id IN (...)`` lookup (well under SQLITE_MAX_VARIABLE_NUMBER)

_COLS = ('title', 'type', 'state', 'project', 'assigned_to', 'assigned_avatar', 'priority', 'iteration', 'area_path',
         'parent_id', 'parent_title', 'parent_type', 'story_points', 'changed_date', 'created_date', 'is_bug',
         'is_task', 'is_unassigned', 'is_active', 'is_blocked', 'is_blocking', 'url', 'relations_json',
         'description', 'repro_steps', 'rev')

_SCHEMA = f'''
CREATE TABLE item (id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, rnd INTEGER NOT NULL, {', '.join(_COLS)});
CREATE INDEX item_rnd ON item(rnd);
CREATE INDEX item_kind ON item(kind);
CREATE TABLE edge (src INTEGER NOT NULL, dst INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE INDEX edge_src ON edge(src);
CREATE INDEX edge_dst ON edge(dst);
CREATE TABLE scope (id INTEGER PRIMARY KEY);
CREATE TABLE want (id INTEGER PRIMARY KEY, kind TEXT NOT NULL);
'''

_INSERT_ITEM = (f"INSERT OR IGNORE INTO item (id, kind, rnd, {', '.join(_COLS)}) "
                f"VALUES (?, ?, ?, {', '.join('?' for _ in _COLS)})")


def chunked_enabled():
    return os.environ.get('SYNC_CHUNKED', '').strip() == '1'


def _chunks(seq, size):
    seq = list(seq)
    for start in range(0, len(seq), size):
        yield seq[start:start + size]


def _marks(n):
    return ','.join('?' for _ in range(n))


def _lock_path(stage_path):
    return os.path.join(os.path.dirname(stage_path), LOCK_FILE)


def _acquire_lock(stage_path):
    """Exclusive, non-blocking flock on the lock file; None when a live run holds it. The kernel drops the lock when
    the owner dies (kill -9 included), which is what makes leftover staging files provably stale."""
    handle = open(_lock_path(stage_path), 'a')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def _remove_owned(stage_path):
    removed = []
    for suffix in OWNED_SUFFIXES:
        try:
            os.remove(stage_path + suffix)
            removed.append(os.path.basename(stage_path + suffix))
        except FileNotFoundError:
            pass
    return removed


def cleanup_stale_stage(directory=None):
    """Removes the staging files of an interrupted run (boot-time cleanup). Touches only this feature's own files and
    only when no live run holds the lock. Returns the removed file names."""
    path = os.path.join(directory or os.path.dirname(ss.DB_PATH), STAGE_FILE)
    lock = _acquire_lock(path)
    if lock is None:
        return []
    try:
        return _remove_owned(path)
    finally:
        lock.close()


class StageStore:
    """Private working database of ONE sync run. Opens the real cache read-only (``m``) for set operations."""

    def __init__(self, path, cache_path):
        self.path = path
        self.rows_staged = 0
        self.expected_rows = 0
        self.conn = None
        self._lock = _acquire_lock(path)
        if self._lock is None:
            raise ss.SyncError('staging_in_use: another process owns the staging file')
        try:
            _remove_owned(path)  # leftovers of an interrupted run: the lock proves nobody is using them
            self._open(path, cache_path)
        except BaseException:
            self.discard()
            raise

    def _open(self, path, cache_path):
        self.conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA journal_mode=MEMORY')
        self.conn.execute('PRAGMA synchronous=OFF')
        self.conn.execute('PRAGMA cache_size=-8192')   # 8 MB page cache: the memory ceiling of this connection
        self.conn.executescript(_SCHEMA)
        self.conn.close()  # reopen with URI support so that the real cache can be attached read-only as ``m``
        self.conn = sqlite3.connect(f'file:{quote(path)}', uri=True, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA journal_mode=MEMORY')
        self.conn.execute('PRAGMA synchronous=OFF')
        self.conn.execute('PRAGMA cache_size=-8192')
        self.conn.execute('ATTACH DATABASE ? AS m', (f'file:{quote(cache_path)}?mode=ro',))

    @classmethod
    def create(cls):
        cache_path = ss.DB_PATH
        return cls(os.path.join(os.path.dirname(cache_path), STAGE_FILE), cache_path)

    def discard(self):
        try:
            if self.conn is not None:
                self.conn.close()
        except sqlite3.Error:
            pass
        _remove_owned(self.path)
        if self._lock is not None:
            try:
                self._lock.close()  # releases the flock; the (tiny) lock file stays
            finally:
                self._lock = None

    # -- disk budget ---------------------------------------------------------------------------------------------
    def stage_bytes(self):
        return sum(os.path.getsize(self.path + suffix) for suffix in OWNED_SUFFIXES
                   if os.path.exists(self.path + suffix))

    def _free(self):
        return shutil.disk_usage(os.path.dirname(self.path)).free

    def expect(self, in_scope_rows):
        """Preflight: refuse to start when the free space cannot hold the estimated run."""
        self.expected_rows = int(in_scope_rows * CONTEXT_ROW_FACTOR)
        self.check_disk()

    def check_disk(self):
        """Raises SyncError('insufficient_disk_space') when free space < remaining staging + publish + margin."""
        used = self.stage_bytes()
        per_row = (used / self.rows_staged) if self.rows_staged >= 200 else ESTIMATED_ROW_BYTES
        projected = max(used, per_row * max(self.expected_rows, self.rows_staged))
        need = (projected - used) + PUBLISH_FACTOR * projected + MIN_FREE_BYTES
        free = self._free()
        if free < need:
            raise ss.SyncError(f"insufficient_disk_space: need about {need / 1048576:.0f} MB, "
                               f"{free / 1048576:.0f} MB free (staged {used / 1048576:.0f} MB so far)")

    def check_publish_space(self):
        used = self.stage_bytes()
        need = PUBLISH_FACTOR * used + MIN_FREE_BYTES
        free = self._free()
        if free < need:
            raise ss.SyncError(f"insufficient_disk_space: publish needs about {need / 1048576:.0f} MB, "
                               f"{free / 1048576:.0f} MB free")

    # -- writing ------------------------------------------------------------------------------------------------
    def add_rows(self, rows, kind, rnd, edges=False):
        """Stages parsed rows (one short transaction). Returns the number actually inserted (duplicates are ignored)."""
        item_params, edge_params = [], []
        for r in rows:
            item_params.append((r['id'], kind, rnd, r['title'], r['type'], r['state'], r['project'], r['assigned_to'],
                                r['assigned_avatar'], r['priority'], r['iteration'], r['area_path'], r['parent_id'],
                                r['parent_title'], r['parent_type'], r['story_points'], r['changed_date'],
                                r['created_date'], r['is_bug'], r['is_task'], r['is_unassigned'], r['is_active'],
                                r['is_blocked'], r['is_blocking'], r['url'], json.dumps(r['relations']),
                                r.get('description'), r.get('repro_steps'), r.get('rev')))
            if edges:
                for t in r['_dep_ids']:
                    edge_params.append((r['id'], t, 'd'))
                for t in list(r['_child_ids']) + ([r['parent_id']] if r['parent_id'] else []):
                    edge_params.append((r['id'], t, 'h'))
        try:
            self.conn.execute('BEGIN')
            try:
                cur = self.conn.executemany(_INSERT_ITEM, item_params)
                inserted = cur.rowcount
                if edge_params:
                    self.conn.executemany('INSERT INTO edge (src, dst, kind) VALUES (?, ?, ?)', edge_params)
                self.conn.execute('COMMIT')
            except BaseException:
                try:
                    self.conn.execute('ROLLBACK')
                except sqlite3.Error:
                    pass
                raise
        except sqlite3.OperationalError as e:  # disk full, I/O error ... : the cache has not been touched
            raise ss.SyncError(f"staging_write_failed: {e}") from e
        self.rows_staged += inserted
        self.check_disk()
        return inserted

    def set_scope(self, ids):
        self.conn.execute('BEGIN')
        self.conn.executemany('INSERT OR IGNORE INTO scope (id) VALUES (?)', ((i,) for i in ids))
        self.conn.execute('COMMIT')

    # -- reading ------------------------------------------------------------------------------------------------
    def count(self, *kinds):
        return self.conn.execute(
            f'SELECT COUNT(*) FROM item WHERE kind IN ({_marks(len(kinds))})', kinds).fetchone()[0]

    def alive_subset(self, ids):
        """Subset of ``ids`` that the cache holds as a live row with relations (the ``_alive_ids`` definition)."""
        found = set()
        for chunk in _chunks(ids, LOOKUP_CHUNK):
            found.update(r[0] for r in self.conn.execute(
                f'SELECT id FROM m.work_items WHERE id IN ({_marks(len(chunk))}) AND deleted_at IS NULL '
                'AND relations_json IS NOT NULL', chunk))
        return found

    def staged_subset(self, ids, *kinds):
        found = set()
        for chunk in _chunks(ids, LOOKUP_CHUNK):
            found.update(r[0] for r in self.conn.execute(
                f'SELECT id FROM item WHERE id IN ({_marks(len(chunk))}) AND kind IN ({_marks(len(kinds))})',
                list(chunk) + list(kinds)))
        return found

    def max_changed_date(self):
        row = self.conn.execute(
            f"SELECT MAX(changed_date) FROM item WHERE kind IN ({_marks(len(MAIN_KINDS))})", MAIN_KINDS).fetchone()
        return row[0]


# ----------------------------------------------------------------------------------------------------------------
# Fetch: stream -> parse -> stage, closure over the staged link table
# ----------------------------------------------------------------------------------------------------------------

def _stream(client, ids, **kw):
    gen = client.iter_batches(ids, **kw)
    try:
        yield from gen
    finally:
        gen.close()


def _collect_context(stage, client, org_url, run, retry, retry_sources):
    """``sync_service._collect_context`` over the staged link table (same rounds, cap and warnings)."""
    conn = stage.conn
    for round_no in range(ss.MAX_CLOSURE_ROUNDS):
        conn.execute('DELETE FROM want')
        conn.execute('BEGIN')
        if round_no == 0:
            conn.executemany('INSERT OR IGNORE INTO want (id, kind) VALUES (?, ?)',
                             [(i, 'h') for i, k in retry.items() if k == 'hier'])
        conn.execute("INSERT OR IGNORE INTO want (id, kind) SELECT DISTINCT e.dst, 'h' FROM edge e "
                     "JOIN item i ON i.id = e.src WHERE i.rnd = ? AND e.kind = 'h'", (round_no,))
        if round_no == 0:
            conn.executemany('INSERT OR IGNORE INTO want (id, kind) VALUES (?, ?)',
                             [(i, 'd') for i, k in retry.items() if k != 'hier'])
        conn.execute("INSERT OR IGNORE INTO want (id, kind) SELECT DISTINCT e.dst, 'd' FROM edge e "
                     "JOIN item i ON i.id = e.src WHERE i.rnd = ? AND e.kind = 'd'", (round_no,))
        # skip = rows read in this run (main, context, dependency-only) | rows the cache already holds
        conn.execute('DELETE FROM want WHERE id IN (SELECT id FROM item WHERE kind IN (0, 1, 2)) '
                     'OR id IN (SELECT id FROM m.work_items WHERE deleted_at IS NULL AND relations_json IS NOT NULL)')
        conn.execute('COMMIT')
        wanted = conn.execute('SELECT COUNT(*) FROM want').fetchone()[0]
        if not wanted:
            break
        staged_ctx = stage.count(KIND_CTX_HIER, KIND_CTX_DEP)
        if staged_ctx + wanted > ss.MAX_CONTEXT_ITEMS:
            run.warn(f"context_cap_reached:{ss.MAX_CONTEXT_ITEMS}", partial=True)
            break

        ids = [r[0] for r in conn.execute('SELECT id FROM want ORDER BY id')]
        failed, missing = 0, []
        for fr in _stream(client, ids, expand_relations=True, error_policy_omit=True):
            failed += sum(len(b) for b in fr.failed_batches)
            missing.extend(fr.missing)
            kinds = {r[0]: r[1] for r in conn.execute(
                f'SELECT id, kind FROM want WHERE id IN ({_marks(len(fr.items))})', list(fr.items))} if fr.items else {}
            hier, dep = [], []
            for item_id, raw in fr.items.items():
                row = ss.parse_work_item(raw, org_url)
                (hier if kinds.get(item_id) == 'h' else dep).append(row)
            stage.add_rows(hier, KIND_CTX_HIER, round_no + 1, edges=True)
            stage.add_rows(dep, KIND_CTX_DEP, -1)
        if failed:
            run.warn(f"context_fetch_failed:{failed}", partial=True)
        if missing:
            run.warn(f"context_missing:{len(missing)}")  # dangling link (deleted / inaccessible), not a data gap
            want_kind = {}
            for chunk in _chunks(missing, LOOKUP_CHUNK):
                want_kind.update({r[0]: r[1] for r in conn.execute(
                    f'SELECT id, kind FROM want WHERE id IN ({_marks(len(chunk))})', chunk)})
            for i in missing:
                carried = retry_sources.get(i, [])
                if carried is None:
                    sources = None
                else:
                    merged = dict(carried)
                    # rows read in this run that link to the missing id; a hierarchy link wins over a dependency link
                    refs = {}
                    for src, kind in conn.execute(
                            'SELECT e.src, e.kind FROM edge e JOIN item i ON i.id = e.src '
                            'WHERE e.dst = ? AND i.rnd BETWEEN 0 AND ?', (i, round_no)):
                        if kind == 'h' or src not in refs:
                            refs[src] = 'hier' if kind == 'h' else 'dep'
                    merged.update(refs)
                    sources = None if len(merged) > ss.CLOSURE_SOURCES_MAX else sorted(merged.items())
                run.closure_missing[i] = ('hier' if want_kind.get(i) == 'h' else 'dep', sources)
    else:
        run.warn("context_rounds_exhausted", partial=True)


def _plan_reconciliation(stage, client, org_url, ids, run):
    """``sync_service._plan_reconciliation`` with the cached scope compared inside SQLite. Returns delete ids."""
    conn = stage.conn
    stage.set_scope(ids)
    cached_total = conn.execute('SELECT COUNT(*) FROM m.work_items WHERE deleted_at IS NULL AND is_active = 1 '
                                'AND is_context = 0').fetchone()[0]
    candidates = [r[0] for r in conn.execute(
        'SELECT id FROM m.work_items WHERE deleted_at IS NULL AND is_active = 1 AND is_context = 0 '
        'AND id NOT IN (SELECT id FROM scope) ORDER BY id')]
    if not candidates:
        return []
    limit = max(ss.MASS_DELETE_FLOOR, int(cached_total * ss.MASS_DELETE_RATIO))
    if len(candidates) > limit:
        run.warn(f"mass_delete_blocked:{len(candidates)}>{limit}", partial=True)
        return []
    failed, missing = 0, []
    for fr in _stream(client, candidates, expand_relations=True, error_policy_omit=True):
        failed += sum(len(b) for b in fr.failed_batches)
        missing.extend(fr.missing)
        rows = [ss.parse_work_item(raw, org_url) for raw in fr.items.values()]
        run.out_of_scope += sum(1 for r in rows if r['is_active'] == 0)
        stage.add_rows(rows, KIND_RECONCILE, -1)
    if failed:
        run.warn(f"reconcile_fetch_failed:{failed}", partial=True)
        return []  # absence is unknown for failed batches: nothing is deleted this run
    return missing


def fetch_phase(org_url, pat, run, force_full, max_items, client):
    stage = StageStore.create()
    try:
        return _fetch_into_stage(stage, org_url, run, force_full, max_items, client)
    except BaseException:
        stage.discard()
        raise


def _fetch_into_stage(stage, org_url, run, force_full, max_items, client):
    sel = ss._select_ids(run, force_full, max_items, client)
    stage.expect(len(sel['read_ids']))  # preflight: nothing is fetched when the disk cannot hold the run
    is_incremental, ids, truncated, unchanged = sel['is_incremental'], sel['ids'], sel['truncated'], sel['unchanged']
    last_watermark = sel['last_watermark']

    # Same contract as the in-memory read: every batch gets its own retries, the run errors afterwards with the total
    # (and the first two errors). After the first failed batch nothing more is staged - the run cannot publish.
    missing_detail, failed_ids, errors = 0, 0, []
    for fr in _stream(client, sel['read_ids'], expand_relations=True, error_policy_omit=True):
        if fr.failed_batches:
            failed_ids += sum(len(b) for b in fr.failed_batches)
            errors.extend(fr.errors)
        if failed_ids:
            continue
        missing_detail += len(fr.missing)
        rows = [ss.parse_work_item(raw, org_url) for raw in fr.items.values()]
        run.skipped += len(rows) - stage.add_rows(rows, KIND_MAIN, 0, edges=True)
    if failed_ids:
        raise ss.SyncError(f"details_fetch_failed:{failed_ids} ids ({'; '.join(errors[:2])})")
    if missing_detail:
        run.warn(f"missing_detail:{missing_detail}")
    run.details_fetched = stage.count(KIND_MAIN)
    run.fetched = run.details_fetched + len(unchanged)

    prior_missing = ss._load_closure_missing()
    now_iso = ss._utcnow().isoformat()
    linked = sorted({s for _k, _f, sources in prior_missing.values() if sources for s, _kind in sources})
    alive, read_now = stage.alive_subset(linked), stage.staged_subset(linked, KIND_MAIN)
    retry, retry_sources = {}, {}
    for i, (kind, first_seen, sources) in prior_missing.items():
        if ss._retry_expired(first_seen, last_watermark):
            continue
        if sources is None:
            retry[i], retry_sources[i] = kind, None
            continue
        still_linked = [(s, k) for s, k in sources if s in alive and s not in read_now]
        if still_linked:
            retry[i] = 'hier' if any(k == 'hier' for _, k in still_linked) else 'dep'
            retry_sources[i] = still_linked
    _collect_context(stage, client, org_url, run, retry, retry_sources)
    closure_missing = {str(i): [kind, prior_missing[i][1] if i in retry else now_iso, sources]
                       for i, (kind, sources) in run.closure_missing.items()}

    conn = stage.conn
    if not is_incremental and run.complete and not truncated:
        hollow_ids = [r[0] for r in conn.execute(
            'SELECT id FROM m.work_items WHERE deleted_at IS NULL AND (relations_json IS NULL OR last_seen_at IS NULL) '
            'ORDER BY id')]
        hollow_needed = _not_staged(stage, hollow_ids)
        for fr in _stream(client, hollow_needed, expand_relations=True, error_policy_omit=True):
            stage.add_rows([ss.parse_work_item(raw, org_url) for raw in fr.items.values()], KIND_HOLLOW, -1)

    delete_ids = []
    if not is_incremental and run.complete and not truncated:
        delete_ids = _plan_reconciliation(stage, client, org_url, ids, run)

    return {
        'is_incremental': is_incremental, 'closure_missing': closure_missing, 'unchanged': unchanged,
        'delete_ids': delete_ids, 'last_watermark': last_watermark, 'stage': stage,
    }


def _not_staged(stage, ids):
    staged = set()
    for chunk in _chunks(ids, LOOKUP_CHUNK):
        staged.update(stage.staged_subset(chunk, KIND_MAIN, KIND_CTX_HIER, KIND_CTX_DEP))
    return [i for i in ids if i not in staged]


# ----------------------------------------------------------------------------------------------------------------
# Derived data and orphan scan, in bounded chunks
# ----------------------------------------------------------------------------------------------------------------

def recompute_derived_bounded(conn, chunk=DERIVED_CHUNK):
    """``sync_service.recompute_derived`` that reads ``chunk`` rows at a time (keyset pagination on id) and looks the
    relation targets of each chunk up by primary key. The columns it reads from targets (title, type, state,
    assigned_to, project) are never written here, so the result does not depend on the chunking."""
    stats = {"rows_scanned": 0, "rows_updated": 0, "newly_unblocked": 0, "newly_blocked": 0}
    last = -1
    while True:
        rows = conn.execute(
            'SELECT id, title, type, state, project, assigned_to, parent_id, parent_title, parent_type, '
            'relations_json, is_blocked, is_blocking FROM work_items WHERE deleted_at IS NULL AND id > ? '
            'ORDER BY id LIMIT ?', (last, chunk)).fetchall()
        if not rows:
            break
        last = rows[-1]['id']
        stats['rows_scanned'] += len(rows)

        parsed, need = [], set()
        for r in rows:
            relations = {}
            if r['relations_json']:
                try:
                    relations = json.loads(r['relations_json'])
                except Exception:  # noqa: BLE001 - same tolerance as the in-memory version
                    relations = {}
            parsed.append(relations)
            for key in ('predecessors', 'successors', 'related'):
                for entry in relations.get(key) or []:
                    need.add(entry.get('id'))
            if r['parent_id']:
                need.add(r['parent_id'])
        need = [i for i in need if isinstance(i, int) and not isinstance(i, bool)]
        by_id = {}
        for ids in _chunks(need, LOOKUP_CHUNK):
            for t in conn.execute(
                    f'SELECT id, title, type, state, project, assigned_to FROM work_items '
                    f'WHERE id IN ({_marks(len(ids))}) AND deleted_at IS NULL', ids):
                by_id[t['id']] = t

        updates = []
        for r, relations in zip(rows, parsed):
            preds = relations.get('predecessors') or []
            succs = relations.get('successors') or []
            related = relations.get('related') or []
            changed = False
            for entry in preds + succs + related:
                target = by_id.get(entry.get('id'))
                if target is None:
                    continue
                snapshot = {'title': target['title'], 'type': target['type'], 'state': target['state'],
                            'assignedTo': target['assigned_to'] or '', 'project': target['project']}
                for k, v in snapshot.items():
                    if entry.get(k) != v:
                        entry[k] = v
                        changed = True
            blocked = 0
            for p in preds:
                state = p.get('state')
                if state is None or str(state).strip() == '':
                    continue
                if not ss.is_state_completed(state, p.get('type')):
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
            conn.executemany('UPDATE work_items SET relations_json = ?, is_blocked = ?, is_blocking = ?, '
                             'parent_title = ?, parent_type = ? WHERE id = ?', updates)
        stats['rows_updated'] += len(updates)
    return stats


def find_orphan_context_ids_bounded(conn):
    """``sync_service._find_orphan_context_ids`` with the needed-set kept in a temp table instead of Python sets.

    Needed = in-scope rows, their ancestors, every descendant of those and the relation targets of in-scope rows."""
    conn.execute('DROP TABLE IF EXISTS temp.needed_up')
    conn.execute('DROP TABLE IF EXISTS temp.needed')
    conn.execute('CREATE TEMP TABLE needed_up (id INTEGER PRIMARY KEY)')
    conn.execute('CREATE TEMP TABLE needed (id INTEGER PRIMARY KEY)')
    try:
        conn.execute('''
            WITH RECURSIVE up(id) AS (
                SELECT id FROM work_items WHERE deleted_at IS NULL AND is_context = 0
                UNION
                SELECT w.parent_id FROM work_items w JOIN up ON w.id = up.id
                WHERE w.parent_id IS NOT NULL AND w.parent_id != 0
                  AND w.parent_id IN (SELECT id FROM work_items WHERE deleted_at IS NULL)
            ) INSERT INTO needed_up SELECT id FROM up''')
        conn.execute('''
            WITH RECURSIVE down(id) AS (
                SELECT id FROM needed_up
                UNION
                SELECT w.id FROM work_items w JOIN down ON w.parent_id = down.id WHERE w.deleted_at IS NULL
            ) INSERT INTO needed SELECT id FROM down''')
        last = -1
        while True:
            rows = conn.execute(
                'SELECT id, relations_json FROM work_items WHERE deleted_at IS NULL AND is_context = 0 AND id > ? '
                'ORDER BY id LIMIT ?', (last, DERIVED_CHUNK)).fetchall()
            if not rows:
                break
            last = rows[-1]['id']
            targets = set()
            for r in rows:
                if not r['relations_json']:
                    continue
                try:
                    rel = json.loads(r['relations_json'])
                except Exception:  # noqa: BLE001
                    continue
                for key in ('predecessors', 'successors', 'related'):
                    for e in rel.get(key) or []:
                        t = e.get('id')
                        if isinstance(t, int) and not isinstance(t, bool):
                            targets.add(t)
            for ids in _chunks(targets, LOOKUP_CHUNK):
                conn.execute(f'INSERT OR IGNORE INTO needed SELECT id FROM work_items '
                             f'WHERE id IN ({_marks(len(ids))}) AND deleted_at IS NULL', ids)
        return [r[0] for r in conn.execute(
            'SELECT id FROM work_items WHERE deleted_at IS NULL AND is_context = 1 '
            'AND id NOT IN (SELECT id FROM temp.needed) ORDER BY id')]
    finally:
        conn.execute('DROP TABLE IF EXISTS temp.needed_up')
        conn.execute('DROP TABLE IF EXISTS temp.needed')


# ----------------------------------------------------------------------------------------------------------------
# Apply: one transaction on the real cache
# ----------------------------------------------------------------------------------------------------------------

_SELECT_COLS = ('id, title, type, state, project, assigned_to, assigned_avatar, priority, iteration, area_path, '
                'parent_id, parent_title, parent_type, story_points, changed_date, created_date, is_bug, is_task, '
                'is_unassigned, is_active, is_blocked, is_blocking, url, relations_json, :now, :now, NULL, :ctx, '
                'description, repro_steps, rev')
_APPLY_MAIN = (f"INSERT INTO work_items ({ss._UPSERT_COLUMNS}) SELECT {_SELECT_COLS} FROM stg.item "
               f"WHERE kind IN ({', '.join(map(str, MAIN_KINDS))}) ORDER BY id "
               f"ON CONFLICT(id) DO UPDATE SET {ss._UPSERT_UPDATE}")
_APPLY_CONTEXT = (f"INSERT INTO work_items ({ss._UPSERT_COLUMNS}) SELECT {_SELECT_COLS} FROM stg.item "
                  f"WHERE kind IN ({', '.join(map(str, CONTEXT_KINDS))}) ORDER BY id "
                  f"ON CONFLICT(id) DO UPDATE SET {ss._UPSERT_UPDATE} "
                  "WHERE work_items.is_context = 1 OR work_items.is_active = 0 OR work_items.relations_json IS NULL")


def apply_phase(plan, run):
    """Publishes the staged run in ONE SQLite transaction (same contract as ``sync_service._apply_phase``)."""
    stage = plan['stage']
    now_iso = ss._utcnow().isoformat()
    unchanged = plan.get('unchanged') or []
    new_watermark = plan['last_watermark']
    for cd in [stage.max_changed_date()] + [cd for _, cd in unchanged]:
        if cd and (not new_watermark or cd > new_watermark):
            new_watermark = cd
    main_count, ctx_count = stage.count(*MAIN_KINDS), stage.count(*CONTEXT_KINDS)
    stage.check_publish_space()  # before the cache is opened for writing
    stage.conn.close()  # the cache connection below attaches the file itself; the stage connection is done

    conn = ss.get_db_connection()
    conn.isolation_level = None
    try:
        conn.execute('ATTACH DATABASE ? AS stg', (stage.path,))  # read-only use: only SELECTs touch it
    except sqlite3.OperationalError:
        conn.close()
        raise
    try:
        with ss.db_lock:
            conn.execute('BEGIN IMMEDIATE')
            try:
                conn.execute(_APPLY_MAIN, {'now': now_iso, 'ctx': 0})
                if unchanged:
                    conn.executemany(
                        'UPDATE work_items SET last_synced_at = ?, last_seen_at = ? '
                        'WHERE id = ? AND deleted_at IS NULL AND is_context = 0',
                        [(now_iso, now_iso, i) for i, _ in unchanged])
                run.upserted = main_count + len(unchanged)
                conn.execute(_APPLY_CONTEXT, {'now': now_iso, 'ctx': 1})
                run.context_upserted = ctx_count

                if plan['delete_ids'] and run.complete:
                    conn.executemany('UPDATE work_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
                                     [(now_iso, i) for i in plan['delete_ids']])
                    run.deleted = len(plan['delete_ids'])

                if not plan['is_incremental'] and run.complete:
                    orphans = ss._find_orphan_context_ids(conn)
                    if orphans:
                        conn.executemany('UPDATE work_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
                                         [(now_iso, i) for i in orphans])
                    run.orphans_removed = len(orphans)

                run.derived = ss.recompute_derived(conn)

                cm = plan.get('closure_missing') or {}
                cm_overflow = len(cm) > ss.CLOSURE_RETRY_MAX
                if cm_overflow:
                    cm = dict(sorted(cm.items(), key=lambda kv: kv[1][1], reverse=True)[:ss.CLOSURE_RETRY_MAX])
                ss._set_meta(conn, 'closure_dirty', '0' if run.complete and not cm_overflow else '1', now_iso)
                if run.complete:
                    ss._set_meta(conn, 'closure_missing', json.dumps(cm), now_iso)
                    if new_watermark:
                        ss._set_meta(conn, 'watermark', new_watermark, now_iso)
                    if not plan['is_incremental']:
                        ss._set_meta(conn, 'last_full_sync', now_iso, now_iso)
                        ss._set_meta(conn, 'total_org_active', run.total_scope or 0, now_iso)
                    ss._set_meta(conn, 'last_incremental_sync', now_iso, now_iso)
                    ss._set_meta(conn, 'last_success_at', now_iso, now_iso)
                conn.execute('COMMIT')
            except BaseException:
                try:
                    conn.execute('ROLLBACK')
                except sqlite3.OperationalError:
                    pass  # SQLite already rolled back (disk full / I/O error): keep the original error, not this one
                raise
    finally:
        conn.close()
