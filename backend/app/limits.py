"""Caps on what one address can send in an hour: what riders send without signing in, and wrong
guesses at the moderator key."""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Request

from .config import settings

_place_fixes: dict[str, deque[float]] = defaultdict(deque)

# Wrong moderator keys, per address. The key's length is what stops guessing (an address can be
# faked); this only slows a casual try and keeps the noise down.
MODERATOR_MISSES_PER_HOUR = 10
_MODERATOR_ADDRESSES_KEPT = 5000
_moderator_misses: dict[str, deque[float]] = {}


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


def moderator_try_allowed(addr: str, now: float | None = None) -> bool:
    """Whether this address may try a moderator key now: not after 10 wrong ones in an hour."""
    now = time.monotonic() if now is None else now
    misses = _moderator_misses.get(addr)
    if not misses:
        return True
    while misses and now - misses[0] > 3600:
        misses.popleft()
    if not misses:
        del _moderator_misses[addr]
        return True
    return len(misses) < MODERATOR_MISSES_PER_HOUR


def moderator_miss(addr: str, now: float | None = None) -> None:
    """Note a wrong moderator key from this address."""
    now = time.monotonic() if now is None else now
    if addr not in _moderator_misses and len(_moderator_misses) >= _MODERATOR_ADDRESSES_KEPT:
        # A flood of made-up addresses mustn't eat the server's memory: forget those whose hour
        # is up, or failing that, all of them.
        for a in [a for a, m in _moderator_misses.items() if now - m[-1] > 3600]:
            del _moderator_misses[a]
        if len(_moderator_misses) >= _MODERATOR_ADDRESSES_KEPT:
            _moderator_misses.clear()
    _moderator_misses.setdefault(addr, deque()).append(now)
