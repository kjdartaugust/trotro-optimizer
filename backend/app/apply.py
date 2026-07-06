"""Apply an approved contribution to the canonical tables and bump sync versions."""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Contribution, Route, RouteStop, Station


async def _next_version(db: AsyncSession) -> int:
    sv = (await db.execute(select(func.max(Station.version)))).scalar() or 0
    rv = (await db.execute(select(func.max(Route.version)))).scalar() or 0
    return max(sv, rv) + 1


async def apply_contribution(db: AsyncSession, contrib: Contribution) -> None:
    v = await _next_version(db)
    p = contrib.payload or {}

    if contrib.kind == "station":
        if contrib.target_id:
            station = await db.get(Station, contrib.target_id)
            if station:
                for f in ("name", "town", "lat", "lon"):
                    if f in p:
                        setattr(station, f, p[f])
                station.verified = contrib.confidence >= 0.75
                station.confidence = max(station.confidence, contrib.confidence)
                station.version = v
        else:
            db.add(
                Station(
                    name=p["name"],
                    town=p.get("town"),
                    lat=p["lat"],
                    lon=p["lon"],
                    verified=contrib.confidence >= 0.75,
                    confidence=contrib.confidence,
                    created_by=contrib.reporter_id,
                    version=v,
                )
            )

    elif contrib.kind == "route":
        if contrib.target_id:
            route = await db.get(Route, contrib.target_id)
            if route:
                if "name" in p:
                    route.name = p["name"]
                route.confidence = max(route.confidence, contrib.confidence)
                route.verified = contrib.confidence >= 0.75
                route.version = v
                if "stops" in p:
                    for old in list(route.stops):
                        await db.delete(old)
                    await db.flush()
                    for s in p["stops"]:
                        db.add(RouteStop(route_id=route.id, version=v, **_stop(s)))
        else:
            route = Route(
                name=p["name"],
                operator=p.get("operator"),
                color=p.get("color"),
                confidence=contrib.confidence,
                verified=contrib.confidence >= 0.75,
                created_by=contrib.reporter_id,
                version=v,
            )
            db.add(route)
            await db.flush()
            for s in p.get("stops", []):
                db.add(RouteStop(route_id=route.id, version=v, **_stop(s)))

    elif contrib.kind == "fare":
        # A fare report updates one segment's fare (identified by route + destination stop seq).
        route = await db.get(Route, contrib.target_id) if contrib.target_id else None
        if route:
            seq = p.get("seq")
            new_fare = p.get("fare")
            for st in route.stops:
                if st.seq == seq and new_fare is not None:
                    st.fare_from_prev = new_fare
                    st.version = v
            route.version = v
            route.confidence = max(route.confidence, contrib.confidence)


def _stop(s: dict) -> dict:
    return {
        "station_id": s["station_id"],
        "seq": s["seq"],
        "fare_from_prev": s.get("fare_from_prev", 0),
        "minutes_from_prev": s.get("minutes_from_prev", 0),
    }
