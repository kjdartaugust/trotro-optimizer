"""Caps on what one address can send in an hour, for what riders send without signing in."""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Request

from .config import settings

_place_fixes: dict[str, deque[float]] = defaultdict(deque)


def address(request: Request) -> str:
    """The rider's address: behind Render's proxy, the first in X-Forwarded-For."""
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def place_fix_allowed(addr: str, now: float | None = None) -> bool:
    """Whether this address may move one more pin now (``settings.place_fixes_per_hour``)."""
    now = time.monotonic() if now is None else now
    hits = _place_fixes[addr]
    while hits and now - hits[0] > 3600:
        hits.popleft()
    if len(hits) >= settings.place_fixes_per_hour:
        return False
    hits.append(now)
    return True
