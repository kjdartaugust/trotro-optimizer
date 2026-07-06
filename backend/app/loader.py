"""Load the network from the database into an in-memory routing Graph, cached in Redis.

The built graph is deterministic given the dataset version, so we memoise it per-process and
invalidate whenever the max row-version changes (i.e. any station/route was updated).
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import Route, RouteStop, Station
from .routing.engine import Graph, RouteStopT, RouteT, StationT, build_graph

_cache: dict[str, tuple[int, Graph]] = {}


async def dataset_version(db: AsyncSession) -> int:
    sv = (await db.execute(select(func.max(Station.version)))).scalar() or 0
    rv = (await db.execute(select(func.max(Route.version)))).scalar() or 0
    return max(sv, rv)


async def load_graph(db: AsyncSession) -> Graph:
    version = await dataset_version(db)
    cached = _cache.get("graph")
    if cached and cached[0] == version:
        return cached[1]

    stations = (await db.execute(select(Station))).scalars().all()
    routes = (await db.execute(select(Route))).scalars().all()
    stops = (await db.execute(select(RouteStop))).scalars().all()

    stops_by_route: dict[str, list[RouteStopT]] = {}
    for s in stops:
        stops_by_route.setdefault(s.route_id, []).append(
            RouteStopT(
                station_id=s.station_id,
                seq=s.seq,
                fare_from_prev=float(s.fare_from_prev),
                minutes_from_prev=float(s.minutes_from_prev),
            )
        )

    st = [StationT(id=s.id, name=s.name, lat=s.lat, lon=s.lon, town=s.town) for s in stations]
    rt = [
        RouteT(id=r.id, name=r.name, color=r.color, stops=stops_by_route.get(r.id, []))
        for r in routes
    ]

    opts = {
        "walk_radius_m": settings.walk_radius_m,
        "walk_speed_mps": settings.walk_speed_mps,
        "board_penalty_min": settings.board_penalty_min,
        "transfer_penalty_min": settings.transfer_penalty_min,
    }
    g = build_graph(st, rt, opts)
    _cache["graph"] = (version, g)
    return g
