"""Read-only Azure DevOps REST client used by the sync engine.

Only HTTP GET and the WIQL query POST (``/_apis/wit/wiql``) are issued.
"""

import base64
import time
from dataclasses import dataclass, field

import requests

WIQL_RESULT_LIMIT = 20000
BATCH_SIZE = 200
API_VERSION = '7.1'
RETRY_STATUSES = (429, 502, 503, 504)
RETRY_AFTER_CAP = 30
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


class AzureClient:
    def __init__(self, org_url, pat, sleep=time.sleep, max_retries=3, timeout=30):
        self._org = org_url.rstrip('/')
        token = base64.b64encode(f':{pat}'.encode('utf-8')).decode('ascii')
        self._headers = {'Authorization': f'Basic {token}', 'Accept': 'application/json'}
        self._sleep = sleep
        self._max_retries = max_retries
        self._timeout = timeout
        self.stats = {'requests': 0, 'retries': 0, 'wiql_calls': 0, 'batches': 0}

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
            self.stats['requests'] += 1
            retry_after = None
            try:
                if method == 'GET':
                    resp = requests.get(url, headers=self._headers, timeout=self._timeout)
                else:
                    resp = requests.post(url, headers=self._headers, json=kw.get('json'), timeout=self._timeout)
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
            self._sleep(delay)
            self.stats['retries'] += 1
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
        for start in range(0, len(requested), BATCH_SIZE):
            batch = requested[start:start + BATCH_SIZE]
            result.batches += 1
            self.stats['batches'] += 1
            url = self._items_url(batch, expand_relations, fields, error_policy_omit)
            try:
                data = _json(self._request('GET', url))
            except AzureError as e:
                if raise_on_error:
                    raise
                result.failed_batches.append(batch)
                result.errors.append(f'batch {result.batches}: {e}')
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
