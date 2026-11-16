"""Shared keep-alive HTTP session for the dashboard services' read-only Azure DevOps requests.

``requests.get`` opens a new TCP+TLS connection for every call. The pipeline, deployment and
team-activity services issue dozens of small GETs per refresh, so connection setup dominated
their latency. One pooled session reuses connections across calls and worker threads.

Only ``GET`` is exposed on purpose: the Azure DevOps integration is strictly read-only.
Cookies are never stored, so no state is shared between requests besides the connection pool.
Retries stay disabled (``max_retries=0``), which keeps ``requests`` exception types such as
``requests.Timeout`` and ``requests.ConnectionError`` identical to a plain ``requests.get``.
"""

import http.cookiejar

import requests
from requests.adapters import HTTPAdapter

POOL_CONNECTIONS = 8   # distinct hosts kept pooled (dev.azure.com, vsrm.dev.azure.com, ...)
POOL_MAXSIZE = 32      # concurrent connections per host; callers use up to 10 workers per fan-out


def _build_session():
    session = requests.Session()
    session.cookies.set_policy(http.cookiejar.DefaultCookiePolicy(allowed_domains=[]))
    adapter = HTTPAdapter(pool_connections=POOL_CONNECTIONS, pool_maxsize=POOL_MAXSIZE, max_retries=0)
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    return session


_session = _build_session()


def get(url, **kwargs):
    """GET through the shared pooled session (same arguments and exceptions as ``requests.get``)."""
    return _session.get(url, **kwargs)
