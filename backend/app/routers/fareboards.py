"""Reading a fare board photo: ``POST /fareboards/read`` (multipart, field ``photo``).

The photo is read by whichever vision model the server is set up with (see app/fareboard.py) and
dropped; the rider checks the rows it found and sends them as a ``fareboard`` contribution.
``GET /fareboards/status`` says whether photos can be read here at all, so the app can offer
typing the board in instead.

Free tiers have limits, so reads are capped per address per hour and in all per day.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, HTTPException, Request, UploadFile

from .. import fareboard
from ..config import settings

router = APIRouter(prefix="/fareboards", tags=["crowdsourcing"])

_by_address: dict[str, deque[float]] = defaultdict(deque)
_all: deque[float] = deque()


def _address(request: Request) -> str:
    # Behind Render's proxy the rider's address is the first in X-Forwarded-For.
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def _allow(address: str, now: float) -> bool:
    hits = _by_address[address]
    while hits and now - hits[0] > 3600:
        hits.popleft()
    while _all and now - _all[0] > 86400:
        _all.popleft()
    if len(hits) >= settings.fareboard_reads_per_hour or len(_all) >= settings.fareboard_reads_per_day:
        return False
    hits.append(now)
    _all.append(now)
    return True


@router.get("/status")
async def status():
    return {"reader": bool(fareboard.providers())}


@router.post("/read")
async def read(request: Request, photo: UploadFile):
    if not fareboard.providers():
        raise HTTPException(503, "not_configured")
    data = await photo.read(fareboard.MAX_PHOTO_BYTES + 1)
    if len(data) > fareboard.MAX_PHOTO_BYTES:
        raise HTTPException(413, "That photo is too big. Try again with a smaller one.")
    if fareboard.sniff(data) is None:
        raise HTTPException(415, "That isn't a photo we can read (JPEG, PNG or WebP).")
    if not _allow(_address(request), time.monotonic()):
        raise HTTPException(429, "Lots of photos read just now. Type the board in, or try again later.")
    try:
        board = await fareboard.read_board(data)
    except fareboard.NotConfigured as exc:
        raise HTTPException(503, "not_configured") from exc
    except fareboard.Unreadable as exc:
        raise HTTPException(422, "Couldn't read that photo. Try a closer, straighter one, or type it in.") from exc
    return {"rows": board.rows, "station": board.station, "effective": board.effective}
