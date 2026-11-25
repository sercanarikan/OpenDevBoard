"""Counters and helpers for the synthetic activity benchmark."""

from __future__ import annotations

import math
import threading
from collections import Counter
from typing import Dict, Optional, Sequence

import activity_jobs
from activity_chunks import chunk_key


def percentile(values: Sequence[float], pct: float) -> Optional[float]:
    """Nearest-rank percentile (no interpolation), None for an empty sample."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100.0 * len(ordered)))
    return ordered[rank - 1]


class InstrumentedRunner(activity_jobs.ChunkJobRunner):
    """The real ChunkJobRunner plus counters: submitted, started, coalesced, busy, deferred, cooldown.

    ``coalesced`` counts submissions that joined a fetch already in flight for the same (scope, metric, chunk).
    ``queue_depth_peak`` is the largest number of in-flight fetches seen right after a submission.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.counters: Counter = Counter()
        self.starts_per_chunk: Dict[str, int] = {}
        self.queue_depth_peak = 0
        self._stats_guard = threading.Lock()

    def submit(self, scope, metric, chunk, fetch):
        key = (scope, metric, chunk_key(chunk))
        with self._lock:
            was_running = key in self._running
        outcome = super().submit(scope, metric, chunk, fetch)
        with self._lock:
            depth = len(self._running)
        with self._stats_guard:
            self.counters["submitted"] += 1
            if outcome == activity_jobs.RUNNING:
                if was_running:
                    self.counters["coalesced"] += 1
                else:
                    self.counters["started"] += 1
                    self.starts_per_chunk[key[2]] = self.starts_per_chunk.get(key[2], 0) + 1
            else:
                self.counters[outcome] += 1
            self.queue_depth_peak = max(self.queue_depth_peak, depth)
        return outcome

    def snapshot(self) -> dict:
        with self._stats_guard:
            return {"counters": dict(self.counters), "queueDepthPeak": self.queue_depth_peak,
                    "maxStartsPerChunk": max(self.starts_per_chunk.values(), default=0)}
