"""Load the trotro network (seed/accra.json) into the database, safely enough to run on every boot.

    python -m app.seed                          # sync the network to the bundle (rules below)
    python -m app.seed --boot                   # the same, from the container's start command:
                                                # a failure is logged and the API starts anyway
    python -m app.seed --reset                  # dev only: wipe the network, load the bundle afresh
    python -m app.seed --reset --file seed/demo.json   # the old 17-station demo network

Ids are stable (uuid5 of each station's slug and route's key), so syncing the same bundle twice
changes nothing and contributions keep pointing at the rows they were about.

The sync never undoes the community's work:

* The first time a bundle's routes meet the database (none of their ids is there yet), the rows an
  earlier seed loaded (``created_by`` empty) that the bundle doesn't have are retired: deleted, with
  a ``retired_rows`` record so devices drop them at their next ``/sync/changes``. Rows people added
  through contributions stay, and so does any station a remaining route still stops at.
* After that it only adds the bundle's stations and routes that aren't there yet. It never edits or
  deletes an existing row, so fare reports and corrections survive every redeploy.

Everything one sync writes shares one new dataset version, so devices fetch it as one change.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import uuid
from pathlib import Path

from sqlalchemy import delete, insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from .database import SessionLocal, engine
from .ids import route_uuid, station_uuid
from .loader import dataset_version
from .models import Base, RetiredRow, Route, RouteStop, Station, User

log = logging.getLogger("seed")

BACKEND = Path(__file__).resolve().parents[1]
SEED_FILE = BACKEND / "seed" / "accra.json"
MIGRATIONS = BACKEND / "migrations"

# The OSM network's stops are where OSM's mappers put them; its fares are estimates. Neither has
# been confirmed by riders yet, which is what `verified` and a high confidence mean.
STATION_CONFIDENCE = 0.6
ROUTE_CONFIDENCE = 0.5


def _statements(sql: str) -> list[str]:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


async def ensure_schema(conn: AsyncConnection) -> None:
    """Missing tables (a fresh dev database gets them all), then the migrations after 0001.

    0001 is the base schema, applied by scripts/init_db, CI or docker compose; the later ones are
    idempotent, so running them on every boot is how they reach production.
    """
    await conn.run_sync(Base.metadata.create_all)
    for path in sorted(MIGRATIONS.glob("*.sql"))[1:]:
        for stmt in _statements(path.read_text(encoding="utf-8")):
            await conn.exec_driver_sql(stmt)


async def _ensure_moderator(db: AsyncSession) -> None:
    if not (await db.execute(select(User).where(User.role == "moderator"))).scalars().first():
        db.add(
            User(
                id=str(uuid.uuid4()),
                email="moderator@trotro.local",
                display_name="Seed Moderator",
                role="moderator",
                trust_score=90.0,
            )
        )


async def _retire(db: AsyncSession, kind: str, ids: list[str], version: int) -> None:
    if not ids:
        return
    stmt = pg_insert(RetiredRow).values([{"id": i, "kind": kind, "version": version} for i in ids])
    await db.execute(stmt.on_conflict_do_update(index_elements=["id"], set_={"version": version}))


async def sync(bundle: dict, *, reset: bool = False) -> dict:
    """Bring the database's network in line with ``bundle``; returns what changed."""
    async with engine.begin() as conn:
        await ensure_schema(conn)

    verified = bool(bundle.get("meta", {}).get("verified", False))
    stations = bundle["stations"]
    routes = bundle["routes"]
    sid = {s["slug"]: station_uuid(s["slug"]) for s in stations}
    rid = [route_uuid(r.get("key") or r["name"]) for r in routes]
    out = {"stations_added": 0, "routes_added": 0, "stations_retired": 0, "routes_retired": 0}

    async with SessionLocal() as db:
        if reset:
            await db.execute(delete(RouteStop))
            await db.execute(delete(Route))
            await db.execute(delete(Station))
            await db.execute(delete(RetiredRow))
        await _ensure_moderator(db)

        have_routes = set((await db.execute(select(Route.id))).scalars())
        first = not (have_routes & set(rid))
        version = await dataset_version(db) + 1

        if first and have_routes:
            keep = set(rid)
            old_routes = [
                i for i in (await db.execute(select(Route.id).where(Route.created_by.is_(None)))).scalars()
                if i not in keep
            ]
            if old_routes:
                await db.execute(delete(RouteStop).where(RouteStop.route_id.in_(old_routes)))
                await db.execute(delete(Route).where(Route.id.in_(old_routes)))
            still_used = set((await db.execute(select(RouteStop.station_id).distinct())).scalars())
            keep_st = set(sid.values())
            old_stations = [
                i for i in (await db.execute(select(Station.id).where(Station.created_by.is_(None)))).scalars()
                if i not in keep_st and i not in still_used
            ]
            if old_stations:
                await db.execute(delete(Station).where(Station.id.in_(old_stations)))
            await _retire(db, "route", old_routes, version)
            await _retire(db, "station", old_stations, version)
            out["routes_retired"], out["stations_retired"] = len(old_routes), len(old_stations)

        have_stations = set((await db.execute(select(Station.id))).scalars())
        new_stations = [
            {
                "id": sid[s["slug"]], "name": s["name"], "town": s.get("town"),
                "lat": s["lat"], "lon": s["lon"], "verified": verified,
                "confidence": STATION_CONFIDENCE, "version": version,
            }
            for s in stations if sid[s["slug"]] not in have_stations
        ]
        new_routes, new_stops = [], []
        for r, route_id in zip(routes, rid, strict=True):
            if route_id in have_routes:
                continue
            new_routes.append({
                "id": route_id, "name": r["name"], "operator": r.get("operator"),
                "color": r.get("color"), "board_fare": r.get("board_fare", 0),
                "verified": verified, "confidence": ROUTE_CONFIDENCE, "version": version,
            })
            new_stops.extend(
                {
                    "id": str(uuid.uuid4()), "route_id": route_id, "station_id": sid[st["slug"]],
                    "seq": i, "fare_from_prev": st.get("fare", 0), "minutes_from_prev": st.get("min", 0),
                    "version": version,
                }
                for i, st in enumerate(r["stops"])
            )

        # A row coming back no longer counts as retired.
        back = [row["id"] for row in new_stations + new_routes]
        if back:
            await db.execute(delete(RetiredRow).where(RetiredRow.id.in_(back)))
        if new_stations:
            await db.execute(insert(Station), new_stations)
        if new_routes:
            await db.execute(insert(Route), new_routes)
            await db.execute(insert(RouteStop), new_stops)
        out["stations_added"], out["routes_added"] = len(new_stations), len(new_routes)
        await db.commit()

    out["version"] = version if any(out.values()) else version - 1
    return out


async def _main(args: argparse.Namespace) -> None:
    bundle = json.loads(args.file.read_text(encoding="utf-8"))
    res = await sync(bundle, reset=args.reset)
    log.info(
        "%s: +%d stations, +%d routes, %d stations and %d routes retired (dataset v%d)",
        args.file.name, res["stations_added"], res["routes_added"],
        res["stations_retired"], res["routes_retired"], res["version"],
    )
    await engine.dispose()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description="Sync the database's trotro network to a seed bundle.")
    ap.add_argument("--file", type=Path, default=SEED_FILE)
    ap.add_argument("--reset", action="store_true", help="dev only: wipe the network first")
    ap.add_argument("--boot", action="store_true", help="log a failure instead of raising")
    args = ap.parse_args()
    if args.boot and args.reset:
        ap.error("--reset is for development, never at boot")
    try:
        asyncio.run(_main(args))
    except Exception:
        if not args.boot:
            raise
        log.exception("network sync failed; starting the API anyway")


if __name__ == "__main__":
    main()
