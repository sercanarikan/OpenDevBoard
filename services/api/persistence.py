"""Connection configuration and writer lock for the work-item cache."""
import sqlite3
from threading import RLock


db_lock = RLock()


def get_db_connection(path):
    """Open a configured cache connection; transaction and close ownership remain with the caller."""
    conn = sqlite3.connect(path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.execute('PRAGMA busy_timeout=5000;')
    return conn
