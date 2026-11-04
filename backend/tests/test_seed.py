"""The network sync against a real Postgres (CI's service container); skipped without one."""
import asyncio
import json

import pytest
from sqlalchemy import func, select

from app.database import SessionLocal, engine
from app.models import RetiredRow, Route, RouteStop, Station
from app.routers.sync import changes
from app.seed import BACKEND, route_uuid, station_uuid, sync


async def _db_up() -> bool:
    async def connect() -> None:
        async with engine.connect():
            pass

    try:
        await asyncio.wait_for(connect(), timeout=5)
        return True
    except Exception:
        return False


def _bundle(name: str) -> dict:
    return json.loads((BACKEND / "seed" / name).read_text(encoding="utf-8"))


def _small_osm() -> dict:
    """The first two routes of the real network, and only their stations."""
    full = _bundle("accra.json")
    routes = full["routes"][:2]
    used = {st["slug"] for r in routes for st in r["stops"]}
    return {"meta": full["meta"], "stations": [s for s in full["stations"] if s["slug"] in used], "routes": routes}


async def _count(model) -> int:
    async with SessionLocal() as db:
        return (await db.execute(select(func.count()).select_from(model))).scalar()


async def test_demo_network_replaced_then_sync_is_a_no_op():
    if not await _db_up():
        pytest.skip("no database")
    demo, osm = _bundle("demo.json"), _small_osm()

    loaded = await sync(demo, reset=True)
    assert (loaded["stations_added"], loaded["routes_added"]) == (len(demo["stations"]), len(demo["routes"]))
    demo_version = loaded["version"]

    first = await sync(osm)
    assert first["routes_retired"] == len(demo["routes"])
    assert first["stations_retired"] == len(demo["stations"])
    assert (first["stations_added"], first["routes_added"]) == (len(osm["stations"]), len(osm["routes"]))
    assert first["version"] == demo_version + 1
    assert await _count(Station) == len(osm["stations"])
    assert await _count(Route) == len(osm["routes"])
    assert await _count(RouteStop) == sum(len(r["stops"]) for r in osm["routes"])

    again = await sync(osm)
    assert again == {"stations_added": 0, "routes_added": 0, "stations_retired": 0,
                     "routes_retired": 0, "version": first["version"]}

    # A device that synced the demo is told to drop it, and gets the new network.
    async with SessionLocal() as db:
        cs = await changes(since=demo_version, db=db)
    assert len(cs.deleted_route_ids) == len(demo["routes"])
    assert len(cs.deleted_station_ids) == len(demo["stations"])
    assert {r.id for r in cs.routes} == {route_uuid(r["key"]) for r in osm["routes"]}
    assert {s.id for s in cs.stations} == {station_uuid(s["slug"]) for s in osm["stations"]}
    assert all(r.board_fare == osm["routes"][0]["board_fare"] for r in cs.routes)

    # A later bundle with one more route only adds that route; the demo stays retired.
    full = _bundle("accra.json")
    bigger = dict(osm, routes=full["routes"][:3])
    used = {st["slug"] for r in bigger["routes"] for st in r["stops"]}
    bigger["stations"] = [s for s in full["stations"] if s["slug"] in used]
    more = await sync(bigger)
    assert more["routes_added"] == 1 and more["routes_retired"] == 0
    assert await _count(RetiredRow) == len(demo["routes"]) + len(demo["stations"])
