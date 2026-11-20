"""Incremental sync: unchanged ids are confirmed with a cheap (Rev, ChangedDate) probe instead of a full detail read.

Offline, synthetic items, isolated SQLite. The behaviours that must NOT change are asserted next to the saving:
context promotion, restore of soft-deleted rows, relation add/remove, scope exit, partial-run retry (closure
healing), failed runs (no watermark move) and the fall back to a full read whenever the probe cannot prove "unchanged".
"""
import re
import unittest
from unittest import mock

import testsupport  # noqa: F401  (must precede the project imports)
import sync_service
from test_sync_hardening import FakeAzure, ORG, Resp, raw_item, reset_db, row, rows, run_sync

testsupport.isolate_database(globals())


def rev_item(item_id, rev=1, changed='2026-11-05T08:00:00Z', **kw):
    item = raw_item(item_id, changed=changed, **kw)
    item['rev'] = rev
    return item


class ProbingAzure(FakeAzure):
    """FakeAzure that answers the field-list probe like Azure DevOps (id, rev, requested fields only) and records
    full and probe reads separately."""

    def __init__(self, items):
        super().__init__(items)
        self.full_reads, self.probe_reads = [], []
        self.fail_probe = False
        self.probe_429 = 0      # N probe reads -> HTTP 429 with Retry-After ...
        self.probe_429_after = 0  # ... starting after this many probe reads
        self.full_429 = 0       # first N full reads -> HTTP 429 with Retry-After
        self.probe_override = None  # callable(item) -> probe payload item, to model odd server answers

    def edit(self, item_id, **kw):
        old = self.items[item_id]
        new = rev_item(item_id, rev=old['rev'] + 1, changed=kw.pop('changed', '2026-11-05T09:00:00Z'), **kw)
        self.items[item_id] = new

    def get(self, url, headers=None, timeout=None):
        ids = [int(x) for x in re.search(r'ids=([\d,]+)', url).group(1).split(',')]
        if '$expand=relations' in url:
            self.full_reads.append(ids)
            if self.full_429 > 0:
                self.full_429 -= 1
                return Resp(status=429, headers={'Retry-After': '3'})
            return super().get(url, headers, timeout)
        self.probe_reads.append(ids)
        if self.probe_429 > 0 and len(self.probe_reads) > self.probe_429_after:
            self.probe_429 -= 1
            return Resp(status=429, headers={'Retry-After': '2'})
        if self.probe_override:
            return Resp({'value': [self.probe_override(self.items[i]) if i in self.items else None for i in ids]})
        if self.fail_probe:
            return Resp(status=500, text='boom')
        fields = re.search(r'fields=([^&]+)', url).group(1).split(',')
        return Resp({'value': [
            {'id': i, **({'rev': self.items[i]['rev']} if 'rev' in self.items[i] else {}),
             'fields': {f: self.items[i]['fields'][f] for f in fields if f in self.items[i]['fields']}}
            if i in self.items else None for i in ids]})

    @property
    def full_ids(self):
        return sorted(i for call in self.full_reads for i in call)


class ProbeBase(unittest.TestCase):
    def setUp(self):
        reset_db()
        patcher = mock.patch.object(sync_service, 'PROBE_MIN_IDS', 0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def synced(self, fake):
        res = run_sync(fake, force_full=True)
        self.assertEqual(res['status'], 'success')
        fake.full_reads.clear(); fake.probe_reads.clear()
        return res


class UnchangedWindowIsNotReadInFull(ProbeBase):
    def test_nothing_changed_reads_no_details_and_keeps_bookkeeping(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 21)])
        self.synced(fake)
        before = {i: row(i) for i in range(1, 21)}
        res = run_sync(fake)
        self.assertEqual(res['mode'], 'incremental')
        self.assertEqual(res['status'], 'success')
        self.assertEqual(fake.full_ids, [])
        self.assertEqual(sorted(i for c in fake.probe_reads for i in c), list(range(1, 21)))
        self.assertEqual((res['fetched'], res['upserted'], res['unchanged_skipped'], res['details_fetched']), (20, 20, 20, 0))
        for i in range(1, 21):
            after = row(i)
            self.assertEqual({k: v for k, v in after.items() if k not in ('last_synced_at', 'last_seen_at')},
                             {k: v for k, v in before[i].items() if k not in ('last_synced_at', 'last_seen_at')})
            self.assertGreater(after['last_synced_at'], before[i]['last_synced_at'])
            self.assertGreater(after['last_seen_at'], before[i]['last_seen_at'])

    def test_only_changed_ids_are_read_in_full(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 21)])
        self.synced(fake)
        fake.edit(3, title='renamed'); fake.edit(7, state='Done')
        res = run_sync(fake)
        self.assertEqual(fake.full_ids, [3, 7])
        self.assertEqual(row(3)['title'], 'renamed')
        self.assertEqual(row(7)['is_active'], 0)
        self.assertEqual((res['details_fetched'], res['unchanged_skipped'], res['fetched']), (2, 18, 20))

    def test_watermark_follows_the_newest_change_through_skipped_rows(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)])
        self.synced(fake)
        fake.edit(2, changed='2026-11-06T10:00:00Z')
        run_sync(fake)
        self.assertEqual(sync_service.get_sync_meta('watermark'), '2026-11-06T10:00:00Z')
        run_sync(fake)  # everything skipped now: watermark must not move backwards or stall below the change
        self.assertEqual(sync_service.get_sync_meta('watermark'), '2026-11-06T10:00:00Z')

    def test_small_windows_skip_the_probe_by_default(self):
        with mock.patch.object(sync_service, 'PROBE_MIN_IDS', sync_service.azure_client.BATCH_SIZE):
            fake = ProbingAzure([rev_item(i) for i in range(1, 6)])
            self.synced(fake)
            run_sync(fake)
        self.assertEqual(fake.probe_reads, [])
        self.assertEqual(fake.full_ids, [1, 2, 3, 4, 5])


class BehaviourThatMustNotChange(ProbeBase):
    def test_context_row_in_the_window_is_promoted_even_with_an_unchanged_revision(self):
        # P is Done: cached only as context (parent of A). Both then fall into the incremental window.
        fake = ProbingAzure([rev_item(1, state='Done', children=[2]), rev_item(2, parent=1)])
        original = fake._match_wiql
        fake._match_wiql = lambda q: [2] if sync_service.SCOPE_WHERE in q else original(q)
        self.synced(fake)
        self.assertEqual(row(1)['is_context'], 1)
        fake._match_wiql = original
        run_sync(fake)
        self.assertEqual(row(1)['is_context'], 0)
        self.assertIn(1, fake.full_ids)

    def test_soft_deleted_row_that_reappears_is_restored(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)])
        self.synced(fake)
        with sync_service.db_lock, sync_service.get_db_connection() as c:
            c.execute("UPDATE work_items SET deleted_at = '2026-11-01T00:00:00' WHERE id = 4")
        run_sync(fake)
        self.assertIsNone(row(4)['deleted_at'])
        self.assertIn(4, fake.full_ids)

    def test_rows_without_a_stored_revision_are_read_in_full_once(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)])
        self.synced(fake)
        with sync_service.db_lock, sync_service.get_db_connection() as c:
            c.execute('UPDATE work_items SET rev = NULL WHERE id IN (2, 3)')
        run_sync(fake)
        self.assertEqual(fake.full_ids, [2, 3])
        self.assertEqual(row(2)['rev'], 1)
        fake.full_reads.clear()
        run_sync(fake)
        self.assertEqual(fake.full_ids, [])

    def test_a_server_that_reports_no_revision_is_never_trusted(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 4)])
        self.synced(fake)
        for item in fake.items.values():
            del item['rev']
        run_sync(fake)
        self.assertEqual(fake.full_ids, [1, 2, 3])

    def test_relation_added_to_an_uncached_target_pulls_the_target_in(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)] + [rev_item(99, state='Done', changed='2020-01-01T00:00:00Z')])
        self.synced(fake)
        self.assertIsNone(row(99))
        fake.edit(3, succs=[99])
        run_sync(fake)
        self.assertEqual(row(99)['is_context'], 1)
        self.assertEqual([e['id'] for e in sync_service.get_single_item(3)['relations']['successors']], [99])

    def test_relation_removed_updates_the_item_and_keeps_the_target_cached(self):
        fake = ProbingAzure([rev_item(1, succs=[2]), rev_item(2, preds=[1]), rev_item(3)])
        self.synced(fake)
        fake.edit(1); fake.edit(2)
        run_sync(fake)
        self.assertEqual(sync_service.get_single_item(1)['relations']['successors'], [])
        self.assertEqual(row(1)['is_blocking'], 0)
        self.assertEqual(row(2)['is_blocked'], 0)

    def test_item_leaving_the_scope_is_marked_inactive(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)])
        self.synced(fake)
        fake.edit(2, state='Done')
        res = run_sync(fake)
        self.assertEqual(row(2)['is_active'], 0)
        self.assertEqual(res['deleted'], 0)  # incremental never deletes

    def test_incremental_sync_still_never_deletes_when_ids_disappear(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)])
        self.synced(fake)
        del fake.items[5]
        res = run_sync(fake)
        self.assertEqual(res['deleted'], 0)
        self.assertIsNone(row(5)['deleted_at'])


class FailureAndRetry(ProbeBase):
    def test_probe_failure_falls_back_to_a_full_read_and_the_run_succeeds(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)])
        self.synced(fake)
        fake.fail_probe = True
        res = run_sync(fake)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(fake.full_ids, [1, 2, 3, 4, 5])
        self.assertTrue(any(w.startswith('probe_failed') for w in res['warnings']))

    def test_failed_detail_read_after_a_probe_keeps_the_watermark_and_rows(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)])
        self.synced(fake)
        watermark = sync_service.get_sync_meta('watermark')
        before = row(2)
        fake.edit(2, title='edited', changed='2026-11-07T00:00:00Z')
        fake.fail_ids = {2}
        res = run_sync(fake)
        self.assertEqual(res['status'], 'error')
        self.assertEqual(sync_service.get_sync_meta('watermark'), watermark)
        self.assertEqual(row(2), before)
        fake.fail_ids = set()
        res = run_sync(fake)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(row(2)['title'], 'edited')
        self.assertEqual(sync_service.get_sync_meta('watermark'), '2026-11-07T00:00:00Z')

    def test_partial_run_forces_full_reads_until_a_complete_run_heals_the_closure(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)] + [rev_item(99, state='Done', changed='2020-01-01T00:00:00Z')])
        self.synced(fake)
        fake.edit(3, succs=[99])
        fake.fail_ids = {99}                       # the new dependency target cannot be read this time
        res = run_sync(fake)
        self.assertEqual(res['status'], 'partial')
        self.assertIsNone(row(99))
        self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '1')
        fake.fail_ids = set(); fake.full_reads.clear(); fake.probe_reads.clear()
        res = run_sync(fake)                       # item 3 is unchanged since the partial run, but its closure has a hole
        self.assertEqual(res['status'], 'success')
        self.assertEqual(fake.probe_reads, [])     # no probe while the closure is dirty
        self.assertEqual(row(99)['is_context'], 1)
        self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '0')
        fake.full_reads.clear()
        run_sync(fake)
        self.assertEqual(fake.full_ids, [])        # probing resumes after the complete run


class UnreachableTargetsAreRetriedWithoutTheSource(ProbeBase):
    """A relation target that cannot be read in one run must still enter the cache on a later incremental run
    even though the item linking to it is unchanged (same Rev and ChangedDate) and therefore skipped by the probe."""

    def run_late(self, source_kwargs, target_id=99):
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)] + [rev_item(target_id, state='Active', changed='2020-01-01T00:00:00Z')])
        original = fake._match_wiql   # the target is old and outside the scope query: it can only arrive as context
        fake._match_wiql = lambda q: [i for i in original(q) if i != target_id] if sync_service.SCOPE_WHERE in q else original(q)
        self.synced(fake)
        target = fake.items.pop(target_id)               # not reachable yet
        fake.edit(3, **source_kwargs)
        res = run_sync(fake)
        self.assertTrue(any(w.startswith('context_missing') for w in res['warnings']))
        self.assertIsNone(row(target_id))
        fake.items[target_id] = target                   # reachable now; item 3 is NOT touched again
        fake.full_reads.clear()
        return fake

    def test_dependency_target_that_becomes_reachable_enters_on_the_next_incremental_run(self):
        fake = self.run_late({'preds': [99]})
        before = sync_service.row_to_work_item_dict(row(3))
        self.assertTrue(before['hasUnresolvedPredecessors'])
        res = run_sync(fake)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(row(99)['is_context'], 1)
        after = sync_service.row_to_work_item_dict(row(3))
        self.assertFalse(after['hasUnresolvedPredecessors'])
        self.assertEqual(after['relations']['predecessors'][0]['state'], 'Active')
        self.assertEqual(row(3)['is_blocked'], 1)
        self.assertNotIn(3, fake.full_ids)               # the source itself was still skipped
        fake.full_reads.clear()
        run_sync(fake)
        self.assertEqual(fake.full_ids, [])              # entry cleared once resolved: no more retries

    def test_hierarchy_target_that_becomes_reachable_enters_on_the_next_incremental_run(self):
        fake = self.run_late({'children': [99]})
        run_sync(fake)
        self.assertEqual(row(99)['is_context'], 1)

    def test_still_unreachable_targets_are_retried_and_do_not_block_the_run(self):
        fake = self.run_late({'succs': [99]})
        del fake.items[99]
        res = run_sync(fake)
        self.assertEqual(res['status'], 'success')
        self.assertIn(99, fake.full_ids)                 # asked again although item 3 was skipped
        self.assertIsNone(row(99))

    def test_retry_ends_once_the_run_that_missed_the_target_left_the_window(self):
        fake = self.run_late({'succs': [99]})
        meta = sync_service._load_closure_missing()
        self.assertIn(99, meta)
        with sync_service.db_lock, sync_service.get_db_connection() as c:   # the watermark moves on by days
            sync_service._set_meta(c, 'watermark', '2026-11-30T00:00:00Z')
            c.commit()
        fake.full_reads.clear()
        run_sync(fake)
        self.assertNotIn(99, fake.full_ids)              # out of the window: only the periodic full sync picks it up
        run_sync(fake, force_full=True)
        self.assertEqual(row(99)['is_context'], 1)


class RemovedLinksEndTheRetry(ProbeBase):
    """A retry record must not outlive the link it was recorded for: a removed relation may not create a context
    row, while another still-valid link to the same target keeps the retry alive."""

    def setup_missing(self, links):
        fake = ProbingAzure([rev_item(i) for i in range(1, 7)] + [rev_item(99, state='Done', changed='2020-01-01T00:00:00Z')])
        self.synced(fake)
        target = fake.items.pop(99)
        for item_id, kw in links.items():
            fake.edit(item_id, **kw)
        run_sync(fake)
        self.assertIn(99, sync_service._load_closure_missing())
        fake.items[99] = target
        fake.full_reads.clear(); fake.probe_reads.clear()
        return fake

    def test_removed_dependency_link_does_not_pull_the_target_in(self):
        fake = self.setup_missing({3: {'succs': [99]}})
        fake.edit(3)                                       # the link is gone, the target is reachable
        run_sync(fake)
        self.assertIsNone(row(99))
        self.assertNotIn(99, sync_service._load_closure_missing())
        run_sync(fake); run_sync(fake, force_full=True)
        self.assertTrue(row(99) is None or row(99)['deleted_at'] is not None)

    def test_removed_hierarchy_link_does_not_pull_the_target_in(self):
        fake = self.setup_missing({3: {'children': [99]}})
        fake.edit(3)
        run_sync(fake)
        self.assertIsNone(row(99))
        self.assertNotIn(99, sync_service._load_closure_missing())

    def test_another_valid_link_to_the_same_target_keeps_the_retry(self):
        fake = self.setup_missing({3: {'succs': [99]}, 4: {'succs': [99]}})
        self.assertEqual(sync_service._load_closure_missing()[99][2], [(3, 'dep'), (4, 'dep')])
        fake.edit(3)                                       # 3 drops its link, 4 (unchanged, skipped by the probe) keeps it
        run_sync(fake)
        self.assertEqual(row(99)['is_context'], 1)
        self.assertNotIn(4, fake.full_ids)
        self.assertNotIn(99, sync_service._load_closure_missing())

    def test_remaining_source_is_remembered_while_the_target_stays_unreachable(self):
        fake = self.setup_missing({3: {'succs': [99]}, 4: {'succs': [99]}})
        del fake.items[99]
        fake.edit(3)
        run_sync(fake)
        self.assertEqual(sync_service._load_closure_missing()[99][2], [(4, 'dep')])
        self.assertIn(99, fake.full_ids)                   # still asked for through source 4
        fake.items[99] = rev_item(99, state='Done', changed='2020-01-01T00:00:00Z')
        run_sync(fake)
        self.assertEqual(row(99)['is_context'], 1)

    def test_entries_without_source_information_are_always_retried(self):
        fake = self.setup_missing({3: {'succs': [99]}})
        with sync_service.db_lock, sync_service.get_db_connection() as c:
            first_seen = sync_service._load_closure_missing()[99][1]
            sync_service._set_meta(c, 'closure_missing', '{"99": ["dep", "%s"]}' % first_seen)   # older two-field format
            c.commit()
        run_sync(fake)
        self.assertEqual(row(99)['is_context'], 1)


class RetryKindFollowsTheRemainingLinks(ProbeBase):
    """The retry reads the target the way the rows that still link to it would: as a child (its own children follow)
    when one of them links by hierarchy, otherwise as a dependency only."""

    def setup_two_kinds(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 7)] +
                            [rev_item(99, state='Done', changed='2020-01-01T00:00:00Z', children=[98]),
                             rev_item(98, state='Done', changed='2020-01-01T00:00:00Z', parent=99)])
        original = fake._match_wiql
        fake._match_wiql = lambda q: [i for i in original(q) if i not in (98, 99)] if sync_service.SCOPE_WHERE in q else original(q)
        self.synced(fake)
        stash = {i: fake.items.pop(i) for i in (98, 99)}
        fake.edit(3, children=[99])                       # A: hierarchy link
        fake.edit(4, succs=[99])                          # B: dependency link
        run_sync(fake)
        self.assertEqual(sync_service._load_closure_missing()[99][2], [(3, 'hier'), (4, 'dep')])
        fake.items.update(stash)
        fake.full_reads.clear(); fake.probe_reads.clear()
        return fake

    def test_dependency_link_left_alone_reads_the_target_without_its_children(self):
        fake = self.setup_two_kinds()
        fake.edit(3)                                      # A drops the hierarchy link, B is unchanged and skipped by the probe
        run_sync(fake)
        self.assertNotIn(4, fake.full_ids)
        self.assertEqual(row(99)['is_context'], 1)
        self.assertIsNone(row(98))                        # dependency targets do not pull their children in
        run_sync(fake, force_full=True)
        self.assertIsNone(row(98))

    def test_hierarchy_link_left_alone_reads_the_target_with_its_children(self):
        fake = self.setup_two_kinds()
        fake.edit(4)                                      # B drops the dependency, A keeps the hierarchy link (skipped)
        run_sync(fake)
        self.assertEqual(row(99)['is_context'], 1)
        self.assertEqual(row(98)['is_context'], 1)

    def test_sources_stored_as_plain_ids_take_the_entry_kind(self):
        with sync_service.db_lock, sync_service.get_db_connection() as c:
            sync_service._set_meta(c, 'closure_missing', '{"99": ["hier", "2026-11-05T00:00:00", [3, 4]]}')
            c.commit()
        self.assertEqual(sync_service._load_closure_missing()[99], ('hier', '2026-11-05T00:00:00', [(3, 'hier'), (4, 'hier')]))


class ThrottledProbeAcrossBatches(ProbeBase):
    def setUp(self):
        super().setUp()
        self.fake = ProbingAzure([rev_item(i) for i in range(1, 451)])   # three probe batches
        self.synced(self.fake)

    def run_recording(self):
        sleeps = []
        with self.fake.patch_all(), mock.patch.object(sync_service, '_sleep', sleeps.append):
            res = sync_service.sync_work_items(ORG, 'pat')
        return res, sleeps

    def test_exhausted_first_batch_stops_probing_and_reads_the_window_in_full(self):
        self.fake.probe_429 = 99
        res, sleeps = self.run_recording()
        self.assertEqual(res['status'], 'success')
        self.assertEqual(len(self.fake.probe_reads), 4)            # one batch: 1 try + 3 retries; batches 2 and 3 not attempted
        self.assertEqual(sleeps, [2.0, 2.0, 2.0])                  # Retry-After honoured, nothing skipped
        self.assertEqual(sorted(set(self.fake.full_ids)), list(range(1, 451)))
        self.assertEqual(len(self.fake.full_reads), 3)             # the same three reads as without a probe
        self.assertTrue(any(w.startswith('probe_failed') for w in res['warnings']))

    def test_batches_proved_unchanged_before_the_failure_stay_skipped(self):
        self.fake.probe_429, self.fake.probe_429_after = 99, 1     # batch 1 answers, batch 2 is throttled for good
        res, sleeps = self.run_recording()
        self.assertEqual(res['status'], 'success')
        self.assertEqual(res['unchanged_skipped'], 200)
        self.assertEqual(sorted(set(self.fake.full_ids)), list(range(201, 451)))
        self.assertEqual(len(self.fake.probe_reads), 1 + 4)        # batch 1 once, batch 2 four times, batch 3 never
        self.assertEqual(sleeps, [2.0, 2.0, 2.0])

    def test_throttled_fallback_read_fails_the_run_and_the_watermark_stays(self):
        watermark = sync_service.get_sync_meta('watermark')
        before = row(10)
        self.fake.edit(10, title='edited', changed='2026-11-09T00:00:00Z')
        self.fake.probe_429, self.fake.full_429 = 99, 99
        res, sleeps = self.run_recording()
        self.assertEqual(res['status'], 'error')
        # probe backoff (one batch), then the full read's own backoff for each of its three batches, as without a probe
        self.assertEqual(sleeps, [2.0] * 3 + [3.0] * 9)
        self.assertEqual(sync_service.get_sync_meta('watermark'), watermark)
        self.assertEqual(row(10), before)


class RetryListLimit(ProbeBase):
    def test_more_unreachable_targets_than_the_limit_fall_back_to_full_reads_so_none_is_forgotten(self):
        limit = 5
        targets = list(range(100, 100 + limit + 3))
        fake = ProbingAzure([rev_item(i) for i in range(1, 6)] + [rev_item(t, state='Done', changed='2020-01-01T00:00:00Z') for t in targets])
        self.synced(fake)
        stash = {t: fake.items.pop(t) for t in targets}
        fake.edit(3, succs=targets)
        with mock.patch.object(sync_service, 'CLOSURE_RETRY_MAX', limit):
            res = run_sync(fake)
            self.assertEqual(res['status'], 'success')
            self.assertEqual(len(sync_service._load_closure_missing()), limit)       # list is capped ...
            self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '1')       # ... and the next run reads in full
            fake.items.update(stash)
            fake.full_reads.clear(); fake.probe_reads.clear()
            run_sync(fake)
        self.assertEqual(fake.probe_reads, [])                                         # no probe: the whole window is read
        self.assertEqual(sorted(r['id'] for r in rows() if r['id'] in stash), targets)  # every target arrived, none forgotten
        self.assertEqual(sync_service.get_sync_meta('closure_dirty'), '0')


class UnusableProbeAnswersFallBackToFullReads(ProbeBase):
    def assert_full_read_for(self, mutate, expect_all=True):
        fake = ProbingAzure([rev_item(i) for i in range(1, 5)])
        self.synced(fake)
        fake.probe_override = mutate
        res = run_sync(fake)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(fake.full_ids, [1, 2, 3, 4])
        self.assertEqual(res['unchanged_skipped'], 0)

    def test_missing_invalid_or_mistyped_revisions(self):
        for label, bad in (('absent', None), ('null', 'null'), ('text', 'abc'), ('bool', True), ('float', 1.5), ('negative-text', '-1')):
            with self.subTest(rev=label):
                def mutate(item, bad=bad):
                    out = {'id': item['id'], 'fields': {'System.ChangedDate': item['fields']['System.ChangedDate']}}
                    if label != 'absent':
                        out['rev'] = None if bad == 'null' else bad
                    return out
                reset_db()
                self.assert_full_read_for(mutate)

    def test_missing_empty_or_different_changed_dates(self):
        for label, value in (('absent', ...), ('null', None), ('empty', ''), ('number', 20261105), ('other-day', '2026-11-06T08:00:00Z')):
            with self.subTest(changed=label):
                def mutate(item, value=value):
                    fields = {} if value is ... else {'System.ChangedDate': value}
                    return {'id': item['id'], 'rev': item['rev'], 'fields': fields}
                reset_db()
                self.assert_full_read_for(mutate)

    def test_items_without_a_fields_object_or_omitted_by_the_server(self):
        for label, mutate in (('no-fields', lambda item: {'id': item['id'], 'rev': item['rev']}),
                              ('null-fields', lambda item: {'id': item['id'], 'rev': item['rev'], 'fields': None}),
                              ('omitted', lambda item: None)):
            with self.subTest(answer=label):
                reset_db()
                self.assert_full_read_for(mutate)

    def test_a_matching_answer_is_still_skipped(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 5)])
        self.synced(fake)
        fake.probe_override = lambda item: {'id': item['id'], 'rev': str(item['rev']),   # digits as text are accepted
                                            'fields': {'System.ChangedDate': item['fields']['System.ChangedDate']}}
        run_sync(fake)
        self.assertEqual(fake.full_ids, [])


class ThrottlingAndBackoff(ProbeBase):
    def run_recording(self, fake):
        sleeps = []
        with fake.patch_all(), mock.patch.object(sync_service, '_sleep', sleeps.append):
            res = sync_service.sync_work_items(ORG, 'pat')
        return res, sleeps

    def test_a_throttled_probe_honours_retry_after_and_then_succeeds(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 5)])
        self.synced(fake)
        fake.probe_429 = 1
        res, sleeps = self.run_recording(fake)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(sleeps, [2.0])                  # the client's own Retry-After handling
        self.assertEqual(fake.full_ids, [])
        self.assertEqual(len(fake.probe_reads), 2)

    def test_an_exhausted_probe_falls_back_to_a_full_read_that_uses_the_same_backoff(self):
        fake = ProbingAzure([rev_item(i) for i in range(1, 5)])
        self.synced(fake)
        fake.probe_429 = 99                              # every probe attempt is throttled
        fake.full_429 = 1                                # and the first full read as well
        res, sleeps = self.run_recording(fake)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(len(fake.probe_reads), 4)       # 1 try + 3 retries, then give up
        self.assertEqual(sleeps, [2.0, 2.0, 2.0, 3.0])   # probe backoff, then the full read's own Retry-After
        self.assertEqual(len(fake.full_reads), 2)        # throttled attempt + the successful one
        self.assertEqual(fake.full_ids, [1, 1, 2, 2, 3, 3, 4, 4])   # throttled attempt + retry, same ids
        self.assertTrue(any(w.startswith('probe_failed') for w in res['warnings']))
        self.assertEqual(row(1)['rev'], 1)


class SchemaUpgrade(unittest.TestCase):
    def test_existing_rows_survive_the_rev_column_and_are_read_once_then_probed(self):
        reset_db()
        with mock.patch.object(sync_service, 'PROBE_MIN_IDS', 0):
            fake = ProbingAzure([rev_item(1, state='Done', children=[2]), rev_item(2, parent=1, succs=[3]), rev_item(3, preds=[2]),
                                 rev_item(4)])
            original = fake._match_wiql
            fake._match_wiql = lambda q: [2, 3, 4] if sync_service.SCOPE_WHERE in q else original(q)
            self.assertEqual(run_sync(fake, force_full=True)['status'], 'success')   # 1 is cached as context
            with sync_service.db_lock, sync_service.get_db_connection() as c:
                c.execute("UPDATE work_items SET deleted_at = '2026-11-01T00:00:00' WHERE id = 4")
                c.commit()

            def snapshot():
                with sync_service.get_db_connection() as c:
                    return {r['id']: {k: r[k] for k in r.keys() if k != 'rev'} for r in c.execute('SELECT * FROM work_items')}

            before = snapshot()
            with sync_service.db_lock, sync_service.get_db_connection() as c:   # downgrade to the pre-rev schema
                c.execute('ALTER TABLE work_items DROP COLUMN rev')
                c.commit()
            sync_service.init_db()
            sync_service.init_db()                                                   # idempotent
            self.assertEqual(snapshot(), before)                                     # nothing lost or altered
            self.assertTrue(all(r['rev'] is None for r in rows()))
            fake.items[4]['fields']['System.State'] = 'Active'

            fake.full_reads.clear(); fake.probe_reads.clear()
            res = run_sync(fake)                                                     # first run after the upgrade
            self.assertEqual(res['status'], 'success')
            self.assertEqual(fake.probe_reads, [])                                   # nothing to prove yet: full reads
            self.assertEqual(sorted(set(fake.full_ids)), [1, 2, 3, 4])
            self.assertTrue(all(r['rev'] is not None for r in rows()))
            fake.full_reads.clear()
            run_sync(fake)
            self.assertEqual(sorted(set(i for c in fake.probe_reads for i in c)), [1, 2, 3, 4])   # probing from now on
            self.assertEqual(fake.full_ids, [])                                      # context row 1 was promoted by the first run
            self.assertEqual(row(1)['is_context'], 0)


if __name__ == '__main__':
    unittest.main()
