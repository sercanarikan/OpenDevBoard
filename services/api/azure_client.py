"""Read-only Azure DevOps REST client used by the sync engine.

Only HTTP GET and the WIQL query POST (``/_apis/wit/wiql``) are issued.
"""

import base64
import logging
import os
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import requests

logger = logging.getLogger('azure_client')

WIQL_RESULT_LIMIT = 20000
BATCH_SIZE = 200
API_VERSION = '7.1'
RETRY_STATUSES = (429, 502, 503, 504)
RETRY_AFTER_CAP = 30
# Bounded parallelism for the read-only detail GETs of get_items(); SYNC_DETAIL_WORKERS selects it.
# 1 (the default) is the previous strictly sequential behaviour; anything above MAX_DETAIL_WORKERS is clamped.
DEFAULT_DETAIL_WORKERS = 1
MAX_DETAIL_WORKERS = 8
SIZE_LIMIT_MARKERS = ('VS402337', 'size limit')
WIQL_PATH = '/_apis/wit/wiql'


class AzureError(Exception):
    def __init__(self, message, status=None, retryable=False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.size_limit = False


def quote_wiql(value):
    return str(value).replace("'", "''")


@dataclass
class CollectResult:
    ids: list
    partitions: int
    partitioned: bool
    queries: int
    warnings: list = field(default_factory=list)


@dataclass
class FetchResult:
    items: dict = field(default_factory=dict)
    missing: list = field(default_factory=list)
    batches: int = 0
    failed_batches: list = field(default_factory=list)
    errors: list = field(default_factory=list)


def _body_text(resp):
    text = getattr(resp, 'text', '')
    return text if isinstance(text, str) else ''


def _parse_retry_after(resp):
    headers = getattr(resp, 'headers', None) or {}
    try:
        value = float(headers.get('Retry-After'))
    except (TypeError, ValueError):
        return None
    return min(max(value, 0.0), RETRY_AFTER_CAP)


def _json(resp):
    try:
        return resp.json()
    except ValueError as e:
        raise AzureError('invalid JSON from Azure DevOps', status=getattr(resp, 'status_code', None)) from e


def normalize_workers(raw, default=DEFAULT_DETAIL_WORKERS):
    """Maps a configured worker count to an int in [1, MAX_DETAIL_WORKERS]. Never raises.

    None / empty -> default. A value that is not a whole number (text, float with a fraction, bool), zero or negative
    -> 1 (sequential, the safe choice) with a warning. Above MAX_DETAIL_WORKERS -> MAX_DETAIL_WORKERS with a warning.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default
    value = None
    if isinstance(raw, int) and not isinstance(raw, bool):
        value = raw
    elif isinstance(raw, float) and raw.is_integer():
        value = int(raw)
    elif isinstance(raw, str):
        try:
            value = int(raw.strip())
        except ValueError:
            value = None
    if value is None or value < 1:
        logger.warning('Invalid detail worker count %r; using 1 (sequential).', raw)
        return 1
    if value > MAX_DETAIL_WORKERS:
        logger.warning('Detail worker count %r exceeds the maximum; using %d.', raw, MAX_DETAIL_WORKERS)
        return MAX_DETAIL_WORKERS
    return value


class _Limiter:
    """Concurrency cap that can only shrink while a fan-out runs (halved on a throttling answer: HTTP 429 or any
    response that carries Retry-After)."""

    def __init__(self, limit):
        self.limit, self.active = max(1, limit), 0
        self.last_shrink = 0.0
        self._cond = threading.Condition()

    def acquire(self):
        with self._cond:
            while self.active >= self.limit:
                self._cond.wait()
            self.active += 1

    def release(self):
        with self._cond:
            self.active -= 1
            self._cond.notify_all()

    def shrink(self, request_started):
        """Halves the cap, but only for a request that started after the previous shrink: the other requests that
        were already in flight when the limit was hit report the same overload and must not shrink it again."""
        with self._cond:
            if request_started > self.last_shrink:
                self.limit = max(1, self.limit // 2)
                self.last_shrink = time.monotonic()


class AzureClient:
    def __init__(self, org_url, pat, sleep=time.sleep, max_retries=3, timeout=30, workers=None):
        self._org = org_url.rstrip('/')
        token = base64.b64encode(f':{pat}'.encode('utf-8')).decode('ascii')
        self._headers = {'Authorization': f'Basic {token}', 'Accept': 'application/json'}
        self._sleep = sleep
        self._max_retries = max_retries
        self._timeout = timeout
        self.stats = {'requests': 0, 'retries': 0, 'wiql_calls': 0, 'batches': 0, 'throttled': 0}
        self._workers = normalize_workers(os.environ.get('SYNC_DETAIL_WORKERS') if workers is None else workers)
        # Shared state of a parallel fan-out. _stats_lock guards `stats` and `_gate_until`; `_limiter` is only set
        # while a fan-out runs and is owned by it (`_fanout_lock`: a second concurrent get_items runs sequentially).
        self._stats_lock = threading.Lock()
        self._fanout_lock = threading.Lock()
        self._gate_until = 0.0     # monotonic time before which no worker issues a request (Retry-After honoured fleet-wide)
        self._limiter = None

    def _bump(self, key):
        with self._stats_lock:
            self.stats[key] += 1

    def _wait_gate(self):
        while self._limiter is not None:
            with self._stats_lock:
                remaining = self._gate_until - time.monotonic()
            if remaining <= 0:
                return
            self._sleep(remaining)

    def _send(self, method, url, kw):
        """One HTTP attempt. During a parallel fan-out it holds a concurrency slot for the attempt only, never while
        backing off: a retry queues behind the (possibly just shrunk) cap like any other request instead of keeping
        the slot it got before the 429."""
        limiter = self._limiter
        if limiter is not None:
            limiter.acquire()
        try:
            if method == 'GET':
                return requests.get(url, headers=self._headers, timeout=self._timeout)
            return requests.post(url, headers=self._headers, json=kw.get('json'), timeout=self._timeout)
        finally:
            if limiter is not None:
                limiter.release()

    def _request(self, method, url, **kw):
        if method == 'GET':
            if kw:
                raise ValueError('GET takes no body')
        elif method == 'POST':
            if not url.split('?', 1)[0].endswith(WIQL_PATH) or set(kw) != {'json'}:
                raise ValueError('only the WIQL query POST is permitted')
        else:
            raise ValueError(f'HTTP method not permitted: {method}')

        attempt = 0
        while True:
            self._wait_gate()
            self._bump('requests')
            started = time.monotonic()
            retry_after = None
            try:
                resp = self._send(method, url, kw)
            except (requests.ConnectionError, requests.Timeout):
                failure = AzureError('network error contacting Azure DevOps', retryable=True)
            else:
                status = resp.status_code
                if 200 <= status < 300:
                    return resp
                body = _body_text(resp)
                if status in RETRY_STATUSES:
                    failure = AzureError(f'HTTP {status} from Azure DevOps: {body[:200]}', status=status, retryable=True)
                    retry_after = _parse_retry_after(resp)
                else:
                    error = AzureError(f'HTTP {status} from Azure DevOps: {body[:200]}', status=status)
                    if status == 400 and any(marker in body for marker in SIZE_LIMIT_MARKERS):
                        error.size_limit = True
                    raise error

            if attempt >= self._max_retries:
                raise failure
            delay = retry_after if retry_after is not None else float(2 ** attempt)
            limiter = self._limiter
            if limiter is not None and (failure.status == 429 or retry_after is not None):
                # Parallel fan-out, throttling answer: pause every worker for the advertised time and halve the
                # concurrency for the rest of this fan-out, so the retry does not meet the same limit again. Other
                # transient failures (5xx, network) only back off the request that met them: pausing the whole fleet
                # for each of them would serialise the retries of an outage.
                with self._stats_lock:
                    self._gate_until = max(self._gate_until, time.monotonic() + delay)
                    self.stats['throttled'] += 1
                limiter.shrink(started)
            self._sleep(delay)
            self._bump('retries')
            attempt += 1

    def wiql_ids(self, where, order_by='[System.Id]', top=None):
        query = f'SELECT [System.Id] FROM WorkItems WHERE {where} ORDER BY {order_by}'
        url = f'{self._org}/_apis/wit/wiql?api-version={API_VERSION}'
        if top is not None:
            url += f'&$top={int(top)}'
        self.stats['wiql_calls'] += 1
        data = _json(self._request('POST', url, json={'query': query}))
        return [int(w['id']) for w in (data.get('workItems') or [])]

    def collect_ids(self, where):
        start = self.stats['wiql_calls']
        try:
            ids = self.wiql_ids(where)
        except AzureError as e:
            if not e.size_limit:
                raise
            ids = None
        if ids is not None and len(ids) < WIQL_RESULT_LIMIT:
            return CollectResult(ids, 1, False, self.stats['wiql_calls'] - start)

        first = self.wiql_ids(where, order_by='[System.Id] ASC', top=1)
        last = self.wiql_ids(where, order_by='[System.Id] DESC', top=1)
        if not first or not last:
            return CollectResult([], 1, False, self.stats['wiql_calls'] - start,
                                 ['no id bounds found; result treated as empty'])

        found, leaves = self._fetch_range(where, first[0], last[0] + 1)
        return CollectResult(sorted(set(found)), leaves, True, self.stats['wiql_calls'] - start,
                             [f'partitioned by [System.Id] into {leaves} ranges'])

    def _fetch_range(self, where, lo, hi):
        clause = f'({where}) AND [System.Id] >= {lo} AND [System.Id] < {hi}'
        try:
            ids = self.wiql_ids(clause)
        except AzureError as e:
            if not e.size_limit:
                raise
            ids = None
        if ids is not None and len(ids) < WIQL_RESULT_LIMIT:
            return ids, 1
        if hi - lo <= 1:
            raise AzureError('WIQL range still exceeds the result limit', status=400)
        mid = (lo + hi) // 2
        left, left_leaves = self._fetch_range(where, lo, mid)
        right, right_leaves = self._fetch_range(where, mid, hi)
        return left + right, left_leaves + right_leaves

    def get_items(self, ids, expand_relations=True, fields=None, error_policy_omit=False, raise_on_error=False):
        requested = list(dict.fromkeys(int(i) for i in ids))
        result = FetchResult()
        batches = [requested[s:s + BATCH_SIZE] for s in range(0, len(requested), BATCH_SIZE)]
        if self._workers > 1 and len(batches) > 1 and not raise_on_error:
            outcomes = self._fetch_parallel(batches, expand_relations, fields, error_policy_omit)
        else:
            outcomes = (self._fetch_one(b, expand_relations, fields, error_policy_omit, raise_on_error) for b in batches)
        # Outcomes are consumed in batch order, so items / missing / errors are ordered exactly as in a sequential run.
        for batch, (data, error) in zip(batches, outcomes):
            result.batches += 1
            if error is not None:
                result.failed_batches.append(batch)
                result.errors.append(f'batch {result.batches}: {error}')
                continue
            returned = set()
            for item in (data.get('value') or []):
                if item is None:
                    continue
                item_id = int(item['id'])
                result.items[item_id] = item
                returned.add(item_id)
            result.missing.extend(i for i in batch if i not in returned)
        return result

    def iter_batches(self, ids, expand_relations=True, fields=None, error_policy_omit=False):
        """Streams the detail batches of ``ids`` one ``FetchResult`` per batch (<= BATCH_SIZE ids), in request order.

        Same requests, retries, Retry-After handling and concurrency limiter as ``get_items``, but the caller never
        holds more than a bounded window of responses: at most ``2 * workers`` batches are in flight or waiting to be
        consumed, whatever the number of ids. A failed batch is reported in the result (``failed_batches`` /
        ``errors``) exactly as ``get_items`` reports it; an unexpected error propagates and cancels queued batches.
        Close the generator (or exhaust it) so that the worker pool and the fan-out lock are released.
        """
        requested = list(dict.fromkeys(int(i) for i in ids))
        total = (len(requested) + BATCH_SIZE - 1) // BATCH_SIZE
        stream = None
        if self._workers > 1 and total > 1 and self._fanout_lock.acquire(blocking=False):
            stream = self._stream_parallel(requested, total, expand_relations, fields, error_policy_omit)
        else:
            stream = self._stream_sequential(requested, total, expand_relations, fields, error_policy_omit)
        try:
            for number, (batch, (data, error)) in enumerate(stream, 1):
                yield self._batch_result(batch, number, data, error)
        finally:
            stream.close()

    @staticmethod
    def _batch_result(batch, number, data, error):
        result = FetchResult(batches=1)
        if error is not None:
            result.failed_batches.append(batch)
            result.errors.append(f'batch {number}: {error}')
            return result
        returned = set()
        for item in (data.get('value') or []):
            if item is None:
                continue
            item_id = int(item['id'])
            result.items[item_id] = item
            returned.add(item_id)
        result.missing.extend(i for i in batch if i not in returned)
        return result

    def _stream_sequential(self, requested, total, expand_relations, fields, error_policy_omit):
        for k in range(total):
            batch = requested[k * BATCH_SIZE:(k + 1) * BATCH_SIZE]
            yield batch, self._fetch_one(batch, expand_relations, fields, error_policy_omit, False)

    def _stream_parallel(self, requested, total, expand_relations, fields, error_policy_omit):
        # the caller acquired _fanout_lock; it is released here
        limiter = _Limiter(self._workers)
        with self._stats_lock:
            self._gate_until = 0.0
        self._limiter = limiter
        pool = ThreadPoolExecutor(max_workers=min(self._workers, total), thread_name_prefix='azure-detail')
        window = 2 * self._workers
        pending, nxt = deque(), 0
        try:
            while nxt < total or pending:
                while nxt < total and len(pending) < window:
                    batch = requested[nxt * BATCH_SIZE:(nxt + 1) * BATCH_SIZE]
                    pending.append((batch, pool.submit(self._fetch_one, batch, expand_relations, fields,
                                                       error_policy_omit, False)))
                    nxt += 1
                batch, future = pending.popleft()
                yield batch, future.result()  # batch order, whatever order the workers finished in
        except BaseException:
            pool.shutdown(wait=True, cancel_futures=True)
            raise
        finally:
            pool.shutdown(wait=True)
            self._limiter = None
            self._fanout_lock.release()

    def _fetch_one(self, batch, expand_relations, fields, error_policy_omit, raise_on_error):
        self._bump('batches')
        url = self._items_url(batch, expand_relations, fields, error_policy_omit)
        try:
            return _json(self._request('GET', url)), None
        except AzureError as e:
            if raise_on_error:
                raise
            return None, e

    def _fetch_parallel(self, batches, expand_relations, fields, error_policy_omit):
        if not self._fanout_lock.acquire(blocking=False):
            # another thread is already fanning out on this client: stay sequential rather than share its limiter
            return [self._fetch_one(b, expand_relations, fields, error_policy_omit, False) for b in batches]
        limiter = _Limiter(self._workers)
        with self._stats_lock:
            self._gate_until = 0.0
        self._limiter = limiter

        def task(batch):
            return self._fetch_one(batch, expand_relations, fields, error_policy_omit, False)

        pool = ThreadPoolExecutor(max_workers=min(self._workers, len(batches)), thread_name_prefix='azure-detail')
        try:
            futures = [pool.submit(task, b) for b in batches]
            return [f.result() for f in futures]  # batch order, whatever order the workers finished in
        except BaseException:
            # an unexpected error (not an AzureError, which is returned per batch): do not start the batches still queued
            pool.shutdown(wait=True, cancel_futures=True)
            raise
        finally:
            pool.shutdown(wait=True)
            self._limiter = None
            self._fanout_lock.release()

    def _items_url(self, batch, expand_relations, fields, error_policy_omit):
        parts = [f'ids={",".join(str(i) for i in batch)}']
        if expand_relations:
            parts.append('$expand=relations')
        elif fields:
            parts.append('fields=' + ','.join(fields))
        if error_policy_omit:
            parts.append('errorPolicy=omit')
        parts.append(f'api-version={API_VERSION}')
        return f'{self._org}/_apis/wit/workitems?' + '&'.join(parts)
