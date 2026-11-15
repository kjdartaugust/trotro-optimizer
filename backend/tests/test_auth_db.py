"""Moderating, against a real Postgres (CI's service container); skipped without one: an account
the database calls a moderator opens nothing by itself, and a pass made with the key does."""
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from jose import jwt
from sqlalchemy import delete

from app import limits
from app.auth import create_token
from app.config import settings
from app.database import SessionLocal, engine
from app.main import app
from app.models import User
from tests.test_seed import _db_up

KEY = "a-long-key-only-the-moderators-know"
NAME = "test-moderator-key"
NAME_ID = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"trotro-dev:{NAME}"))


async def test_the_key_moderates_and_a_moderator_account_alone_does_not(monkeypatch):
    seeded = str(uuid.uuid4())
    try:
        if not await _db_up():
            pytest.skip("no database")
        try:
            async with SessionLocal() as db:
                # Like the moderator the seed puts in every database, whose id shows in public lists.
                db.add(User(id=seeded, email=f"{seeded}@trotro.test", role="moderator", trust_score=90.0))
                await db.commit()
            monkeypatch.setattr(settings, "dev_auth", True)
            monkeypatch.setattr(settings, "moderator_key", KEY)
            limits._moderator_misses.clear()
            await _only_the_key_moderates(seeded, monkeypatch)
        finally:
            async with SessionLocal() as db:
                await db.execute(delete(User).where(User.id.in_([seeded, NAME_ID])))
                await db.commit()
    finally:
        # Each test runs in its own event loop; pooled connections can't cross loops.
        await engine.dispose()


async def _only_the_key_moderates(seeded: str, monkeypatch):
    nothing = uuid.uuid4()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as api:

        async def queue(token: str) -> int:
            return (await api.get("/moderation/queue", headers={"Authorization": f"Bearer {token}"})).status_code

        async def decide(token: str) -> int:
            r = await api.post(
                f"/moderation/{nothing}/decision",
                json={"decision": "approve"},
                headers={"Authorization": f"Bearer {token}"},
            )
            return r.status_code

        # Passes of the kind the old endpoint gave anyone, in the moderator account's own id: a
        # rider's, and one that says "moderator". Neither moderates...
        for old in (create_token(seeded, role="user"), create_token(seeded, role="moderator")):
            assert await queue(old) == 403
            assert await decide(old) == 403
            # ...though each is still a rider's pass (it gets as far as "no such report").
            vote = await api.post(
                f"/contributions/{nothing}/vote", json={"value": 1}, headers={"Authorization": f"Bearer {old}"}
            )
            assert vote.status_code == 404

        # Asking for a pass in that id no longer gives one in it.
        asked = (await api.post("/auth/token", params={"sub": seeded})).json()["access_token"]
        got = jwt.decode(asked, settings.supabase_jwt_secret, algorithms=[settings.jwt_algorithm])
        assert got["sub"] != seeded
        assert await queue(asked) == 403

        # Without the key, no moderator's pass; with it, one that moderates.
        refused = await api.post("/auth/token", params={"sub": NAME, "role": "moderator"})
        assert refused.status_code == 403
        r = await api.post(
            "/auth/token", params={"sub": NAME, "role": "moderator"}, headers={"X-Moderator-Key": KEY}
        )
        assert r.status_code == 200, r.text
        moderator = r.json()["access_token"]
        assert await queue(moderator) == 200
        assert await decide(moderator) == 404  # let in; there's just no such report

        # Change the key and that pass moderates no more.
        monkeypatch.setattr(settings, "moderator_key", KEY + "-changed")
        assert await queue(moderator) == 403
        assert await decide(moderator) == 403
