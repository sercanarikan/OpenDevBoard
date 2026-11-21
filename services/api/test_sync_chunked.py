"""Bounded-memory (staged / chunked) sync: parity with the in-memory sync and transactional safety.

Everything runs offline against the in-memory fake of Azure DevOps used by the hardening tests. The reference is the
in-memory sync (``SYNC_CHUNKED`` unset); the candidate is the staged sync (``SYNC_CHUNKED=1``). Both are run from an
empty cache on the same synthetic organisation and must leave the same table, the same counters / meta and the same
user-facing list.
"""
import json
import os
import random
import re
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

import testsupport  # noqa: E402,F401  (must precede the project imports)
import azure_client  # noqa: E402
import query_service  # noqa: E402
import sync_service  # noqa: E402
import sync_staging  # noqa: E402
from test_sync_hardening import FakeAzure, Resp, raw_item, reset_db, ORG  # noqa: E402

testsupport.isolate_database(globals())

VOLATILE = ('last_synced_at', 'last_seen_at')
META_KEYS = ('watermark', 'closure_dirty', 'closure_missing', 'total_org_active')
RESULT_KEYS = ('status', 'mode', 'fetched', 'upserted', 'deleted', 'out_of_scope', 'context_upserted',
               'orphans_removed', 'skipped', 'details_fetched', 'unchanged_skipped', 'partitions', 'derived',
               'synced_count', 'total_active')


def build_org(n_tasks=900, seed=7):
    """~1.2k items: epics > features > stories > tasks, completed ancestors / descendants outside the scope,
    predecessor / successor / related links (some to completed items), and a dangling link."""
    rnd = random.Random(seed)
    epics, feats, stories = list(range(1, 6)), list(range(6, 31)), list(range(31, 131))
    tasks = list(range(131, 131 + n_tasks))
    done_extra = list(range(5000, 5300))  # completed siblings under active stories (descendants needed for progress)
    parent, children = {}, {}
    for f in feats:
        parent[f] = rnd.choice(epics)
    for s in stories:
        parent[s] = rnd.choice(feats)
    for t in tasks:
        parent[t] = rnd.choice(stories)
    for d in done_extra:
        parent[d] = rnd.choice(stories)
    for c, p in parent.items():
        children.setdefault(p, []).append(c)
    state = {}
    for i in epics + feats + stories:
        state[i] = 'Active'
    state[epics[0]] = 'Closed'  # a completed ancestor: context only
    for k, t in enumerate(tasks):
        state[t] = ('New', 'Active', 'Resolved', 'Done')[k % 4]
    for d in done_extra:
        state[d] = 'Done'
    preds, succs, related = {}, {}, {}
    everyone = tasks + stories
    for t in tasks[::3]:
        p = rnd.choice(everyone + done_extra)
        if p != t:
            preds.setdefault(t, []).append(p)
            succs.setdefault(p, []).append(t)
    for t in tasks[::5]:
        r = rnd.choice(everyone)
        if r != t:
            related.setdefault(t, []).append(r)
    preds.setdefault(tasks[1], []).append(99999)  # dangling link: inaccessible target
    items = []
    for i in sorted(state):
        items.append(raw_item(
            i, state=state[i], parent=parent.get(i), children=children.get(i, ()), preds=preds.get(i, ()),
            succs=succs.get(i, ()), related=related.get(i, ()), project=f'P{i % 3}',
            changed=f'2026-11-{1 + i % 20:02d}T08:00:00Z', assigned=(None if i % 11 == 0 else f'User {i % 7}'),
            wtype=('Epic' if i in epics else 'Feature' if i in feats else 'User Story' if i in stories
                   else 'Bug' if i % 13 == 0 else 'Task')))
    return items


def snapshot():
    """Everything a user or a later sync can observe, minus wall-clock bookkeeping."""
    with sync_service.get_db_connection() as c:
        table = [{k: (('DELETED' if r[k] else None) if k == 'deleted_at' else r[k])  # deletion time is wall-clock
                  for k in r.keys() if k not in VOLATILE} for r in c.execute('SELECT * FROM work_items ORDER BY id')]
        meta = {r['key']: r['val'] for r in c.execute('SELECT key, val FROM sync_state')
                if r['key'] in META_KEYS}
    if 'closure_missing' in meta:  # first-seen timestamps are wall-clock
        meta['closure_missing'] = re.sub(r'\d{4}-\d\d-\d\dT[\d:.]+', 'TS', meta['closure_missing'])
    listing, offset, total = [], 0, None
    while total is None or offset < total:
        page = query_service.list_work_items(query_service.parse_list_params({'limit': '200', 'offset': str(offset)}))
        total = page['total']
        listing.extend({k: v for k, v in it.items() if k not in ('lastSyncedAt', 'last_synced_at')} for it in page['items'])
        offset += 200
        if not page['items']:
            break
    counts = {k: v for k, v in sync_service.get_counts().items() if k not in ('last_synced_at', 'sync_status')}
    return {'table': table, 'meta': meta, 'list': listing, 'counts': counts}


def sync_once(fake, chunked, workers='1', **kw):
    env = {'SYNC_CHUNKED': '1' if chunked else '', 'SYNC_DETAIL_WORKERS': workers}
    with mock.patch.dict(os.environ, env), fake.patch_all(), mock.patch.object(sync_service, '_sleep', lambda s: None):
        return sync_service.sync_work_items(ORG, 'pat', **kw)


def stage_path():
    return os.path.join(os.path.dirname(sync_service.DB_PATH), sync_staging.STAGE_FILE)


class OptIn(unittest.TestCase):
    def test_staging_is_off_unless_explicitly_enabled(self):
        for value, expected in ((None, False), ('', False), ('0', False), ('false', False), ('2', False), ('1', True), (' 1 ', True)):
            env = {k: v for k, v in os.environ.items() if k != 'SYNC_CHUNKED'}
            if value is not None:
                env['SYNC_CHUNKED'] = value
            with self.subTest(value=value), mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(sync_staging.chunked_enabled(), expected)

    def test_default_sync_never_creates_a_staging_file(self):
        reset_db()
        created = []
        real = sync_staging.StageStore.create
        with mock.patch.object(sync_staging.StageStore, 'create', lambda *a, **k: created.append(1) or real()):
            res = sync_once(FakeAzure(build_org()), False, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(created, [])
        self.assertFalse(os.path.exists(stage_path()))


class Parity(unittest.TestCase):
    maxDiff = 1500

    def setUp(self):
        reset_db()

    def _compare(self, scenario, workers='1'):
        """``scenario(fake, chunked)`` drives one or more syncs; the final state of both modes must be equal."""
        out = {}
        for chunked in (False, True):
            reset_db()
            results = scenario(chunked, workers)
            out[chunked] = (snapshot(), [{k: r.get(k) for k in RESULT_KEYS} for r in results],
                            [sorted(r.get('warnings') or []) for r in results])
        self.assertEqual(out[True][1], out[False][1])
        self.assertEqual(out[True][2], out[False][2])
        self.assertEqual(out[True][0]['meta'], out[False][0]['meta'])
        self.assertEqual(out[True][0]['counts'], out[False][0]['counts'])
        self.assertEqual(out[True][0]['table'], out[False][0]['table'])
        self.assertEqual(out[True][0]['list'], out[False][0]['list'])
        self.assertGreater(len(out[False][0]['table']), 300)
        return out

    def test_full_sync_matches_the_in_memory_sync(self):
        def scenario(chunked, workers):
            return [sync_once(FakeAzure(build_org()), chunked, workers, force_full=True)]
        out = self._compare(scenario)
        self.assertEqual(out[True][1][0]['status'], 'success')
        ctx = [r for r in out[True][0]['table'] if r['is_context']]
        self.assertTrue(ctx, 'the world must contain context rows')
        self.assertTrue(any(r['is_blocked'] for r in out[True][0]['table']))

    def test_full_sync_with_parallel_workers_matches(self):
        def scenario(chunked, workers):
            return [sync_once(FakeAzure(build_org()), chunked, workers, force_full=True)]
        self._compare(scenario, workers='4')

    def test_second_full_and_incremental_sync_match(self):
        def scenario(chunked, workers):
            fake = FakeAzure(build_org())
            res = [sync_once(fake, chunked, workers, force_full=True)]
            # a predecessor completes, an item is removed from Azure, one changes state, one reappears as a child
            fake.items[131] = raw_item(131, state='Done', succs=[134], parent=fake.items[131]['fields'].get('System.Parent'))
            del fake.items[140]
            res.append(sync_once(fake, chunked, workers))              # incremental (watermark from the first run)
            res.append(sync_once(fake, chunked, workers, force_full=True))  # full again: reconciliation + orphans
            return res
        self._compare(scenario)

    def test_context_cap_partial_result_matches(self):
        def scenario(chunked, workers):
            with mock.patch.object(sync_service, 'MAX_CONTEXT_ITEMS', 20):
                return [sync_once(FakeAzure(build_org()), chunked, workers, force_full=True)]
        out = self._compare(scenario)
        self.assertEqual(out[True][1][0]['status'], 'partial')
        self.assertIn('context_cap_reached:20', out[True][2][0])
        self.assertNotIn('watermark', out[True][0]['meta'])  # a partial run never advances the watermark

    def test_explicit_request_budget_is_partial_and_does_not_advance_closure_markers(self):
        env = {'SYNC_CONTEXT_POLICY': 'budgeted', 'SYNC_CONTEXT_MAX_ITEMS': '10000',
               'SYNC_CONTEXT_MAX_REQUESTS': '3'}
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                with mock.patch.dict(os.environ, env):
                    result = sync_once(FakeAzure(build_org(n_tasks=200)), chunked, '4', force_full=True)
                self.assertEqual(result['status'], 'partial')
                self.assertIn('context_request_budget_reached:3', result['warnings'])
                self.assertIsNone(sync_service.get_sync_meta('watermark'))
                self.assertIsNone(sync_service.get_sync_meta('last_full_sync'))
                self.assertIsNone(sync_service.get_sync_meta('last_success_at'))
                self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '1')

    def test_budgeted_sync_has_cache_relation_and_derived_parity_for_worker_counts(self):
        env = {'SYNC_CONTEXT_POLICY': 'budgeted', 'SYNC_CONTEXT_MAX_ITEMS': '10000',
               'SYNC_CONTEXT_MAX_REQUESTS': '1000'}
        for workers in ('1', '4', '8'):
            with self.subTest(workers=workers), mock.patch.dict(os.environ, env):
                def scenario(chunked, worker_count):
                    return [sync_once(FakeAzure(build_org(n_tasks=500)), chunked, worker_count,
                                      force_full=True)]
                out = self._compare(scenario, workers=workers)
                self.assertEqual(out[True][1][0]['status'], 'success')
                self.assertTrue(out[True][0]['meta']['watermark'])
                self.assertEqual(out[True][0]['meta'].get('closure_dirty'), '0')

    def test_missing_detail_and_dangling_links_match(self):
        def scenario(chunked, workers):
            fake = FakeAzure(build_org())
            original = fake._match_wiql
            fake._match_wiql = lambda q: original(q) + [888888]  # listed by WIQL but gone by the time it is read
            return [sync_once(fake, chunked, workers, force_full=True)]
        out = self._compare(scenario)
        self.assertTrue(any(w.startswith('missing_detail') for w in out[True][2][0]))

    def test_more_than_one_chunk_of_context_rounds(self):
        """A long ancestor chain needs one closure round per level: every round must be staged and linked."""
        def scenario(chunked, workers):
            chain = [raw_item(1, state='New', parent=2)]
            for i in range(2, 9):
                chain.append(raw_item(i, state='Closed', parent=i + 1 if i < 8 else None, children=[i - 1]))
            return [sync_once(FakeAzure(chain), chunked, workers, force_full=True)]
        # only the leaf is in scope (the others are Closed): the 7 ancestors are fetched round by round
        out = {}
        for chunked in (False, True):
            reset_db()
            out[chunked] = scenario(chunked, '1')[0]
        self.assertEqual(out[True]['context_upserted'], out[False]['context_upserted'])
        self.assertEqual(out[True]['status'], out[False]['status'])


class BoundedHelpersMatchInMemoryOnes(unittest.TestCase):
    """The chunked recompute / orphan scan against the originals on a database full of awkward rows."""

    def _awkward_db(self, path, seed):
        rnd = random.Random(seed)
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        with sync_service.get_db_connection() as src:
            schema = [r[0] for r in src.execute("SELECT sql FROM sqlite_master WHERE name = 'work_items'")][0]
        conn.execute(schema)
        n = 600
        for i in range(1, n + 1):
            def entry(t):
                return {'id': t, 'relType': 'x', 'relName': 'x', 'comment': '', 'url': 'u'}
            rel = {'predecessors': [entry(rnd.randint(1, n + 30)) for _ in range(rnd.randint(0, 2))],
                   'successors': [entry(rnd.randint(1, n + 30)) for _ in range(rnd.randint(0, 2))],
                   'related': [entry(rnd.randint(1, n + 30)) for _ in range(rnd.randint(0, 1))], 'total': 0}
            rel_json = json.dumps(rel)
            if i % 50 == 0:
                rel_json = '{not json'      # corrupt
            if i % 57 == 0:
                rel_json = None
            parent = rnd.choice([None, rnd.randint(1, n)]) if i % 9 else (i + 1 if i % 2 else i - 1)  # cycles
            conn.execute(
                'INSERT INTO work_items (id, title, type, state, project, assigned_to, parent_id, is_context, '
                'deleted_at, relations_json, is_blocked, is_blocking, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (i, f'T{i}', 'Task', rnd.choice(['New', 'Done', 'Active', 'Resolved', '']), f'P{i % 3}',
                 rnd.choice([None, 'Ada', '']), parent, 1 if rnd.random() < 0.4 else 0,
                 '2026-01-01' if rnd.random() < 0.1 else None, rel_json, rnd.randint(0, 1), rnd.randint(0, 1), 1))
        conn.commit()
        return conn

    def test_recompute_derived_is_identical(self):
        for seed in (1, 2, 3):
            with tempfile.TemporaryDirectory() as d:
                a = self._awkward_db(os.path.join(d, 'a.db'), seed)
                b = self._awkward_db(os.path.join(d, 'b.db'), seed)
                sa = sync_service.recompute_derived_inmemory(a)
                sb = sync_staging.recompute_derived_bounded(b, chunk=37)  # tiny chunks: many chunk borders
                self.assertEqual(sa, sb)
                self.assertGreater(sa['rows_updated'], 0)
                dump = lambda c: [tuple(r) for r in c.execute('SELECT * FROM work_items ORDER BY id')]  # noqa: E731
                self.assertEqual(dump(a), dump(b))
                a.close(), b.close()

    def test_orphan_scan_is_identical(self):
        for seed in (1, 2, 3, 4):
            with tempfile.TemporaryDirectory() as d:
                a = self._awkward_db(os.path.join(d, 'a.db'), seed)
                self.assertEqual(sync_service.find_orphan_context_ids_inmemory(a),
                                 sync_staging.find_orphan_context_ids_bounded(a))
                a.close()


class StreamingClient(unittest.TestCase):
    def test_iter_batches_matches_get_items_and_bounds_the_window(self):
        started = []

        class Probe(azure_client.AzureClient):
            def _fetch_one(self, batch, *a, **k):
                started.append(batch[0])
                return {'value': [{'id': i} for i in batch]}, None

        ids = list(range(1, 200 * 40 + 1))
        reference = Probe(ORG, 'pat', workers=1).get_items(ids)
        for workers in (1, 4):
            started.clear()
            client, seen = Probe(ORG, 'pat', workers=workers), {}
            for consumed, fr in enumerate(client.iter_batches(ids), 1):
                seen.update(fr.items)
                # the stream never runs more than 2 * workers batches ahead of the consumer
                self.assertLessEqual(len(started) - consumed, 2 * workers)
            self.assertEqual(len(started), 40)
            self.assertEqual(seen, reference.items)  # same items, same order of ids, whatever the worker count

    def test_workers_released_when_the_consumer_stops_early(self):
        class Probe(azure_client.AzureClient):
            def _fetch_one(self, batch, *a, **k):
                return {'value': [{'id': i} for i in batch]}, None

        c = Probe(ORG, 'pat', workers=4)
        gen = c.iter_batches(range(1, 5001))
        next(gen)
        gen.close()
        self.assertIsNone(c._limiter)
        self.assertTrue(c._fanout_lock.acquire(blocking=False))  # the fan-out lock was released
        c._fanout_lock.release()


class Safety(unittest.TestCase):
    def setUp(self):
        reset_db()
        for suffix in ('', '-journal'):
            try:
                os.remove(stage_path() + suffix)
            except FileNotFoundError:
                pass

    def _seeded(self):
        fake = FakeAzure(build_org())
        res = sync_once(fake, True, force_full=True)
        self.assertEqual(res['status'], 'success')
        return fake, snapshot()

    def test_cache_is_untouched_while_chunks_are_staged_and_a_failure_keeps_the_snapshot(self):
        fake, before = self._seeded()
        changed = FakeAzure(build_org(seed=8))   # a different world: every row would change if it were published
        seen = []
        original_get = changed.get

        def spying_get(url, headers=None, timeout=None):
            if 'ids=' in url:
                seen.append(snapshot())          # what a reader sees while chunks are being fetched and staged
                if len(changed.detail_calls) >= 4:
                    return Resp(status=500, text='boom')
            return original_get(url, headers, timeout)

        changed.get = spying_get
        res = sync_once(changed, True, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertTrue(seen)
        for s in seen:
            self.assertEqual(s, before)         # mid-sync: only the previous completed snapshot is visible
        self.assertEqual(snapshot(), before)    # after the failure: table, meta (watermark) and list unchanged
        self.assertFalse(os.path.exists(stage_path()), 'the staging file must not outlive the run')

    def test_http_503_is_retried_and_the_result_equals_a_clean_run(self):
        out = {}
        for flaky in (False, True):
            reset_db()
            fake = FakeAzure(build_org())
            if flaky:
                original, count = fake.get, [0]

                def get(url, headers=None, timeout=None, _o=original, _c=count):
                    if 'ids=' in url:
                        _c[0] += 1
                        if _c[0] in (2, 3, 7):
                            return Resp(status=503, text='unavailable', headers={'Retry-After': '1'})
                    return _o(url, headers, timeout)
                fake.get = get
            res = sync_once(fake, True, workers='4', force_full=True)
            self.assertEqual(res['status'], 'success')
            out[flaky] = snapshot()
        self.assertEqual(out[True]['table'], out[False]['table'])
        self.assertEqual(out[True]['meta'], out[False]['meta'])

    def test_http_429_then_success_equals_a_clean_run(self):
        reset_db()
        clean = FakeAzure(build_org())
        sync_once(clean, True, force_full=True)
        expected = snapshot()
        reset_db()
        throttled = FakeAzure(build_org())
        throttled.rate_limit_first = 3
        res = sync_once(throttled, True, workers='4', force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(snapshot()['table'], expected['table'])

    def test_persistent_outage_keeps_the_previous_cache_and_the_in_memory_error_contract(self):
        """Same requests and same error text as the in-memory read (every batch gets its retries), nothing published."""
        observed = {}
        for chunked in (False, True):
            reset_db()
            sync_once(FakeAzure(build_org()), chunked, force_full=True)
            sync_service.set_sync_meta('initial_full_partial_count', 2)
            sync_service.set_sync_meta('initial_full_retry_at', '2026-11-22T01:00:00+00:00')
            before = snapshot()
            outage = FakeAzure(build_org())
            outage.fail_details_after = 2
            res = sync_once(outage, chunked, force_full=True)
            self.assertEqual(res['status'], 'error')
            self.assertEqual(snapshot(), before)
            self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '2')
            self.assertEqual(sync_service.get_sync_meta('initial_full_retry_at'), '2026-11-22T01:00:00+00:00')
            observed[chunked] = (res['error'], len(outage.detail_calls))
        self.assertEqual(observed[True], observed[False])
        self.assertFalse(os.path.exists(stage_path()))

    def test_failure_in_the_publish_transaction_rolls_back_everything(self):
        fake, before = self._seeded()
        for key, value in (('initial_full_partial_count', '3'),
                           ('initial_full_retry_at', '2026-11-22T01:00:00+00:00')):
            sync_service.set_sync_meta(key, value)
        for chunked in (False, True):
            with self.subTest(chunked=chunked), \
                    mock.patch.object(sync_service, 'recompute_derived', side_effect=RuntimeError('derived failed')):
                res = sync_once(FakeAzure(build_org(seed=9)), chunked, force_full=True)
            self.assertEqual(res['status'], 'error')
            self.assertEqual(snapshot()['table'], before['table'])
            self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '3')
            self.assertEqual(sync_service.get_sync_meta('initial_full_retry_at'), '2026-11-22T01:00:00+00:00')
        self.assertFalse(os.path.exists(stage_path()))

    def test_restart_after_an_interrupted_run_discards_the_leftover_staging_file(self):
        with open(stage_path(), 'wb') as f:
            f.write(b'garbage of a run that was killed')
        res = sync_once(FakeAzure(build_org()), True, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertFalse(os.path.exists(stage_path()))

    def test_process_killed_mid_run_leaves_the_previous_snapshot_and_the_next_run_recovers(self):
        fake, before = self._seeded()
        script = textwrap.dedent('''
            import os, sys
            sys.path.insert(0, %r)
            os.environ['DEVOPS_DATA_DIR'] = %r
            os.environ['SYNC_CHUNKED'] = '1'
            import sync_service, azure_client
            from test_sync_chunked import build_org
            from test_sync_hardening import FakeAzure, ORG
            fake = FakeAzure(build_org(seed=8))
            real = fake.get
            def get(url, headers=None, timeout=None):
                if 'ids=' in url and len(fake.detail_calls) >= 3:
                    os._exit(137)                 # SIGKILL-like: no finally blocks, no rollback code runs
                return real(url, headers, timeout)
            fake.get = get
            with fake.patch_all():
                sync_service.sync_work_items(ORG, 'pat', force_full=True)
        ''') % (os.path.dirname(os.path.abspath(__file__)), os.path.dirname(sync_service.DB_PATH))
        proc = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 137, proc.stderr[-800:])
        self.assertEqual(snapshot()['table'], before['table'])
        # the killed run never reached the publish: the watermark of the last complete run is still there
        self.assertEqual(sync_service.get_sync_meta('watermark'), before['meta']['watermark'])
        sync_service.init_db()
        res = sync_once(FakeAzure(build_org(seed=8)), True, force_full=True)
        self.assertEqual(res['status'], 'success')
        self.assertFalse(os.path.exists(stage_path()))

    def test_staging_never_writes_to_the_cache_before_the_publish(self):
        """The staging connection opens the cache read-only: even a buggy statement cannot write through it."""
        self._seeded()
        stage = sync_staging.StageStore.create()
        try:
            with self.assertRaises(sqlite3.OperationalError):
                stage.conn.execute("UPDATE m.work_items SET title = 'x'")
        finally:
            stage.discard()


class DiskSafety(unittest.TestCase):
    def setUp(self):
        reset_db()
        sync_staging.cleanup_stale_stage()

    def _seeded(self):
        sync_once(FakeAzure(build_org()), True, force_full=True)
        return snapshot()

    def _free(self, nbytes):
        return mock.patch.object(sync_staging.shutil, 'disk_usage',
                                 lambda p: type('U', (), {'free': nbytes, 'total': 10 ** 12, 'used': 0})())

    def test_preflight_refuses_to_start_and_nothing_is_fetched_or_changed(self):
        before = self._seeded()
        fake = FakeAzure(build_org(seed=8))
        with self._free(1024 * 1024):
            res = sync_once(fake, True, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertIn('insufficient_disk_space', res['error'])
        self.assertEqual(fake.detail_calls, [])          # not one detail request: the check precedes staging
        self.assertEqual(snapshot(), before)
        self.assertFalse(os.path.exists(stage_path()))

    def test_space_running_out_while_staging_stops_the_run_and_keeps_the_snapshot(self):
        before = self._seeded()
        real = sync_staging.StageStore.stage_bytes
        calls = []

        def growing(self):
            calls.append(1)
            return real(self) + len(calls) * 5 * 1024 * 1024   # the staging file "grows" past the budget

        with mock.patch.object(sync_staging.StageStore, 'stage_bytes', growing), \
                mock.patch.object(sync_staging, 'MIN_FREE_BYTES', 0), self._free(60 * 1024 * 1024):
            res = sync_once(FakeAzure(build_org(seed=8)), True, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertIn('insufficient_disk_space', res['error'])
        self.assertEqual(snapshot(), before)
        self.assertFalse(os.path.exists(stage_path()))

    def test_staging_write_failure_keeps_the_snapshot(self):
        before = self._seeded()
        state = {'n': 0}

        class Boom(sqlite3.Connection):
            def executemany(self, sql, params):
                if 'INTO item' in sql:
                    state['n'] += 1
                    if state['n'] == 3:
                        raise sqlite3.OperationalError('database or disk is full')
                return super().executemany(sql, params)

        real_connect = sqlite3.connect
        with mock.patch.object(sync_staging.sqlite3, 'connect',
                               lambda *a, **k: real_connect(*a, **{**k, 'factory': Boom})):
            res = sync_once(FakeAzure(build_org(seed=8)), True, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertIn('staging_write_failed', res['error'])
        self.assertEqual(snapshot(), before)
        self.assertFalse(os.path.exists(stage_path()))

    def test_publish_that_runs_out_of_disk_rolls_back_to_the_previous_snapshot(self):
        before = self._seeded()
        with mock.patch.object(sync_service, 'recompute_derived',
                               side_effect=sqlite3.OperationalError('database or disk is full')):
            res = sync_once(FakeAzure(build_org(seed=8)), True, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertEqual(snapshot(), before)
        self.assertFalse(os.path.exists(stage_path()))

    def test_sqlite_that_already_rolled_back_does_not_mask_the_real_error(self):
        before = self._seeded()

        def die_like_a_full_disk(conn):
            conn.execute('ROLLBACK')   # SQLite rolls the transaction back itself on SQLITE_FULL / SQLITE_IOERR
            raise sqlite3.OperationalError('disk I/O error')

        with mock.patch.object(sync_service, 'recompute_derived', die_like_a_full_disk):
            res = sync_once(FakeAzure(build_org(seed=8)), True, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertEqual(res['error'], 'disk I/O error')
        self.assertEqual(snapshot(), before)

    def test_publish_preflight_refuses_when_the_staged_run_cannot_be_published(self):
        before = self._seeded()
        # enough for staging (the budget is checked per chunk) but not for the publish step
        with mock.patch.object(sync_staging.StageStore, 'check_publish_space',
                               side_effect=sync_service.SyncError('insufficient_disk_space: publish')):
            res = sync_once(FakeAzure(build_org(seed=8)), True, force_full=True)
        self.assertEqual(res['status'], 'error')
        self.assertEqual(snapshot(), before)

    def test_boot_cleanup_removes_only_stale_staging_files(self):
        directory = os.path.dirname(sync_service.DB_PATH)
        other = os.path.join(directory, 'notes.txt')
        for name in (sync_staging.STAGE_FILE, sync_staging.STAGE_FILE + '-wal', sync_staging.STAGE_FILE + '-journal'):
            with open(os.path.join(directory, name), 'wb') as f:
                f.write(b'stale')
        with open(other, 'w') as f:
            f.write('not ours')
        try:
            removed = sync_staging.cleanup_stale_stage(directory)
            self.assertEqual(sorted(removed), sorted([sync_staging.STAGE_FILE, sync_staging.STAGE_FILE + '-wal',
                                                       sync_staging.STAGE_FILE + '-journal']))
            self.assertTrue(os.path.exists(other))
            self.assertTrue(os.path.exists(sync_service.DB_PATH))   # the cache itself is never touched
        finally:
            os.remove(other)

    def test_boot_cleanup_leaves_the_files_of_a_live_run_alone(self):
        stage = sync_staging.StageStore.create()
        try:
            self.assertEqual(sync_staging.cleanup_stale_stage(), [])
            self.assertTrue(os.path.exists(stage.path))
            with self.assertRaises(sync_service.SyncError):   # and a second run cannot take the file over
                sync_staging.StageStore.create()
            self.assertTrue(os.path.exists(stage.path))
        finally:
            stage.discard()
        self.assertFalse(os.path.exists(stage.path))


class PlatformWithoutFcntl(unittest.TestCase):
    """Native Windows has no ``fcntl``: the backend must still start and sync as before, and staging must refuse to
    run (never lock-free)."""

    def test_default_mode_starts_and_syncs_and_staging_is_refused_explicitly(self):
        with tempfile.TemporaryDirectory() as data_dir:
            stale = os.path.join(data_dir, sync_staging.STAGE_FILE)
            script = textwrap.dedent("""
                import json, os, sys
                sys.modules['fcntl'] = None          # `import fcntl` now raises ImportError, as on native Windows
                sys.path.insert(0, %r)
                os.environ['DEVOPS_DATA_DIR'] = %r
                with open(os.path.join(%r, 'devops_stage.db'), 'wb') as f:
                    f.write(b'stale file we cannot prove stale')
                import sync_service, sync_staging    # boot incl. the boot-time cleanup: must not raise
                import app                            # the backend's own import chain
                assert sync_staging.fcntl is None and not sync_staging.locking_supported()
                from test_sync_chunked import build_org, sync_once
                from test_sync_hardening import FakeAzure
                out = {'boot_cleanup_left_file': os.path.exists(os.path.join(%r, 'devops_stage.db')),
                       'cleanup_returns': sync_staging.cleanup_stale_stage()}
                default = sync_once(FakeAzure(build_org(n_tasks=300)), False, force_full=True)
                out['default'] = [default['status'], default['upserted']]
                with sync_service.get_db_connection() as c:
                    before = c.execute('SELECT COUNT(*), MAX(changed_date) FROM work_items').fetchone()[:]
                fake = FakeAzure(build_org(n_tasks=300))
                opted = sync_once(fake, True, force_full=True)
                out['chunked'] = [opted['status'], opted['error']]
                out['requests_made_before_refusal'] = len(fake.writes)
                with sync_service.get_db_connection() as c:
                    out['cache_unchanged'] = tuple(c.execute('SELECT COUNT(*), MAX(changed_date) FROM work_items').fetchone()[:]) == tuple(before)
                out['stale_file_still_there'] = os.path.exists(os.path.join(%r, 'devops_stage.db'))
                out['lock_file_created'] = os.path.exists(os.path.join(%r, 'devops_stage.lock'))
                print('RESULT' + json.dumps(out))
            """) % (os.path.dirname(os.path.abspath(__file__)), data_dir, data_dir, data_dir, data_dir, data_dir)
            env = {k: v for k, v in os.environ.items() if k not in ('SYNC_CHUNKED', 'DEVOPS_DATA_DIR')}
            proc = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=180, env=env)
            self.assertEqual(proc.returncode, 0, proc.stderr[-1500:])
            out = json.loads(proc.stdout.split('RESULT', 1)[1])
            self.assertTrue(out['boot_cleanup_left_file'])        # nothing deleted that cannot be proven stale
            self.assertEqual(out['cleanup_returns'], [])
            self.assertEqual(out['default'][0], 'success')        # SYNC_CHUNKED unset: unchanged behaviour
            self.assertEqual(out['chunked'][0], 'error')
            self.assertIn('staging_unsupported_platform', out['chunked'][1])
            self.assertEqual(out['requests_made_before_refusal'], 0)  # refused before the first request
            self.assertTrue(out['cache_unchanged'])
            self.assertTrue(out['stale_file_still_there'])
            self.assertFalse(out['lock_file_created'])             # no lock-free fallback was attempted
            self.assertTrue(os.path.exists(stale))


class PartialRunsAreNeverCompleteSyncs(unittest.TestCase):
    def setUp(self):
        reset_db()

    def test_partial_first_sync_sets_no_completion_markers_and_matches_in_memory(self):
        seen = {}
        for chunked in (False, True):
            reset_db()
            sync_service.set_sync_meta('initial_full_partial_count', 3)
            sync_service.set_sync_meta('initial_full_retry_at', '2026-11-22T01:00:00+00:00')
            with mock.patch.object(sync_service, 'MAX_CONTEXT_ITEMS', 20):
                res = sync_once(FakeAzure(build_org()), chunked, force_full=True)
            self.assertEqual(res['status'], 'partial')
            keys = ('watermark', 'last_full_sync', 'last_success_at', 'last_incremental_sync', 'total_org_active')
            seen[chunked] = {k: sync_service.get_sync_meta(k) for k in keys}
            seen[chunked]['dirty'] = sync_service.get_sync_meta('closure_dirty')
            self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '3')
            self.assertEqual(sync_service.get_sync_meta('initial_full_retry_at'), '2026-11-22T01:00:00+00:00')
        self.assertEqual(seen[True], seen[False])
        self.assertEqual(seen[True], {'watermark': None, 'last_full_sync': None, 'last_success_at': None,
                                      'last_incremental_sync': None, 'total_org_active': None, 'dirty': '1'})

    def test_successful_full_sync_clears_scheduler_metadata_in_both_sync_modes(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                reset_db()
                sync_service.set_sync_meta('initial_full_partial_count', 3)
                sync_service.set_sync_meta('initial_full_retry_at', '2026-11-22T01:00:00+00:00')
                result = sync_once(FakeAzure(build_org(n_tasks=300)), chunked, force_full=True)
                self.assertEqual(result['status'], 'success')
                self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '0')
                self.assertEqual(sync_service.get_sync_meta('initial_full_retry_at'), '')

    def test_partial_run_over_an_existing_cache_keeps_its_completion_markers(self):
        sync_once(FakeAzure(build_org()), True, force_full=True)
        sync_service.set_sync_meta('initial_full_partial_count', 2)
        sync_service.set_sync_meta('initial_full_retry_at', '2026-11-22T01:00:00+00:00')
        keys = ('watermark', 'last_full_sync', 'last_success_at', 'total_org_active')
        before = {k: sync_service.get_sync_meta(k) for k in keys}
        res = sync_once(FakeAzure(build_org(seed=8)), True, force_full=True, max_items=10)  # explicit cap -> partial
        self.assertEqual(res['status'], 'partial')
        self.assertEqual({k: sync_service.get_sync_meta(k) for k in keys}, before)
        self.assertEqual(sync_service.get_sync_meta('initial_full_partial_count'), '2')
        self.assertEqual(sync_service.get_sync_meta('initial_full_retry_at'), '2026-11-22T01:00:00+00:00')


if __name__ == '__main__':
    unittest.main()
