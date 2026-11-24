"""Low-cardinality, best-effort Prometheus instrumentation for the sync process."""

import os
import threading
import time
from contextlib import contextmanager

try:
    import resource
except ImportError:  # pragma: no cover - available on the Linux backend runtime
    resource = None

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest


REGISTRY = CollectorRegistry()
SYNC_RUNS = Counter('opendevboard_sync_runs_total', 'Sync runs by mode and outcome.', ('mode', 'status'), registry=REGISTRY)
SYNC_DURATION = Histogram('opendevboard_sync_duration_seconds', 'End-to-end work-item sync duration.', ('mode',), registry=REGISTRY)
PHASE_DURATION = Histogram('opendevboard_sync_phase_duration_seconds', 'Sync phase duration.', ('phase',), registry=REGISTRY)
PR_STAGE_DURATION = Histogram(
    'opendevboard_pr_stage_duration_seconds',
    'Dashboard pull request stage duration by fixed stage and outcome.',
    ('stage', 'result'),
    registry=REGISTRY,
)
PR_UPSTREAM_RESULTS = Counter(
    'opendevboard_pr_upstream_requests_total',
    'Azure DevOps PR and identity GET outcomes by fixed request stage and result.',
    ('stage', 'result'),
    registry=REGISTRY,
)
HTTP_ATTEMPTS = Counter('opendevboard_http_attempts_total', 'Actual Azure DevOps HTTP network attempts.', ('method',), registry=REGISTRY)
HTTP_RETRIES = Counter('opendevboard_http_retries_total', 'Azure DevOps HTTP retries.', registry=REGISTRY)
HTTP_RESULTS = Counter('opendevboard_http_results_total', 'Azure DevOps HTTP results and transport errors.', ('result',), registry=REGISTRY)
WIQL_CALLS = Counter('opendevboard_wiql_calls_total', 'WIQL calls.', registry=REGISTRY)
ITEMS = Counter('opendevboard_work_items_processed_total', 'Work items handled by sync.', ('kind',), registry=REGISTRY)
CONTEXT_ITEMS = Counter('opendevboard_context_items_processed_total', 'Context items handled by sync.', registry=REGISTRY)
LAST_SUCCESS = Gauge('opendevboard_last_successful_sync_timestamp_seconds', 'Unix time of last successful sync.', registry=REGISTRY)
PARTIAL = Gauge('opendevboard_sync_partial', 'Whether the last sync was partial (1/0).', registry=REGISTRY)
CLOSURE_DIRTY = Gauge('opendevboard_closure_dirty', 'Whether the cached context closure needs healing (1/0).', registry=REGISTRY)
SCHEDULER_BACKOFF = Gauge('opendevboard_scheduler_backoff_seconds', 'Current initial-full scheduler backoff.', registry=REGISTRY)
PROCESS_RSS = Gauge('opendevboard_process_rss_bytes', 'Current process resident memory.', registry=REGISTRY)
PROCESS_PEAK_RSS = Gauge('opendevboard_process_peak_rss_bytes', 'Process lifetime peak resident memory.', registry=REGISTRY)
SYNC_PEAK_RSS = Gauge('opendevboard_sync_peak_rss_bytes', 'Peak resident memory sampled during the latest sync.', registry=REGISTRY)
PROCESS_CPU = Counter('opendevboard_process_cpu_seconds_total', 'Process CPU time.', registry=REGISTRY)
SYNC_CPU = Histogram('opendevboard_sync_cpu_seconds', 'Process CPU time used by a sync run.', registry=REGISTRY)
_cpu_lock = threading.Lock()
_last_process_cpu = 0.0


def enabled():
    return os.environ.get('OBSERVABILITY_METRICS_ENABLED', '1').strip().lower() not in ('0', 'false', 'no', 'off')


def best_effort(fn, *args, **kwargs):
    try:
        if enabled():
            return fn(*args, **kwargs)
    except Exception:
        return None
    return None


def observe_phase(phase, started):
    best_effort(lambda: PHASE_DURATION.labels(phase=phase).observe(max(0.0, time.monotonic() - started)))


def observe_pr_stage(stage, started, result='ok'):
    best_effort(lambda: PR_STAGE_DURATION.labels(stage=stage, result=result).observe(
        max(0.0, time.monotonic() - started)
    ))


def observe_pr_upstream(stage, result):
    best_effort(lambda: PR_UPSTREAM_RESULTS.labels(stage=stage, result=result).inc())


@contextmanager
def phase(phase_name):
    started = time.monotonic()
    try:
        yield
    finally:
        observe_phase(phase_name, started)


def observe_http_attempt(method):
    best_effort(lambda: HTTP_ATTEMPTS.labels(method=method).inc())


def observe_http_result(result):
    best_effort(lambda: HTTP_RESULTS.labels(result=result).inc())


def observe_retry():
    best_effort(HTTP_RETRIES.inc)


def observe_wiql():
    best_effort(WIQL_CALLS.inc)


def set_sync_state(last_success=None, partial=None, closure_dirty=None):
    if last_success:
        try:
            from datetime import datetime, timezone
            parsed = datetime.fromisoformat(last_success.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            stamp = parsed.timestamp()
            best_effort(LAST_SUCCESS.set, stamp)
        except Exception:
            pass
    if partial is not None:
        best_effort(PARTIAL.set, int(bool(partial)))
    if closure_dirty is not None:
        best_effort(CLOSURE_DIRTY.set, int(bool(closure_dirty)))


def set_scheduler_backoff(seconds):
    best_effort(SCHEDULER_BACKOFF.set, max(0, seconds or 0))


def _update_process_cpu():
    global _last_process_cpu
    current = time.process_time()
    with _cpu_lock:
        delta = max(0.0, current - _last_process_cpu)
        _last_process_cpu = current
    if delta:
        best_effort(PROCESS_CPU.inc, delta)


def _rss_bytes():
    try:
        with open('/proc/self/statm', encoding='ascii') as statm:
            resident_pages = int(statm.read().split()[1])
        return resident_pages * os.sysconf('SC_PAGE_SIZE')
    except Exception:
        # Don't substitute process-lifetime peak for current/per-sync RSS: that would conflate two signals.
        return 0


def _lifetime_peak_rss_bytes():
    if resource is None:
        return 0
    try:
        # The supported backend runtime is Linux, where ru_maxrss is reported in KiB.
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024)
    except Exception:
        return 0


@contextmanager
def track_sync(mode):
    """Sample per-run RSS separately from the lifetime peak; metrics must never escape into sync logic."""
    state = {'record_sync': True}
    try:
        active = enabled()
    except Exception:
        active = False
    if not active:
        yield state
        return
    try:
        stop = threading.Event()
        peak = [_rss_bytes() or 0]
        started = time.monotonic()
        cpu_started = time.process_time()
    except Exception:
        # If metric setup cannot allocate its sampler state, run the sync without instrumentation.
        yield state
        return

    def sample():
        while not stop.wait(0.2):
            try:
                peak[0] = max(peak[0], _rss_bytes())
            except Exception:
                pass

    sampler = None
    try:
        sampler = threading.Thread(target=sample, name='metrics-rss-sampler', daemon=True)
        sampler.start()
    except Exception:
        sampler = None
    try:
        yield state
    finally:
        try:
            stop.set()
        except Exception:
            pass
        if sampler:
            try:
                sampler.join(timeout=0.3)
            except Exception:
                pass
        elapsed = max(0.0, time.monotonic() - started)
        cpu = max(0.0, time.process_time() - cpu_started)
        try:
            current = _rss_bytes() or 0
            best_effort(PROCESS_RSS.set, current)
            best_effort(PROCESS_PEAK_RSS.set, _lifetime_peak_rss_bytes())
            _update_process_cpu()
            if state.get('record_sync', True):
                peak[0] = max(peak[0], current)
                best_effort(SYNC_PEAK_RSS.set, peak[0])
                best_effort(SYNC_CPU.observe, cpu)
                best_effort(lambda: SYNC_DURATION.labels(mode=mode).observe(elapsed))
        except Exception:
            pass


def render_metrics():
    """Return the registry payload; caller handles any scrape-side failure."""
    try:
        current = _rss_bytes()
        best_effort(PROCESS_RSS.set, current)
        best_effort(PROCESS_PEAK_RSS.set, _lifetime_peak_rss_bytes())
        _update_process_cpu()
    except Exception:
        pass
    return generate_latest(REGISTRY)
