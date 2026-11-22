"""Legacy response cache used by the Flask application.

This cache intentionally owns a separate database path, lock, and schema from
the work-item cache. Callers supply the path and lock so ``app`` can retain its
historical patchable configuration surface.
"""
import sqlite3


def initialize(path, lock):
    with lock, sqlite3.connect(path) as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS projects_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cache_key TEXT UNIQUE,
            data TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''')
        conn.commit()


def get(path, lock, cache_key):
    with lock, sqlite3.connect(path) as conn:
        row = conn.execute(
            'SELECT data, updated_at FROM projects_cache WHERE cache_key=?',
            (cache_key,),
        ).fetchone()
        return (row[0], row[1]) if row else (None, None)


def set_value(path, lock, cache_key, data):
    with lock, sqlite3.connect(path) as conn:
        conn.execute('''INSERT INTO projects_cache (cache_key, data, updated_at)
                        VALUES (?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(cache_key) DO UPDATE SET
                        data=excluded.data, updated_at=CURRENT_TIMESTAMP''',
                     (cache_key, data))
        conn.commit()
