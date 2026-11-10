"""A rider's pin move, through the API the app uses, against a real Postgres (CI's service
container); skipped without one. It shows for everyone at once, and the next move replaces it."""
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select

from app.database import SessionLocal, engine
from app.loader import network_version
from app.main import app
from app.models import Contribution, PlaceFix
from tests.test_seed import _db_up

KEY = "testplacefix@-0.11304,5.67345"


def item(to: list[float], client_key: str) -> dict:
    return {
        "kind": "place",
        "payload": {"key": KEY, "name": "Test Place Fix", "from": [-0.11304, 5.67345], "to": to},
        "client_key": client_key,
    }


async def test_a_moved_pin_reaches_every_device_and_the_next_move_replaces_it():
    try:
        if not await _db_up():
            pytest.skip("no database")
        try:
            await _moved_pin_syncs()
        finally:
            # Leave no pin behind: the network sync test counts on the versions it sets.
            async with SessionLocal() as db:
                await db.execute(delete(PlaceFix).where(PlaceFix.key == KEY))
                await db.execute(delete(Contribution).where(Contribution.client_key.like("test-place-fix-%")))
                await db.commit()
    finally:
        # Each test runs in its own event loop; pooled connections can't cross loops.
        await engine.dispose()


async def _moved_pin_syncs():
    async with SessionLocal() as db:
        graph_was = await network_version(db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as api:
        before = (await api.get("/sync/changes", params={"since": 0})).json()["version"]

        # A rider with no account moves it, as the app's offline outbox sends it.
        r = await api.post("/sync/push", json={"items": [item([-0.11337, 5.67193], "test-place-fix-1")]})
        assert r.status_code == 200, r.text
        assert r.json()["accepted"] == 1 and r.json()["refused"] == 0

        # Every other device gets it on its next catch-up, and a new device in the full dataset.
        cs = (await api.get("/sync/changes", params={"since": before})).json()
        fix = next(f for f in cs["place_fixes"] if f["key"] == KEY)
        assert (fix["lon"], fix["lat"]) == (-0.11337, 5.67193)
        assert (fix["from_lon"], fix["from_lat"]) == (-0.11304, 5.67345)
        assert fix["version"] == cs["version"] > before
        full = (await api.get("/sync/dataset")).json()
        assert any(f["key"] == KEY for f in full["place_fixes"])

        # The same push again (a flaky connection) changes nothing.
        again = await api.post("/sync/push", json={"items": [item([-0.11337, 5.67193], "test-place-fix-1")]})
        assert again.json()["duplicates"] == 1

        # Someone moves it again: the newest move is where it shows, one row per place.
        await api.post("/sync/push", json={"items": [item([-0.1135, 5.6721], "test-place-fix-2")]})
        cs2 = (await api.get("/sync/changes", params={"since": cs["version"]})).json()
        assert [(f["lon"], f["lat"]) for f in cs2["place_fixes"] if f["key"] == KEY] == [(-0.1135, 5.6721)]

        # A pin 4 km away is refused before it reaches the database, and only that item: the
        # rest of the phone's outbox still goes through.
        far = await api.post(
            "/sync/push",
            json={"items": [item([-0.11304, 5.71], "test-place-fix-3"), item([-0.1136, 5.6722], "test-place-fix-4")]},
        )
        assert far.status_code == 200
        assert (far.json()["refused"], far.json()["accepted"]) == (1, 1)

    async with SessionLocal() as db:
        assert (await db.execute(select(func.count()).select_from(PlaceFix).where(PlaceFix.key == KEY))).scalar() == 1
        statuses = (
            await db.execute(select(Contribution.status).where(Contribution.client_key.like("test-place-fix-%")))
        ).scalars().all()
        assert sorted(statuses) == ["approved", "approved", "approved"]
        # Trips are planned on the same graph: a pin moved on the map changes no route.
        assert await network_version(db) == graph_was
