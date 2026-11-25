"""Split a calendar query window into UTC month fetch chunks.

A chunk is one whole UTC calendar month, clipped only at the upper end to
"tomorrow" (UTC) so the future is never fetched. Chunks are keyed by the month's
first day, never by the query window. That keeps coverage stable: a query for
10 February and a query for the whole of February address the same ledger row.

The query window decides which months are needed; it does not decide what is
stored as covered.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import List, Optional

from date_window import CALENDAR, DateWindow, utc_now

# A 1096-day window touches at most 37 calendar months (start on a month end,
# span exactly 1096 days), so the limit is derived from the query limit.
MAX_CHUNKS = 37


def _next_month_start(moment: datetime) -> datetime:
    year, month = (moment.year + 1, 1) if moment.month == 12 else (moment.year, moment.month + 1)
    return datetime(year, month, 1)


def plan_month_chunks(window: DateWindow, now: Optional[datetime] = None) -> List[DateWindow]:
    if not window.is_calendar:
        raise ValueError("only calendar windows can be split into fetch chunks")
    tomorrow = datetime.combine((now or utc_now()).date() + timedelta(days=1), datetime.min.time())
    chunks: List[DateWindow] = []
    month_start = datetime(window.start.year, window.start.month, 1)
    while month_start < window.end:
        next_start = _next_month_start(month_start)
        chunk_end = min(next_start, tomorrow)
        if chunk_end <= month_start:
            # Future months carry no data yet; the query can still ask for them.
            chunk_end = month_start + timedelta(days=1)
        chunks.append(
            DateWindow(start=month_start, end=chunk_end, kind=CALENDAR, days=(chunk_end - month_start).days)
        )
        month_start = next_start
    if len(chunks) > MAX_CHUNKS:
        raise ValueError(f"date range needs {len(chunks)} fetch chunks; the limit is {MAX_CHUNKS}")
    return chunks


def chunk_key(chunk: DateWindow) -> str:
    """Stable ledger key for a chunk: the first UTC day of its month."""
    return chunk.start.strftime("%Y-%m-%d")


def chunk_last_day(chunk: DateWindow) -> str:
    """Inclusive last UTC day fetched for this chunk."""
    return (chunk.end - timedelta(days=1)).strftime("%Y-%m-%d")
