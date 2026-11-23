"""Share one in-flight computation between concurrent callers that ask for the same thing.

The dashboard cards, their explorers and several browser tabs can request the same cold summary at once.
Each caller used to repeat the complete Azure DevOps fan-out (3 concurrent requests -> 3x the calls, and a
higher chance of HTTP 429). With coalescing the first caller (the leader) does the work and the others
wait for, and share, its result or its exception. Nothing is cached after the flight ends.
"""

import threading
import time


class _Flight:
    __slots__ = ('event', 'result', 'error', 'worker')

    def __init__(self):
        self.event = threading.Event()
        self.result = None
        self.error = None
        self.worker = None


class Coalescer:
    def __init__(self):
        self._lock = threading.Lock()
        self._flights = {}
        self._workers = set()
        self._closed = False

    def run(self, key, compute):
        """Return ``compute()``; concurrent calls with an equal ``key`` share a single execution.

        Callers must treat the shared result as read-only.
        """
        with self._lock:
            flight = self._flights.get(key)
            leader = flight is None
            if leader:
                flight = self._flights[key] = _Flight()
        if leader:
            self._compute(key, flight, compute)
        else:
            flight.event.wait()
        if flight.error is not None:
            raise flight.error
        return flight.result

    def start(self, key, compute):
        """Start ``compute`` on one daemon worker; return False when the key is active or closed."""
        with self._lock:
            if self._closed or key in self._flights:
                return False
            flight = self._flights[key] = _Flight()
            worker = threading.Thread(target=self._compute, args=(key, flight, compute), daemon=True)
            flight.worker = worker
            self._workers.add(worker)
            try:
                worker.start()
            except BaseException:
                self._workers.discard(worker)
                self._flights.pop(key, None)
                flight.event.set()
                raise
        return True

    def in_flight(self, key):
        with self._lock:
            return key in self._flights

    def shutdown(self, timeout=1.0):
        """Stop accepting background work and join daemon workers for at most ``timeout`` seconds."""
        with self._lock:
            self._closed = True
            workers = list(self._workers)
        deadline = time.monotonic() + max(0.0, timeout)
        for worker in workers:
            worker.join(max(0.0, deadline - time.monotonic()))

    def _compute(self, key, flight, compute):
        try:
            flight.result = compute()
        except BaseException as error:  # shared with blocking followers without logging sensitive exception text
            flight.error = error
        finally:
            with self._lock:
                if self._flights.get(key) is flight:
                    del self._flights[key]
                self._workers.discard(threading.current_thread())
            flight.event.set()
