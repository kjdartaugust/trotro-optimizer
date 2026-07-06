"""Seed the database from seed/accra.json. Idempotent: clears and reloads the network.

Run: python -m app.seed
"""
from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

from sqlalchemy import delete, select

from .database import SessionLocal, engine
from .models import Base, Route, RouteStop, Station, User

SEED_FILE = Path(__file__).resolve().parents[2] / "seed" / "accra.json"


async def seed() -> None:
    # Ensure tables exist (dev convenience; production uses migrations).
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    data = json.loads(SEED_FILE.read_text(encoding="utf-8"))

    async with SessionLocal() as db:
        # Wipe network tables (leave users/contributions intact).
        await db.execute(delete(RouteStop))
        await db.execute(delete(Route))
        await db.execute(delete(Station))
        await db.commit()

        # A seed/system moderator user for reference + a demo moderator.
        if not (await db.execute(select(User).where(User.role == "moderator"))).scalar_one_or_none():
            db.add(
                User(
                    id=str(uuid.uuid4()),
                    email="moderator@trotro.local",
                    display_name="Seed Moderator",
                    role="moderator",
                    trust_score=90.0,
                )
            )

        slug_to_id: dict[str, str] = {}
        for s in data["stations"]:
            sid = str(uuid.uuid4())
            slug_to_id[s["slug"]] = sid
            db.add(
                Station(
                    id=sid,
                    name=s["name"],
                    town=s.get("town"),
                    lat=s["lat"],
                    lon=s["lon"],
                    verified=True,
                    confidence=0.9,
                    version=1,
                )
            )
        await db.flush()

        for r in data["routes"]:
            rid = str(uuid.uuid4())
            db.add(
                Route(
                    id=rid,
                    name=r["name"],
                    color=r.get("color"),
                    verified=True,
                    confidence=0.9,
                    version=1,
                )
            )
            for i, stop in enumerate(r["stops"]):
                db.add(
                    RouteStop(
                        id=str(uuid.uuid4()),
                        route_id=rid,
                        station_id=slug_to_id[stop["slug"]],
                        seq=i,
                        fare_from_prev=stop.get("fare", 0),
                        minutes_from_prev=stop.get("min", 0),
                        version=1,
                    )
                )
        await db.commit()

    print(f"Seeded {len(data['stations'])} stations and {len(data['routes'])} routes from {SEED_FILE.name}")


if __name__ == "__main__":
    asyncio.run(seed())
