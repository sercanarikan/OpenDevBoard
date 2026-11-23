"""Shared request date window for analytics endpoints.

Two request shapes are accepted, always interpreted in UTC:

* Rolling: ``days=<n>`` (legacy). Window is ``[now - n days, now)``.
* Calendar: ``startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`` (both inclusive UTC
  calendar days). Window is ``[startDate 00:00, endDate+1 00:00)``.

Calendar ranges are never silently clipped: an unsupported range is rejected
with a ``ValueError`` that the route turns into HTTP 400.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

ROLLING = "rolling"
CALENDAR = "calendar"

# Calendar windows are bounded so that the upstream fetch, cache rows and
# day-bucket charts stay inside the range that the pagination and retention
# behaviour has been verified for. Presets never exceed this span.
MAX_CALENDAR_SPAN_DAYS = 90
MAX_CALENDAR_AGE_DAYS = 89  # start must be within the last 90 UTC days, today included

DATE_FORMAT = "%Y-%m-%d"


def utc_now() -> datetime:
    """Naive UTC 'now', matching the convention used by the analytics services."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass(frozen=True)
class DateWindow:
    start: datetime  # naive UTC, inclusive
    end: datetime  # naive UTC, exclusive
    kind: str  # ROLLING or CALENDAR
    days: int  # rolling day count, or number of calendar days in the range

    @property
    def is_calendar(self) -> bool:
        return self.kind == CALENDAR

    @property
    def key(self) -> Tuple[str, str, str]:
        """Stable identity used for request coalescing and cache isolation."""
        if self.is_calendar:
            return (CALENDAR, self.start.strftime(DATE_FORMAT), self.end.strftime(DATE_FORMAT))
        return (ROLLING, str(self.days), "")

    def iso_start(self) -> str:
        return self.start.isoformat(timespec="seconds") + "Z"

    def iso_end(self) -> str:
        return self.end.isoformat(timespec="seconds") + "Z"

    def contains(self, moment: Optional[datetime]) -> bool:
        if moment is None:
            return False
        return self.start <= moment < self.end

    def to_meta(self) -> Dict[str, Any]:
        """Response metadata. Calendar dates are inclusive UTC days."""
        last_day = (self.end - timedelta(days=1)).date() if self.is_calendar else self.end.date()
        return {
            "kind": self.kind,
            "startDate": self.start.date().strftime(DATE_FORMAT),
            "endDate": last_day.strftime(DATE_FORMAT),
            "days": self.days,
            "timezone": "UTC",
        }

    def day_keys(self, now: Optional[datetime] = None) -> List[Tuple[str, str]]:
        """Return ``(YYYY-MM-DD, 'dd Mon')`` buckets covering the window in order.

        Rolling windows keep the historical ``now - i days`` buckets so existing
        chart output is unchanged. Calendar windows produce one bucket per UTC day.
        """
        if self.is_calendar:
            first = self.start.date()
            count = self.days
            base = [first + timedelta(days=i) for i in range(count)]
        else:
            anchor = now or self.end
            base = [(anchor - timedelta(days=i)).date() for i in range(self.days - 1, -1, -1)]
        return [(d.strftime(DATE_FORMAT), d.strftime("%d %b")) for d in base]


def rolling_window(days: int, now: Optional[datetime] = None) -> DateWindow:
    now = now or utc_now()
    return DateWindow(start=now - timedelta(days=days), end=now, kind=ROLLING, days=days)


def calendar_window(start_date: date, end_date: date, today: Optional[date] = None) -> DateWindow:
    """Build a calendar window, rejecting anything that cannot be served exactly."""
    today = today or utc_now().date()
    if end_date < start_date:
        raise ValueError("endDate must be on or after startDate")
    span = (end_date - start_date).days + 1
    if span > MAX_CALENDAR_SPAN_DAYS:
        raise ValueError(f"date range must not exceed {MAX_CALENDAR_SPAN_DAYS} days")
    if end_date > today:
        raise ValueError("endDate must not be in the future (UTC)")
    if start_date < today - timedelta(days=MAX_CALENDAR_AGE_DAYS):
        raise ValueError(f"startDate must be within the last {MAX_CALENDAR_AGE_DAYS + 1} days (UTC)")
    start = datetime(start_date.year, start_date.month, start_date.day)
    end = datetime(end_date.year, end_date.month, end_date.day) + timedelta(days=1)
    return DateWindow(start=start, end=end, kind=CALENDAR, days=span)


_DAY_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_day(raw: str, name: str) -> date:
    if not isinstance(raw, str) or not _DAY_PATTERN.match(raw):
        raise ValueError(f"{name} must be a date in YYYY-MM-DD format")
    try:
        return datetime.strptime(raw, DATE_FORMAT).date()
    except ValueError:
        raise ValueError(f"{name} must be a date in YYYY-MM-DD format") from None


def parse_request_window(args: Mapping[str, Any], default_days: int = 30, now: Optional[datetime] = None) -> DateWindow:
    """Parse ``startDate``/``endDate`` or the legacy ``days`` argument.

    Raises ``ValueError`` with a client-facing message for invalid input.
    """
    raw_start = (args.get("startDate") or "").strip()
    raw_end = (args.get("endDate") or "").strip()
    if raw_start or raw_end:
        if not (raw_start and raw_end):
            raise ValueError("startDate and endDate must be provided together")
        now = now or utc_now()
        return calendar_window(_parse_day(raw_start, "startDate"), _parse_day(raw_end, "endDate"), today=now.date())

    raw_days = args.get("days", default_days)
    try:
        days = int(raw_days)
    except (TypeError, ValueError):
        raise ValueError("days must be a positive integer") from None
    if days < 1:
        raise ValueError("days must be a positive integer")
    return rolling_window(days, now=now)
