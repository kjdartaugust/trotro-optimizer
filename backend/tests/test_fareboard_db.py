"""A fare board sent by a trusted rider changes the routes' fares, against a real Postgres (CI's
service container); skipped without one."""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.database import SessionLocal
from app.models import Route, User
from app.seed import route_uuid, station_uuid, sync
from app.services import ingest_contribution
from tests.test_seed import _db_up, _small_osm


async def test_a_trusted_fare_board_sets_the_fare_to_each_listed_stop():
    if not await _db_up():
        pytest.skip("no database")
    osm = _small_osm()
    await sync(osm, reset=True)
    r = osm["routes"][0]
    at, mid, end = r["stops"][0]["slug"], r["stops"][len(r["stops"]) // 2]["slug"], r["stops"][-1]["slug"]
    assert len({at, mid, end}) == 3

    async with SessionLocal() as db:
        rider = User(id=str(uuid.uuid4()), trust_score=100.0, role="user")
        db.add(rider)
        await db.flush()
        board = {
            "station_id": station_uuid(at),
            "rows": [
                {"to": "Halfway", "fare": 7.6, "to_station_id": station_uuid(mid)},
                {"to": "The end", "fare": 12.4, "to_station_id": station_uuid(end)},
                {"to": "Somewhere new", "fare": 9.0, "to_station_id": None},
            ],
            "read": "typed",
        }
        c = await ingest_contribution(db, rider, "fareboard", None, board)
        assert c.status == "approved"

    async with SessionLocal() as db:
        route = (
            await db.execute(select(Route).options(selectinload(Route.stops)).where(Route.id == route_uuid(r["key"])))
        ).scalar_one()
        stops = sorted(route.stops, key=lambda s: s.seq)
        ids = [s.station_id for s in stops]

        def fare_to(slug: str) -> float:
            j = ids.index(station_uuid(slug))
            return round(float(route.board_fare) + sum(float(s.fare_from_prev) for s in stops[1 : j + 1]), 2)

        assert fare_to(mid) == 7.6
        assert fare_to(end) == 12.4
