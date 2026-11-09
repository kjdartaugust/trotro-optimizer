"""Putting a station's fare board into the network's fares.

A board says what a ride from its station costs to each destination: "Madina: 9.80". In the
network a ride's fare is the route's ``board_fare`` (paid once, on boarding) plus each segment's
``fare_from_prev`` up to where you get off. So for every route that leaves the board's station and
later stops at a listed destination, the segments in between are set so that boarding at the
station and getting off there costs exactly the board's fare. Between two listed destinations the
difference is shared out like the old estimates were (by distance); the rest of the route is left
alone.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .models import Contribution, Route, RouteStop


def fit_route(
    stop_ids: list[str],
    seg: list[float],
    board_fare: float,
    at: str,
    fares: dict[str, float],
) -> tuple[float, list[float]] | None:
    """New (board_fare, segment fares) for one route, or None when the board prices nothing on it.

    ``stop_ids[k]`` is the route's k-th stop and ``seg[k]`` its ``fare_from_prev`` (``seg[0]`` is
    unused). ``at`` is the board's station, ``fares`` its fare to each destination station.
    """
    if at not in stop_ids:
        return None
    i = stop_ids.index(at)
    marks: list[tuple[int, float]] = []
    seen = {at}
    for j in range(i + 1, len(stop_ids)):
        sid = stop_ids[j]
        if sid in fares and sid not in seen:
            seen.add(sid)
            # Riding further never costs less: a fare below an earlier one is a misread, or
            # belongs to another line to that place.
            if not marks or fares[sid] >= marks[-1][1]:
                marks.append((j, fares[sid]))
    if not marks:
        return None
    board = round(min(board_fare, marks[0][1]), 2)  # a listed fare below the minimum: it's lower here
    new = [float(x) for x in seg]
    prev_j, prev_fare = i, board
    for j, fare in marks:
        span = list(range(prev_j + 1, j + 1))
        total = round(fare - prev_fare, 2)
        weights = [max(float(seg[k]), 0.0) for k in span]
        wsum = sum(weights)
        for k, w in zip(span, weights, strict=True):
            new[k] = round(total * (w / wsum if wsum > 0 else 1 / len(span)), 2)
        # Rounding: whatever's left over goes on the last segment, so the fare comes out exact.
        new[j] = max(round(new[j] + round(total - sum(new[k] for k in span), 2), 2), 0.0)
        prev_j, prev_fare = j, fare
    return board, new


async def apply_fareboard(db: AsyncSession, contrib: Contribution, version: int) -> int:
    """Apply an approved fare board to every route it prices. Returns how many routes changed."""
    p = contrib.payload or {}
    at = p.get("station_id")
    fares: dict[str, float] = {}
    for row in p.get("rows") or []:
        sid, fare = row.get("to_station_id"), row.get("fare")
        if sid and isinstance(fare, int | float) and not isinstance(fare, bool) and fare > 0:
            fares.setdefault(str(sid), float(fare))
    if not at or not fares:
        return 0
    through = select(RouteStop.route_id).where(RouteStop.station_id == at)
    routes = (
        await db.execute(select(Route).options(selectinload(Route.stops)).where(Route.id.in_(through)))
    ).scalars().all()
    changed = 0
    for route in routes:
        stops = sorted(route.stops, key=lambda s: s.seq)
        fit = fit_route(
            [s.station_id for s in stops],
            [float(s.fare_from_prev) for s in stops],
            float(route.board_fare or 0),
            at,
            fares,
        )
        if fit is None:
            continue
        board, seg = fit
        for s, fare in zip(stops, seg, strict=True):
            if round(float(s.fare_from_prev), 2) != fare:
                s.fare_from_prev = fare
                s.version = version
        route.board_fare = board
        route.version = version
        route.confidence = max(route.confidence, contrib.confidence)
        changed += 1
    return changed
