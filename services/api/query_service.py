"""Read-only query layer over the SQLite work_items cache (docs/pagination-api.md).

No Flask import here: app.py maps ParamError to HTTP 400.
"""
import math
import re
import unicodedata

import sync_service

QUICK_FILTERS = ('all', 'my-tasks', 'unassigned', 'blocked', 'blocking', 'bugs')
SORT_FIELDS = {
    'changeddate': 'changed_date',
    'changed_date': 'changed_date',
    'priority': 'priority',
    'id': 'id',
    'title': 'title',
    'state': 'state',
}
SORT_API_NAMES = {'changed_date': 'changedDate', 'priority': 'priority', 'id': 'id',
                  'title': 'title', 'state': 'state'}
COLUMNS = ('todo', 'in-progress', 'resolved', 'done')
SWIMLANES = ('none', 'parent', 'assignee', 'priority')
MAX_PROGRESS_IDS = 500

_COMBINING_DOT = '\u0307'
_TERMINAL = ('done', 'closed', 'completed')


class ParamError(ValueError):
    pass


def fold(s):
    """Case/Unicode/Turkish-insensitive fold used by the ci_fold SQL function."""
    text = unicodedata.normalize('NFKC', s or '').casefold()
    return text.replace(_COMBINING_DOT, '').replace('\u0131', 'i')


def register_functions(conn):
    conn.create_function('ci_fold', 1, fold, deterministic=True)


def column_case_sql(expr='state'):
    return (
        f"(CASE lower(trim({expr})) "
        "WHEN 'new' THEN 'todo' WHEN 'to do' THEN 'todo' WHEN 'todo' THEN 'todo' WHEN 'proposed' THEN 'todo' "
        "WHEN 'resolved' THEN 'resolved' WHEN 'testing' THEN 'resolved' "
        "WHEN 'in review' THEN 'resolved' WHEN 'in-review' THEN 'resolved' "
        "WHEN 'closed' THEN 'done' WHEN 'done' THEN 'done' WHEN 'completed' THEN 'done' "
        "ELSE 'in-progress' END)"
    )


def _int(value, name, lo=None, hi=None, default=None):
    if value is None or value == '':
        return default
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        raise ParamError(f"{name} must be an integer")
    if lo is not None and n < lo:
        raise ParamError(f"{name} must be >= {lo}")
    if hi is not None and n > hi:
        raise ParamError(f"{name} must be <= {hi}")
    return n


def _split(values):
    out = []
    for raw in values:
        for part in str(raw).split(','):
            part = part.strip()
            if part:
                out.append(part)
    return out


def _bool(value):
    return str(value or '').strip().lower() in ('1', 'true', 'yes')


def parse_list_params(args):
    """Parses a werkzeug MultiDict-like (or dict) into a normalised params dict. Raises ParamError."""
    def get(*names, default=None):
        for n in names:
            if n in args and args.get(n) not in (None,):
                return args.get(n)
        return default

    def getlist(*names):
        vals = []
        for n in names:
            if hasattr(args, 'getlist'):
                vals.extend(args.getlist(n))
            elif n in args:
                v = args[n]
                vals.extend(v if isinstance(v, (list, tuple)) else [v])
        return vals

    limit = _int(get('limit', 'pageSize', 'page_size'), 'limit', 1, default=None)
    if limit is None:
        limit = 50
    elif limit > 200:
        limit = 200
    page_raw = get('page')
    offset_raw = get('offset')
    if page_raw not in (None, ''):
        page = _int(page_raw, 'page', 1)
        offset = (page - 1) * limit
    else:
        offset = _int(offset_raw, 'offset', 0, default=0)
        page = offset // limit + 1

    quick = (get('quickFilter', 'quick_filter', default='all') or 'all').strip()
    if quick not in QUICK_FILTERS:
        raise ParamError(f"quickFilter must be one of {', '.join(QUICK_FILTERS)}")
    current_user = (get('currentUser', 'current_user', default='') or '').strip()
    if quick == 'my-tasks' and not current_user:
        raise ParamError('currentUser is required for quickFilter=my-tasks')

    sort_raw = (get('sortBy', 'sort_by', default='changedDate') or 'changedDate').strip()
    sort_key = SORT_FIELDS.get(sort_raw.lower())
    if sort_key is None:
        raise ParamError('sortBy must be one of changedDate, priority, id, title, state')
    order = (get('sortOrder', 'sort_order', default='desc') or 'desc').strip().lower()
    if order not in ('asc', 'desc'):
        raise ParamError('sortOrder must be asc or desc')

    column = (get('column', default='') or '').strip().lower()
    if column and column not in COLUMNS:
        raise ParamError(f"column must be one of {', '.join(COLUMNS)}")

    swimlane = (get('swimlane', default='none') or 'none').strip().lower()
    if swimlane not in SWIMLANES:
        raise ParamError(f"swimlane must be one of {', '.join(SWIMLANES)}")

    lane = (get('lane', default='') or '').strip()
    lane_mode = lane_key = None
    if lane:
        if ':' not in lane:
            raise ParamError('lane must be <mode>:<key>')
        lane_mode, lane_key = lane.split(':', 1)
        lane_mode = lane_mode.strip().lower()
        lane_key = lane_key.strip()
        if lane_mode not in ('parent', 'assignee', 'priority') or not lane_key:
            raise ParamError('lane must be parent:<id|none>, assignee:<name>, or priority:<1-4>')
        if lane_mode == 'parent' and lane_key != 'none':
            _int(lane_key, 'lane', 1)
        if lane_mode == 'priority':
            _int(lane_key, 'lane', 1, 4)

    types = _split(getlist('type', 'types')) or None
    states = _split(getlist('state', 'states')) or None
    assignees = [a.strip() for a in getlist('assignee') if a and a.strip()] or None
    prios_raw = _split(getlist('priority', 'priorities'))
    priorities = None
    if prios_raw:
        priorities = sorted({_int(p, 'priority', 1, 4) for p in prios_raw})

    return {
        'limit': limit,
        'page': page,
        'offset': offset,
        'search': (get('search', 'q', default='') or '').strip(),
        'project': (get('project', default='all') or 'all').strip() or 'all',
        'assignees': assignees,
        'quickFilter': quick,
        'currentUser': current_user,
        'types': types,
        'states': states,
        'priorities': priorities,
        'column': column or None,
        'includeCompleted': _bool(get('includeCompleted', 'include_completed', default='')),
        'sortBy': SORT_API_NAMES[sort_key],
        'sortKey': sort_key,
        'sortOrder': order,
        'swimlane': swimlane,
        'laneMode': lane_mode,
        'laneKey': lane_key,
        'hideCompleted': _bool(get('hideCompleted', default='')),
        'laneLimit': _int(get('laneLimit'), 'laneLimit', 1, 100, default=25),
        'laneOffset': _int(get('laneOffset'), 'laneOffset', 0, default=0),
        'cardLimit': _int(get('cardLimit'), 'cardLimit', 1, 50, default=15),
    }


def _search_clause(term):
    words = [w for w in term.split() if w]
    clauses, params = [], []
    for w in words:
        needle = fold(w)
        esc = needle.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        pat = f'%{esc}%'
        clauses.append(
            "(ci_fold(title) LIKE ? ESCAPE '\\' OR ci_fold(CAST(id AS TEXT)) LIKE ? ESCAPE '\\' "
            "OR ci_fold(assigned_to) LIKE ? ESCAPE '\\' OR ci_fold(project) LIKE ? ESCAPE '\\' "
            "OR ci_fold(parent_title) LIKE ? ESCAPE '\\')"
        )
        params.extend([pat] * 5)
    return ' AND '.join(clauses), params


def build_where(p, *, include_project=True, lane=True, column=True, quick=True, facets=True):
    """Returns (where_sql, params) for the list/count/kanban predicate.

    Keyword flags let summary/kanban reuse the same predicate minus pieces they compute themselves.
    """
    clauses = ['deleted_at IS NULL', 'is_context = 0']
    params = []
    if not p['includeCompleted']:
        clauses.append('is_active = 1')
    if include_project and p['project'] != 'all':
        clauses.append('project = ?')
        params.append(p['project'])
    if facets and p.get('assignees'):
        parts = []
        names = [a for a in p['assignees'] if a != 'Unassigned']
        if names:
            parts.append(f"assigned_to IN ({','.join('?' for _ in names)}) AND is_unassigned = 0")
            params.extend(names)
        if len(names) != len(p['assignees']):
            parts.append('is_unassigned = 1')
        clauses.append('(' + ' OR '.join(parts) + ')')
    if quick:
        qf = p['quickFilter']
        if qf == 'my-tasks':
            clauses.append('assigned_to = ?')
            params.append(p['currentUser'])
        elif qf == 'unassigned':
            clauses.append('is_unassigned = 1')
        elif qf == 'blocked':
            clauses.append('is_blocked = 1')
        elif qf == 'blocking':
            clauses.append('is_blocking = 1')
        elif qf == 'bugs':
            clauses.append('is_bug = 1')
    if p.get('search'):
        sql, sp = _search_clause(p['search'])
        if sql:
            clauses.append(sql)
            params.extend(sp)
    if facets and p.get('types'):
        clauses.append(f"type IN ({','.join('?' for _ in p['types'])})")
        params.extend(p['types'])
    if facets and p.get('states'):
        clauses.append(f"state IN ({','.join('?' for _ in p['states'])})")
        params.extend(p['states'])
    if facets and p.get('priorities'):
        clauses.append(f"priority IN ({','.join('?' for _ in p['priorities'])})")
        params.extend(p['priorities'])
    if column and p.get('column'):
        clauses.append(f"{column_case_sql()} = ?")
        params.append(p['column'])
    if lane and p.get('laneMode'):
        mode, key = p['laneMode'], p['laneKey']
        if mode == 'parent':
            if key == 'none':
                clauses.append('parent_id IS NULL')
            else:
                clauses.append('parent_id = ?')
                params.append(int(key))
        elif mode == 'assignee':
            if key == 'Unassigned' or key == 'Unassigned Pool':
                clauses.append('is_unassigned = 1')
            else:
                clauses.append('is_unassigned = 0 AND assigned_to = ?')
                params.append(key)
        elif mode == 'priority':
            clauses.append('priority = ?')
            params.append(int(key))
    return ' AND '.join(clauses), params


def order_sql(p, qualify=''):
    d = 'DESC' if p['sortOrder'] == 'desc' else 'ASC'
    key = p['sortKey']
    q = qualify
    if key == 'priority':
        flipped = 'ASC' if d == 'DESC' else 'DESC'
        return (f"{q}priority {d}, {q}is_blocked {flipped}, {q}changed_date {flipped} NULLS LAST, {q}id ASC")
    if key == 'changed_date':
        return f"{q}changed_date {d} NULLS LAST, {q}id ASC"
    if key == 'title':
        return f"{q}title {d}, {q}id ASC"
    if key == 'state':
        return f"{q}state {d}, {q}id ASC"
    return f"{q}id {d}"


def _connect():
    return sync_service.get_db_connection()


def _last_synced():
    return (sync_service.get_sync_meta('last_success_at') or sync_service.get_sync_meta('last_incremental_sync')
            or sync_service.get_sync_meta('last_full_sync'))


def _data_scope():
    return 'fixture' if sync_service.is_fixture_mode() else 'live_cached'


def _source():
    return 'fixture' if sync_service.is_fixture_mode() else 'live'


def _rows_to_items(rows):
    return [sync_service.row_to_work_item_dict(r) for r in rows]


def list_work_items(params):
    """Implements GET /api/work-items. `params` is the dict from parse_list_params."""
    where, wparams = build_where(params)
    order = order_sql(params)
    limit, offset = params['limit'], params['offset']
    with sync_service.db_lock, _connect() as conn:
        register_functions(conn)
        total = conn.execute(f"SELECT COUNT(*) AS c FROM work_items WHERE {where}", wparams).fetchone()['c']
        rows = conn.execute(
            f"SELECT * FROM work_items WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
            wparams + [limit, offset],
        ).fetchall()
        version = sync_service.get_data_version()
        last = _last_synced()
    items = _rows_to_items(rows)
    total_pages = max(1, math.ceil(total / limit)) if total else 1
    page = offset // limit + 1
    return {
        'items': items,
        'total': total,
        'totalCount': total,
        'limit': limit,
        'offset': offset,
        'page': page,
        'pageSize': limit,
        'totalPages': total_pages,
        'hasNext': offset + len(items) < total,
        'hasPrev': offset > 0,
        'sort': {'by': params['sortBy'], 'order': params['sortOrder']},
        'dataVersion': version,
        'lastSyncedAt': last,
        'dataScope': _data_scope(),
    }


def _facet_counts(conn, where, wparams, column_expr):
    out = {}
    for r in conn.execute(
        f"SELECT {column_expr} AS k, COUNT(*) AS c FROM work_items WHERE {where} GROUP BY k", wparams
    ).fetchall():
        out[r['k']] = r['c']
    return out


def summary(project='all', current_user=''):
    """Implements GET /api/work-items/summary. Counts use the same predicates as list filters."""
    base = parse_list_params({'project': project or 'all', 'quickFilter': 'all'})
    base['currentUser'] = current_user or ''
    scope_where, scope_params = build_where(base, quick=False)
    with sync_service.db_lock, _connect() as conn:
        register_functions(conn)
        version = sync_service.get_data_version()

        def count_for(qf):
            p = dict(base, quickFilter=qf)
            if qf == 'my-tasks' and not current_user:
                return 0
            w, wp = build_where(p)
            return conn.execute(f"SELECT COUNT(*) AS c FROM work_items WHERE {w}", wp).fetchone()['c']

        total = conn.execute(f"SELECT COUNT(*) AS c FROM work_items WHERE {scope_where}", scope_params).fetchone()['c']
        types = _facet_counts(conn, scope_where, scope_params, 'type')
        states = _facet_counts(conn, scope_where, scope_params, 'state')
        priorities = {str(k): v for k, v in _facet_counts(conn, scope_where, scope_params, 'priority').items()}
        proj_where, proj_params = build_where(base, include_project=False, quick=False)
        projects = [
            {'name': r['k'], 'total': r['c']}
            for r in conn.execute(
                f"SELECT project AS k, COUNT(*) AS c FROM work_items WHERE {proj_where} "
                "GROUP BY project ORDER BY project", proj_params).fetchall()
        ]
        completed_where = ('deleted_at IS NULL AND is_context = 0 AND is_active = 0'
                           + (' AND project = ?' if base['project'] != 'all' else ''))
        completed_params = [base['project']] if base['project'] != 'all' else []
        completed = conn.execute(
            f"SELECT COUNT(*) AS c FROM work_items WHERE {completed_where}", completed_params
        ).fetchone()['c']
        my_blocked = 0
        if current_user:
            mb_p = dict(base, quickFilter='blocked', assignees=[current_user])
            mb_w, mb_wp = build_where(mb_p)
            my_blocked = conn.execute(f"SELECT COUNT(*) AS c FROM work_items WHERE {mb_w}", mb_wp).fetchone()['c']

        scope = {
            'project': base['project'],
            'total': total,
            'myTasks': count_for('my-tasks'),
            'unassigned': count_for('unassigned'),
            'blocked': count_for('blocked'),
            'myBlocked': my_blocked,
            'blocking': count_for('blocking'),
            'bugs': count_for('bugs'),
        }
    return {
        'scope': scope,
        'facets': {'types': types, 'states': states, 'priorities': priorities},
        'projects': projects,
        'completed': completed,
        'dataVersion': version,
    }


def _state_category(state):
    s = (state or '').strip().lower()
    if not s:
        return 'Proposed'
    return {
        'closed': 'Completed', 'done': 'Completed', 'completed': 'Completed',
        'resolved': 'Resolved', 'testing': 'Resolved', 'in review': 'Resolved', 'in-review': 'Resolved',
        'active': 'InProgress', 'in progress': 'InProgress', 'in-progress': 'InProgress', 'committed': 'InProgress',
        'new': 'Proposed', 'to do': 'Proposed', 'todo': 'Proposed', 'proposed': 'Proposed',
        'removed': 'Removed',
    }.get(s, 'InProgress')


def _js_round(x):
    return math.floor(x + 0.5)


def _node_progress(node_id, children, nodes, memo, path):
    """Returns (leaves dict id->node) under node_id, memoised per call. Cycle-safe via path."""
    if node_id in memo:
        return memo[node_id]
    result = {}
    if node_id in path:
        return result
    path.add(node_id)
    kids = children.get(node_id, [])
    if not kids:
        n = nodes[node_id]
        if _state_category(n['state']) != 'Removed':
            result[node_id] = n
    else:
        for kid in kids:
            result.update(_node_progress(kid, children, nodes, memo, path))
    path.discard(node_id)
    memo[node_id] = result
    return result


def compute_progress_map(rows):
    """Pure canonical progress over rows: iterable of mappings with id, parent_id, state, is_blocked,
    is_unassigned. Returns {id: progress dict} for every node."""
    nodes = {}
    children = {}
    for r in rows:
        nodes[r['id']] = r
    for r in rows:
        pid = r['parent_id']
        if pid is not None and pid in nodes and pid != r['id']:
            children.setdefault(pid, []).append(r['id'])
    memo = {}
    out = {}
    for nid, n in nodes.items():
        leaves = _node_progress(nid, children, nodes, memo, set())
        total = len(leaves)
        completed = sum(1 for lf in leaves.values() if (lf['state'] or '').strip().lower() in _TERMINAL)
        pct = _js_round(completed / total * 100) if total else 0
        out[nid] = {
            'totalUnits': total,
            'completedUnits': completed,
            'percent': int(pct),
            'blockedCount': sum(1 for lf in leaves.values() if lf['is_blocked']),
            'unassignedCount': sum(1 for lf in leaves.values() if lf['is_unassigned']),
            'hasChildren': bool(children.get(nid)),
        }
    return out


def progress_for(ids):
    """Implements GET /api/work-items/progress. Computed over the full alive hierarchy."""
    ids = list(dict.fromkeys(int(i) for i in ids))
    if len(ids) > MAX_PROGRESS_IDS:
        raise ParamError(f"at most {MAX_PROGRESS_IDS} ids per request")
    with sync_service.db_lock, _connect() as conn:
        rows = conn.execute(
            'SELECT id, parent_id, state, is_blocked, is_unassigned FROM work_items WHERE deleted_at IS NULL'
        ).fetchall()
        version = sync_service.get_data_version()
    full = compute_progress_map(rows)
    return {
        'progress': {str(i): full[i] for i in ids if i in full},
        'dataVersion': version,
    }


CHILDREN_LIMIT = 500
BATCH_LIMIT = 100


def _parse_id_list(raw, limit, name):
    ids = []
    seen = set()
    for part in str(raw or '').split(','):
        part = part.strip()
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            raise ParamError(f"{name} must be comma-separated integers")
        if n in seen:
            continue
        seen.add(n)
        ids.append(n)
    if not ids:
        raise ParamError(f"{name} is required")
    if len(ids) > limit:
        raise ParamError(f"at most {limit} ids per request")
    return ids


def children(item_id):
    """Implements GET /api/work-items/<id>/children (doc §9). Includes context and completed rows.
    Returns None when the parent itself is not alive."""
    with sync_service.db_lock, _connect() as conn:
        parent = conn.execute('SELECT 1 FROM work_items WHERE id = ? AND deleted_at IS NULL', (item_id,)).fetchone()
        if parent is None:
            return None
        total = conn.execute(
            'SELECT COUNT(*) AS c FROM work_items WHERE parent_id = ? AND deleted_at IS NULL', (item_id,)
        ).fetchone()['c']
        rows = conn.execute(
            'SELECT * FROM work_items WHERE parent_id = ? AND deleted_at IS NULL '
            'ORDER BY is_active DESC, priority ASC, id ASC LIMIT ?',
            (item_id, CHILDREN_LIMIT),
        ).fetchall()
        version = sync_service.get_data_version()
    return {
        'items': _rows_to_items(rows),
        'total': total,
        'truncated': total > len(rows),
        'dataVersion': version,
    }


def batch(raw_ids):
    """Implements GET /api/work-items/batch (doc §10). Context rows allowed; order = request order."""
    ids = _parse_id_list(raw_ids, BATCH_LIMIT, 'ids')
    with sync_service.db_lock, _connect() as conn:
        marks = ','.join('?' for _ in ids)
        rows = conn.execute(
            f'SELECT * FROM work_items WHERE id IN ({marks}) AND deleted_at IS NULL', ids
        ).fetchall()
        version = sync_service.get_data_version()
    by_id = {r['id']: r for r in rows}
    return {
        'items': [sync_service.row_to_work_item_dict(by_id[i]) for i in ids if i in by_id],
        'missing': [i for i in ids if i not in by_id],
        'dataVersion': version,
    }


_LANE_EXPR = {
    'none': "'all'",
    'parent': "COALESCE(CAST(parent_id AS TEXT), 'none')",
    'assignee': "CASE WHEN is_unassigned = 1 THEN 'Unassigned' ELSE COALESCE(assigned_to, 'Unassigned') END",
    'priority': "CAST(COALESCE(priority, 3) AS TEXT)",
}


def _lane_order(mode, lanes):
    if mode == 'none':
        return list(lanes)
    if mode == 'parent':
        return sorted(lanes, key=lambda k: (k == 'none', -lanes[k], 0 if k == 'none' else int(k)))
    if mode == 'assignee':
        return sorted(lanes, key=lambda k: (k == 'Unassigned', -lanes[k], k))
    return sorted(lanes, key=lambda k: int(k))


def _lane_meta(conn, mode, key, sample_row):
    if mode == 'none':
        return {'id': 'all', 'key': 'all', 'title': 'All Active Work', 'type': None, 'project': None}
    if mode == 'parent':
        if key == 'none':
            return {'id': 'independent', 'key': 'none', 'title': 'Independent / Top-Level Tasks',
                    'type': None, 'project': None}
        parent = conn.execute(
            'SELECT title, type, project FROM work_items WHERE id = ? AND deleted_at IS NULL', (int(key),)
        ).fetchone()
        if parent is not None:
            title, ptype, project = parent['title'], parent['type'], parent['project']
        else:
            title = sample_row['parent_title'] if sample_row is not None else None
            ptype = sample_row['parent_type'] if sample_row is not None else None
            project = sample_row['project'] if sample_row is not None else None
        return {'id': f'parent-{key}', 'key': key, 'title': title or f'Parent #{key}',
                'type': ptype or 'Story', 'project': project}
    if mode == 'assignee':
        name = 'Unassigned Pool' if key == 'Unassigned' else key
        return {'id': f"assignee-{key.replace(' ', '-').lower()}", 'key': key, 'title': name,
                'type': None, 'project': None}
    return {'id': f'priority-{key}', 'key': key, 'title': f'P{key} Priority', 'type': None, 'project': None}


def kanban(params):
    """Implements GET /api/kanban (doc §5)."""
    mode = params['swimlane']
    scope_p = dict(params, column=None, laneMode=None)
    where, wparams = build_where(scope_p, column=False, lane=False)
    if params['hideCompleted']:
        where = f"({where}) AND {column_case_sql()} != 'done'"
    lane_expr = _LANE_EXPR[mode]
    col_expr = column_case_sql()
    order = order_sql(params)
    with sync_service.db_lock, _connect() as conn:
        register_functions(conn)
        version = sync_service.get_data_version()
        col_totals = {c: 0 for c in COLUMNS}
        for r in conn.execute(
            f"SELECT {col_expr} AS c, COUNT(*) AS n FROM work_items WHERE {where} GROUP BY c", wparams
        ).fetchall():
            col_totals[r['c']] = r['n']
        lane_counts = {}
        for r in conn.execute(
            f"SELECT {lane_expr} AS lk, {col_expr} AS c, COUNT(*) AS n FROM work_items WHERE {where} "
            "GROUP BY lk, c", wparams
        ).fetchall():
            lane_counts.setdefault(r['lk'], {c: 0 for c in COLUMNS})[r['c']] = r['n']
        lane_totals = {k: sum(v.values()) for k, v in lane_counts.items()}
        ordered = _lane_order(mode, lane_totals) if lane_totals else []
        lane_total_count = len(ordered)
        window = ordered[params['laneOffset']:params['laneOffset'] + params['laneLimit']]

        cards = {}
        samples = {}
        if window:
            placeholders = ','.join('?' for _ in window)
            cards_sql = (
                f"SELECT * FROM (SELECT work_items.*, {lane_expr} AS lk, {col_expr} AS col, "
                f"ROW_NUMBER() OVER (PARTITION BY {lane_expr}, {col_expr} ORDER BY {order}) AS rn "
                f"FROM work_items WHERE {where}) "
                f"WHERE rn <= ? AND lk IN ({placeholders}) ORDER BY lk, col, rn"
            )
            for r in conn.execute(cards_sql, wparams + [params['cardLimit']] + window).fetchall():
                cards.setdefault((r['lk'], r['col']), []).append(r)
                samples.setdefault(r['lk'], r)

        progress_map = None
        if mode == 'parent':
            alive = conn.execute(
                'SELECT id, parent_id, state, is_blocked, is_unassigned FROM work_items WHERE deleted_at IS NULL'
            ).fetchall()
            progress_map = compute_progress_map(alive)

        lanes = []
        for lk in window:
            counts = lane_counts.get(lk, {c: 0 for c in COLUMNS})
            total = lane_totals[lk]
            meta = _lane_meta(conn, mode, lk, samples.get(lk))
            columns = {c: _rows_to_items(cards.get((lk, c), [])) for c in COLUMNS}
            progress = None
            if mode == 'parent' and lk != 'none' and int(lk) in progress_map:
                pm = progress_map[int(lk)]
                progress = {k: pm[k] for k in ('totalUnits', 'completedUnits', 'percent')}
            if progress is None:
                done = counts['done']
                progress = {'totalUnits': total, 'completedUnits': done,
                            'percent': int(_js_round(done / total * 100)) if total else 0}
            lane = {
                'id': meta['id'], 'key': meta['key'], 'mode': mode,
                'title': meta['title'], 'type': meta['type'], 'project': meta['project'],
                'total': total, 'counts': counts, 'columns': columns, 'progress': progress,
            }
            lanes.append(lane)

    return {
        'columns': col_totals,
        'total': sum(col_totals.values()),
        'laneMode': mode,
        'laneTotal': lane_total_count,
        'laneLimit': params['laneLimit'],
        'laneOffset': params['laneOffset'],
        'lanes': lanes,
        'sort': {'by': params['sortBy'], 'order': params['sortOrder']},
        'hideCompleted': params['hideCompleted'],
        'dataVersion': version,
        'dataScope': _data_scope(),
    }
