"""Share one in-flight computation between concurrent callers that ask for the same thing.

The dashboard cards, their explorers and several browser tabs can request the same cold summary at once.
Each caller used to repeat the complete Azure DevOps fan-out (3 concurrent requests -> 3x the calls, and a
higher chance of HTTP 429). With coalescing the first caller (the leader) does the work and the others
wait for, and share, its result or its exception. Nothing is cached after the flight ends.
"""

import threading


class _Flight:
    __slots__ = ('event', 'result', 'error')

    def __init__(self):
        self.event = threading.Event()
        self.result = None
        self.error = None


class Coalescer:
    def __init__(self):
        self._lock = threading.Lock()
        self._flights = {}

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
            try:
                flight.result = compute()
            except BaseException as error:  # shared with the followers, then re-raised for the leader too
                flight.error = error
            finally:
                with self._lock:
                    del self._flights[key]
                flight.event.set()
        else:
            flight.event.wait()
        if flight.error is not None:
            raise flight.error
        return flight.result
