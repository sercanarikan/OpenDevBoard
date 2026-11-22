"""Runtime path, connection configuration, and writer lock for the work-item cache."""
import os
import sqlite3
from threading import RLock


DATA_DIR = os.environ.get('DEVOPS_DATA_DIR') or os.path.dirname(__file__)
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, 'devops_cache.db')
db_lock = RLock()


def get_db_connection(path=None):
    """Open a configured cache connection; transaction and close ownership remain with the caller."""
    conn = sqlite3.connect(path or DB_PATH, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.execute('PRAGMA busy_timeout=5000;')
    return conn
