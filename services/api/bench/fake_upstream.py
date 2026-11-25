"""A fake Azure DevOps upstream with synthetic data. It never touches the network.

Only the read-only calls the activity chunk fetchers make are modelled:

* ``get`` answers ``GET _apis/projects`` and ``GET <project>/_apis/build/builds`` (the ``azure_http.get`` shape).
* ``wiql_post`` / ``items_get`` answer the WIQL query POST and the work item detail GET (the ``requests`` shape used by
  ``AzureClient``).

Behaviour is configurable: ``latency`` seconds per call, ``mode`` (``ok``, ``429``, ``5xx``, ``timeout``) applied to the
data calls (not to project discovery), ``retry_after`` for 429, ``fail_first`` to fail only the first N data calls, and
``runs_per_month`` synthetic pipeline runs per project and UTC month. Everything it returns is generated; the names are
``Synthetic-Project-N`` and no real identifier is involved.
"""

from __future__ import annotations

import calendar
import threading
import time
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Sequence

import requests

MODES = ("ok", "429", "5xx", "timeout")


class FakeResponse:
    def __init__(self, status_code=200, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.headers = headers or {}
        self.text = "" if status_code == 200 else "synthetic upstream failure"

    def json(self):
        return self._payload


def default_projects(count: int = 5) -> List[str]:
    return [f"Synthetic-Project-{i + 1}" for i in range(count)]


class FakeUpstream:
    def __init__(self, projects: Sequence[str], runs_per_month: int = 20, today: Optional[date] = None,
                 latency: float = 0.0, mode: str = "ok", retry_after: Optional[float] = None,
                 fail_first: Optional[int] = None, sleep=time.sleep):
        if mode not in MODES:
            raise ValueError(f"unknown mode: {mode}")
        self.projects = list(projects)
        self.runs_per_month = runs_per_month
        self.today = today or datetime.utcnow().date()
        self.latency = latency
        self.mode = mode
        self.retry_after = retry_after
        self.fail_first = fail_first
        self._sleep = sleep
        self._lock = threading.Lock()
        self._data_calls = 0
        self._month_cache: Dict[tuple, List[dict]] = {}
        self._items_by_id: Dict[int, dict] = {}
        self.counters: Counter = Counter()
        self.builds_by_month: Counter = Counter()

    # -- bookkeeping -------------------------------------------------------

    def _count(self, *keys):
        with self._lock:
            for key in keys:
                self.counters[key] += 1

    def reset_counters(self):
        with self._lock:
            self.counters.clear()
            self.builds_by_month.clear()
            self._data_calls = 0

    def _failure(self, month_key: Optional[str] = None):
        """Return a failing FakeResponse (or raise) when this data call must fail, else None."""
        with self._lock:
            self._data_calls += 1
            failing = self.mode != "ok" and (self.fail_first is None or self._data_calls <= self.fail_first)
        if not failing:
            return None
        if self.mode == "timeout":
            self._count("timeouts")
            raise requests.Timeout("synthetic timeout")
        if self.mode == "429":
            self._count("status_429")
            headers = {} if self.retry_after is None else {"Retry-After": str(int(self.retry_after))
                                                              if float(self.retry_after).is_integer()
                                                              else str(self.retry_after)}
            return FakeResponse(429, headers=headers)
        self._count("status_5xx")
        return FakeResponse(503)

    # -- synthetic data ----------------------------------------------------

    def _month_runs(self, project_index: int, year: int, month: int) -> List[dict]:
        key = (project_index, year, month)
        with self._lock:
            cached = self._month_cache.get(key)
        if cached is not None:
            return cached
        days = calendar.monthrange(year, month)[1]
        last_day = days if (year, month) != (self.today.year, self.today.month) else self.today.day
        name = self.projects[project_index]
        runs = []
        for k in range(self.runs_per_month):
            day = 1 + (k * last_day) // max(1, self.runs_per_month)
            queue = datetime(year, month, min(day, last_day), 8 + (k % 10), (k * 7) % 60, 0)
            finish = queue + timedelta(minutes=5)
            runs.append({
                "id": project_index * 10_000_000 + (year * 12 + month) * 1000 + k,
                "buildNumber": f"{year}{month:02d}.{k}",
                "status": "completed",
                "result": "succeeded" if k % 5 else "failed",
                "project": {"name": name},
                "definition": {"id": 100 + project_index, "name": f"synthetic-pipeline-{k % 4}", "type": "yaml"},
                "queueTime": queue.isoformat() + "Z",
                "startTime": (queue + timedelta(minutes=1)).isoformat() + "Z",
                "finishTime": finish.isoformat() + "Z",
                "sourceBranch": "refs/heads/main",
                "sourceVersion": "0" * 40,
                "requestedFor": {"displayName": "Synthetic User"},
            })
        with self._lock:
            self._month_cache[key] = runs
        return runs

    def _runs_between(self, project_index: int, low: str, high: str) -> List[dict]:
        start, end = datetime.fromisoformat(low.rstrip("Z")), datetime.fromisoformat(high.rstrip("Z"))
        out: List[dict] = []
        year, month = start.year, start.month
        while (year, month) <= (end.year, end.month):
            out.extend(r for r in self._month_runs(project_index, year, month)
                       if low <= r["finishTime"] < high)
            year, month = (year + 1, 1) if month == 12 else (year, month + 1)
        out.sort(key=lambda r: r["finishTime"], reverse=True)
        return out

    # -- azure_http.get shape ---------------------------------------------

    def get(self, url, headers=None, params=None, timeout=None, **_ignored):
        params = params or {}
        if self.latency:
            self._sleep(self.latency)
        self._count("requests")
        if url.rstrip("/").endswith("/_apis/projects"):
            self._count("projects")
            return FakeResponse(200, {"value": [{"name": p} for p in self.projects]})
        if "/_apis/build/builds" in url:
            self._count("builds")
            failure = self._failure()
            if failure is not None:
                return failure
            project = url.split("/_apis/build/builds")[0].rsplit("/", 1)[-1]
            from urllib.parse import unquote
            project = unquote(project)
            if project not in self.projects:
                return FakeResponse(404)
            low, high = params.get("minTime"), params.get("maxTime")
            rows = self._runs_between(self.projects.index(project), low, high)
            top = int(params.get("$top") or 250)
            offset = int(params.get("continuationToken") or 0)
            page = rows[offset:offset + top]
            with self._lock:
                self.builds_by_month[low[:7]] += len(page)
            headers_out = {}
            if offset + top < len(rows):
                headers_out["x-ms-continuationtoken"] = str(offset + top)
            return FakeResponse(200, {"value": page}, headers_out)
        return FakeResponse(404)

    # -- requests.post / requests.get shape (AzureClient) ------------------

    def _month_items(self, project_index: int, year: int, month: int) -> List[dict]:
        """Synthetic closed work items of one project and UTC month (``runs_per_month`` of them)."""
        key = ("wi", project_index, year, month)
        with self._lock:
            cached = self._month_cache.get(key)
        if cached is not None:
            return cached
        days = calendar.monthrange(year, month)[1]
        last_day = days if (year, month) != (self.today.year, self.today.month) else self.today.day
        items = []
        for k in range(self.runs_per_month):
            day = 1 + (k * last_day) // max(1, self.runs_per_month)
            closed = datetime(year, month, min(day, last_day), 8 + (k % 10), (k * 7) % 60, 0)
            stamp = closed.isoformat() + "Z"
            item_id = project_index * 10_000_000 + (year * 12 + month) * 1000 + k + 1
            items.append({"id": item_id, "url": f"https://dev.example.invalid/org/_apis/wit/workItems/{item_id}",
                          "fields": {"System.TeamProject": self.projects[project_index], "System.WorkItemType": "Task",
                                     "System.State": "Done", "System.Title": f"Synthetic item {item_id}",
                                     "System.CreatedDate": (closed - timedelta(days=3)).isoformat() + "Z",
                                     "Microsoft.VSTS.Common.ClosedDate": stamp, "System.ChangedDate": stamp}})
        with self._lock:
            self._month_cache[key] = items
            for item in items:
                self._items_by_id[item["id"]] = item
        return items

    def wiql_post(self, url, headers=None, json=None, timeout=None, **_ignored):
        if self.latency:
            self._sleep(self.latency)
        self._count("requests", "wiql")
        failure = self._failure()
        if failure is not None:
            return failure
        import re
        text = (json or {}).get("query", "")
        low = re.search(r">= '([^']+)'", text)
        high = re.search(r"< '([^']+)'", text)
        if not (low and high):
            return FakeResponse(400)
        low, high = low.group(1), high.group(1)
        start, end = datetime.fromisoformat(low.rstrip("Z")), datetime.fromisoformat(high.rstrip("Z"))
        ids = []
        year, month = start.year, start.month
        while (year, month) <= (end.year, end.month):
            for index in range(len(self.projects)):
                ids.extend(i["id"] for i in self._month_items(index, year, month)
                           if low <= i["fields"]["Microsoft.VSTS.Common.ClosedDate"] < high)
            year, month = (year + 1, 1) if month == 12 else (year, month + 1)
        return FakeResponse(200, {"workItems": [{"id": i} for i in sorted(ids)]})

    def items_get(self, url, headers=None, timeout=None, **_ignored):
        if self.latency:
            self._sleep(self.latency)
        self._count("requests", "items")
        ids = [int(x) for x in url.split("ids=")[1].split("&")[0].split(",")]
        with self._lock:
            value = [self._items_by_id[i] for i in ids if i in self._items_by_id]
        return FakeResponse(200, {"value": value})
