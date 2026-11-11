"""Deterministic offline fixture for DEVOPS_FIXTURE_MODE=1.

Produces rows shaped exactly like the work_items table written by sync_service, so the
backend can run without Azure DevOps. Nothing here touches the network.
"""
import itertools
import json
import logging
import random
from collections import Counter
from datetime import datetime, timedelta

import sync_service

logger = logging.getLogger("fixture_data")

FIXTURE_USER = 'Fixture User'
PROJECTS = ['Alpha', 'Beta', 'Gamma']
FIXTURE_SEED = 20261105
BASE_DATE = datetime(2026, 10, 1, 8, 0, 0)
WEIRD_STATE = 'Weird State'
URL_TEMPLATE = 'https://dev.azure.com/fixture-org/{project}/_workitems/edit/{id}'

COLUMNS = [
    'id', 'title', 'type', 'state', 'project', 'assigned_to', 'assigned_avatar', 'priority',
    'iteration', 'area_path', 'parent_id', 'parent_title', 'parent_type', 'story_points',
    'changed_date', 'created_date', 'is_bug', 'is_task', 'is_unassigned', 'is_active',
    'is_blocked', 'is_blocking', 'url', 'description', 'relations_json', 'last_synced_at',
    'deleted_at', 'last_seen_at', 'is_context',
]

_ACTIVE_STATE_WEIGHTS = [('New', 42), ('To Do', 10), ('In Progress', 14), ('Active', 10),
                         ('Committed', 10), ('Resolved', 14)]
_OTHER_NAMES = ['Fixture Person A', 'Fixture Person B', 'Fixture Person E']
_EXTRA_NAMES = ['Fixture Person N', 'Fixture Person O']
_KANBAN_TODO_STATES = {'New', 'To Do', 'Proposed'}


def _is_completed(state):
    return (state or '').strip().lower() in {'done', 'closed', 'completed'}


def _story_type(project):
    return 'Product Backlog Item' if project == 'Beta' else 'User Story'


def _iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def _assigned_to(node):
    return 'Unassigned' if node['assignee'] is None else node['assignee']


def _pick_assignee(rng):
    r = rng.random()
    if r < 0.35:
        return FIXTURE_USER
    if r < 0.55:
        return rng.choice(_OTHER_NAMES)
    if r < 0.80:
        return None
    return rng.choice(_EXTRA_NAMES)


def _build_nodes(rng):
    ids = itertools.count(10001)

    def mk(wtype, project, state, title, parent=None, is_context=False):
        return {
            'id': next(ids), 'type': wtype, 'project': project, 'state': state, 'title': title,
            'parent': parent, 'is_context': is_context,
            'is_active': 0 if (is_context or _is_completed(state)) else 1,
            'preds': [], 'succs': [], 'rels': [],
        }

    def active_state():
        return rng.choices([s for s, _ in _ACTIVE_STATE_WEIGHTS],
                           weights=[w for _, w in _ACTIVE_STATE_WEIGHTS])[0]

    ctx_epics = [mk('Epic', p, 'Done' if i % 2 == 0 else 'Closed', f'Legacy Epic {i + 1} ({p})', is_context=True)
                 for i, p in enumerate(['Alpha', 'Beta', 'Gamma', 'Alpha'])]
    ctx_epic_by_proj = {p: [e for e in ctx_epics if e['project'] == p] for p in PROJECTS}

    epics = [mk('Epic', p, active_state(), f'Epic {i + 1}: {p} platform')
             for i, p in enumerate(['Alpha'] * 3 + ['Beta'] * 3 + ['Gamma'] * 2)]
    epic_by_proj = {p: [e for e in epics if e['project'] == p] for p in PROJECTS}

    ctx_features = []
    for i, p in enumerate(['Alpha', 'Beta', 'Gamma', 'Alpha', 'Beta', 'Gamma', 'Alpha', 'Beta']):
        epics_p = ctx_epic_by_proj[p]
        ctx_features.append(mk('Feature', p, 'Closed' if i % 2 else 'Done', f'Legacy Feature {i + 1} ({p})',
                               parent=epics_p[i % len(epics_p)], is_context=True))
    ctx_feat_by_proj = {p: [f for f in ctx_features if f['project'] == p] for p in PROJECTS}

    features = []
    for p in PROJECTS:
        for k in range(12):
            ctx_parent = ctx_epic_by_proj[p][k] if (k == 0 or (p == 'Alpha' and k == 1)) else None
            parent = ctx_parent or epic_by_proj[p][k % len(epic_by_proj[p])]
            features.append(mk('Feature', p, active_state(), f'Feature {p}-{k + 1}', parent=parent))
    features_by_proj = {p: [f for f in features if f['project'] == p] for p in PROJECTS}

    stories_by_proj = {}
    for p in PROJECTS:
        lst = []
        for j in range(60):
            ctx_feats = ctx_feat_by_proj[p]
            if j < len(ctx_feats):
                parent = ctx_feats[j]
            else:
                feats = features_by_proj[p]
                parent = feats[(j - len(ctx_feats)) % len(feats)]
            lst.append(mk(_story_type(p), p, active_state(), f'Story {p}-{j + 1}', parent=parent))
        stories_by_proj[p] = lst
    stories = [s for p in PROJECTS for s in stories_by_proj[p]]

    # Every 4th story is atomic (no children).
    parents = [s for p in PROJECTS for j, s in enumerate(stories_by_proj[p]) if j % 4 != 3]
    tasks = []
    for i in range(496):
        parent = parents[i % len(parents)]
        wtype = 'Bug' if rng.random() < 0.3 else 'Task'
        tasks.append(mk(wtype, parent['project'], active_state(), f'{wtype} {i + 1} ({parent["project"]})',
                        parent=parent))

    completed = []
    for i in range(60):
        parent = parents[(i * 7) % len(parents)]
        wtype = 'Bug' if i % 3 == 0 else 'Task'
        state = 'Done' if i % 2 == 0 else 'Closed'
        completed.append(mk(wtype, parent['project'], state, f'Completed {wtype} {i + 1}', parent=parent))

    used = set()

    def pick(cands, k):
        chosen = rng.sample(cands, k)
        used.update(n['id'] for n in chosen)
        return chosen

    for p in PROJECTS:
        for i, n in enumerate(pick([t for t in tasks if t['project'] == p], 4)):
            n['title'] = f'Fix needle sync {p}-{i + 1}'
    for p in PROJECTS:
        pick([t for t in tasks if t['project'] == p and t['id'] not in used], 1)[0]['title'] = \
            f'Needle regression check {p}'
    pick([t for t in tasks if t['id'] not in used], 1)[0]['title'] = 'İğdır şablon render check'
    pick([t for t in tasks if t['type'] == 'Task' and t['id'] not in used], 1)[0]['state'] = WEIRD_STATE

    return ctx_epics + epics + ctx_features + features + stories + tasks + completed


def _link(nodes, rng):
    active = [n for n in nodes if n['is_active']]
    completed = [n for n in nodes if not n['is_active'] and not n['is_context']]
    context = [n for n in nodes if n['is_context']]
    edges = []
    rel_pairs = []

    def add_edge(pred, succ):
        if pred is succ or any(a is pred and b is succ for a, b in edges):
            return False
        if pred['is_active'] and succ['is_active'] and pred['id'] > succ['id']:
            return False
        edges.append((pred, succ))
        return True

    alpha_tasks = [n for n in active if n['project'] == 'Alpha' and n['type'] == 'Task' and n['state'] != WEIRD_STATE]
    completed_alpha = next(n for n in completed if n['project'] == 'Alpha')
    chain = [completed_alpha] + alpha_tasks[:3]
    for pred, succ in zip(chain, chain[1:]):
        add_edge(pred, succ)

    def fill(count, pred_pool, succ_pool):
        added = attempts = 0
        while added < count and attempts < 10000:
            attempts += 1
            if add_edge(rng.choice(pred_pool), rng.choice(succ_pool)):
                added += 1

    fill(16, completed, active)
    fill(30, active, active)
    for ctx in context[:2]:
        add_edge(ctx, rng.choice(active))

    seen_pairs = set()
    while len(rel_pairs) < 6:
        a, b = rng.sample(active, 2)
        key = frozenset((a['id'], b['id']))
        if key not in seen_pairs:
            seen_pairs.add(key)
            rel_pairs.append((a, b))

    for pred, succ in edges:
        succ['preds'].append(_entry(pred, 'predecessor'))
        pred['succs'].append(_entry(succ, 'successor'))
    for a, b in rel_pairs:
        a['rels'].append(_entry(b, 'related'))
        b['rels'].append(_entry(a, 'related'))


def _entry(target, rel_type):
    rel_name = {'predecessor': 'Predecessor', 'successor': 'Successor', 'related': 'Related'}[rel_type]
    return {
        'id': target['id'],
        'relType': rel_type,
        'relName': rel_name,
        'comment': '',
        'url': URL_TEMPLATE.format(project=target['project'], id=target['id']),
        'title': target['title'],
        'type': target['type'],
        'state': target['state'],
        'assignedTo': _assigned_to(target),
        'project': target['project'],
    }


def _row(node, synced_at):
    parent = node['parent']
    unassigned = node['assignee'] is None
    lower_type = node['type'].lower()
    relations = {
        'predecessors': node['preds'],
        'successors': node['succs'],
        'related': node['rels'],
        'total': len(node['preds']) + len(node['succs']) + len(node['rels']),
    }
    # Evidence only: a predecessor without a verifiable state is unknown (neither blocking nor clear).
    blocked = any(e.get('state') and not _is_completed(e['state']) for e in node['preds'])
    return {
        'id': node['id'],
        'title': node['title'],
        'type': node['type'],
        'state': node['state'],
        'project': node['project'],
        'assigned_to': _assigned_to(node),
        'assigned_avatar': '',
        'priority': node['priority'],
        'iteration': node['iteration'],
        'area_path': f"{node['project']}\\Team",
        'parent_id': parent['id'] if parent else None,
        'parent_title': parent['title'] if parent else None,
        'parent_type': parent['type'] if parent else None,
        'story_points': node['points'],
        'changed_date': _iso(node['changed']),
        'created_date': _iso(node['created']),
        'is_bug': 1 if 'bug' in lower_type else 0,
        'is_task': 1 if 'task' in lower_type else 0,
        'is_unassigned': 1 if unassigned else 0,
        'is_active': node['is_active'],
        'is_blocked': 1 if blocked else 0,
        'is_blocking': 1 if node['succs'] else 0,
        'url': URL_TEMPLATE.format(project=node['project'], id=node['id']),
        'description': f"Fixture {lower_type} in {node['project']}.",
        'relations_json': json.dumps(relations),
        'last_synced_at': synced_at,
        'deleted_at': None,
        'last_seen_at': synced_at,
        'is_context': 1 if node['is_context'] else 0,
    }


def build_fixture(synced_at=None):
    """Returns the fixture rows (dicts keyed by COLUMNS). Pure function of FIXTURE_SEED."""
    stamp = synced_at or BASE_DATE.isoformat()
    rng = random.Random(FIXTURE_SEED)
    nodes = _build_nodes(rng)

    changed_pool = []
    for n in nodes:
        n['assignee'] = _pick_assignee(rng)
        n['priority'] = rng.choice([1, 2, 2, 3, 3, 4])
        n['points'] = rng.choice([None, 1.0, 2.0, 3.0, 5.0, 8.0])
        n['iteration'] = f"{n['project']}\\Sprint {rng.randint(1, 4)}"
        n['created'] = BASE_DATE - timedelta(days=rng.randint(1, 60))
        if changed_pool and rng.random() < 0.3:
            n['changed'] = rng.choice(changed_pool)
        else:
            n['changed'] = BASE_DATE + timedelta(minutes=rng.randint(0, 60 * 24 * 20))
        changed_pool.append(n['changed'])

    _link(nodes, rng)
    rows = [_row(n, stamp) for n in nodes]
    rows.append(_unresolved_predecessor_row(rows, stamp))
    return rows


UNRESOLVED_TARGET_ID = 999999
UNRESOLVED_DEPENDENT_TITLE = 'Fixture unresolved-predecessor case'


def _unresolved_predecessor_row(rows, stamp):
    """An ACTIVE task whose only predecessor can not be read (deleted / inaccessible in Azure DevOps).

    The relation entry carries no title/state, exactly like a real sync stores it. The dependency screens must show
    it as "unresolved" and must NOT claim the task is blocked or clear. It is assigned to FIXTURE_USER so the case
    is reachable from My Tasks. Appended last: it never shifts the seeded random stream.
    """
    template = next(r for r in rows if r['project'] == 'Alpha' and r['is_active'] == 1 and r['is_context'] == 0
                    and r['type'] == 'Task' and r['state'] == 'New')
    relations = {
        'predecessors': [{
            'id': UNRESOLVED_TARGET_ID, 'relType': 'predecessor', 'relName': 'Predecessor', 'comment': '',
            'url': URL_TEMPLATE.format(project='Alpha', id=UNRESOLVED_TARGET_ID),
        }],
        'successors': [], 'related': [], 'total': 1,
    }
    new_id = max(r['id'] for r in rows) + 1
    row = dict(template)
    row.update({
        'id': new_id,
        'title': UNRESOLVED_DEPENDENT_TITLE,
        'assigned_to': FIXTURE_USER,
        'is_unassigned': 0,
        'parent_id': None, 'parent_title': None, 'parent_type': None,
        'is_blocked': 0,
        'is_blocking': 0,
        'relations_json': json.dumps(relations),
        'url': URL_TEMPLATE.format(project='Alpha', id=new_id),
    })
    return row


def expected_invariants(rows=None):
    """Counts computed directly from the rows; tests and callers compare against these."""
    rows = build_fixture() if rows is None else rows
    active = [r for r in rows if r['is_active'] == 1 and r['is_context'] == 0]
    per_project = {p: 0 for p in PROJECTS}
    per_state = Counter()
    for r in active:
        per_project[r['project']] = per_project.get(r['project'], 0) + 1
        per_state[r['state']] += 1
    changed_counts = Counter(r['changed_date'] for r in rows)
    relations = [json.loads(r['relations_json']) for r in rows]
    needle = [r for r in active if 'needle' in r['title'].lower()]
    return {
        'total_rows': len(rows),
        'total_active': len(active),
        'total_org_active': len(active),
        'total_context': sum(1 for r in rows if r['is_context'] == 1),
        'completed_count': sum(1 for r in rows if r['is_active'] == 0 and r['is_context'] == 0),
        'per_project_active': per_project,
        'per_state_active': dict(per_state),
        'my_tasks_active': sum(1 for r in active if r['assigned_to'] == FIXTURE_USER),
        'my_tasks_completed': sum(1 for r in rows if r['assigned_to'] == FIXTURE_USER
                                  and r['is_active'] == 0 and r['is_context'] == 0),
        'unassigned_active': sum(1 for r in active if r['is_unassigned'] == 1),
        'assigned_active': sum(1 for r in active if r['is_unassigned'] == 0),
        'blocked_active': sum(1 for r in active if r['is_blocked'] == 1),
        'blocking_active': sum(1 for r in active if r['is_blocking'] == 1),
        'bugs_active': sum(1 for r in active if r['is_bug'] == 1),
        'tasks_active': sum(1 for r in active if r['is_task'] == 1),
        'kanban_todo_active': sum(1 for r in active if r['state'] in _KANBAN_TODO_STATES),
        'new_state_active': per_state.get('New', 0),
        'p1_active': sum(1 for r in active if r['priority'] == 1),
        'needle_count': len(needle),
        'needle_capital_count': sum(1 for r in active if 'Needle' in r['title']),
        'turkish_title_count': sum(1 for r in active if 'İğdır' in r['title']),
        'weird_state_count': sum(1 for r in active if r['state'] == WEIRD_STATE),
        'predecessor_links': sum(len(rel['predecessors']) for rel in relations),
        'related_links': sum(len(rel['related']) for rel in relations),
        'max_changed_date': max(r['changed_date'] for r in rows),
        'shared_changed_date_rows': sum(1 for r in rows if changed_counts[r['changed_date']] > 1),
    }


def _read_meta(conn, key):
    row = conn.execute('SELECT val FROM sync_state WHERE key = ?', (key,)).fetchone()
    return row['val'] if row else None


def _seed_locked(conn, rows, summary):
    cur = conn.cursor()
    row_count = cur.execute('SELECT COUNT(*) FROM work_items').fetchone()[0]
    marker = _read_meta(conn, 'fixture_mode')
    if row_count and marker == '1':
        return {**summary, 'seeded': False, 'rows_written': 0}
    if row_count:
        raise RuntimeError('refusing to seed fixture over non-fixture data')

    now = datetime.utcnow().isoformat()
    meta = {
        'watermark': summary['max_changed_date'],
        'last_full_sync': now,
        'last_incremental_sync': now,
        'last_success_at': now,
        'total_org_active': summary['total_org_active'],
        'sync_status': 'idle',
        'sync_error': '',
        'fixture_mode': '1',
        'last_sync_result': json.dumps({
            'mode': 'full', 'status': 'success', 'fetched': len(rows), 'upserted': len(rows),
            'deleted': 0, 'out_of_scope': 0, 'warnings': [], 'fixture': True,
        }),
    }
    placeholders = ', '.join('?' * len(COLUMNS))
    try:
        cur.execute('DELETE FROM work_items')
        cur.executemany(
            f"INSERT INTO work_items ({', '.join(COLUMNS)}) VALUES ({placeholders})",
            [tuple(r[c] for c in COLUMNS) for r in rows],
        )
        for key, val in meta.items():
            cur.execute(
                'INSERT INTO sync_state (key, val, updated_at) VALUES (?, ?, ?) '
                'ON CONFLICT(key) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at',
                (key, str(val), now),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {**summary, 'seeded': True, 'rows_written': len(rows)}


def seed_fixture(conn=None):
    """Writes the fixture in one transaction. No-op when the fixture is already seeded.

    Returns expected_invariants() plus 'seeded' (bool) and 'rows_written'.
    """
    rows = build_fixture(synced_at=datetime.utcnow().isoformat())
    summary = expected_invariants(rows)
    own_conn = conn is None
    if own_conn:
        sync_service.init_db()
        conn = sync_service.get_db_connection()
    try:
        with sync_service.db_lock:
            return _seed_locked(conn, rows, summary)
    finally:
        if own_conn:
            conn.close()


def ensure_fixture_database():
    """Fixture-mode guard. Returns False (writing nothing) when the cache holds rows that are not
    fixture data; otherwise seeds the fixture (a no-op when it is already seeded) and returns True."""
    sync_service.init_db()
    conn = sync_service.get_db_connection()
    try:
        with sync_service.db_lock:
            has_rows = conn.execute('SELECT 1 FROM work_items LIMIT 1').fetchone() is not None
            marker = _read_meta(conn, 'fixture_mode')
    finally:
        conn.close()
    if has_rows and marker != '1':
        return False
    seed_fixture()
    return True
