"""Offline sync endpoints.

  * ``GET /sync/dataset``       — full versioned snapshot to seed a device.
  * ``GET /sync/changes?since`` — deltas (rows whose ``version`` > cursor).
  * ``POST /sync/push``         — push queued offline contributions (idempotent by client_key).
"""
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..auth import get_optional_user
from ..database import get_db
from ..loader import dataset_version
from ..models import Contribution, Route, Station, User
from ..schemas import (
    ChangeSet,
    DatasetSnapshot,
    PushRequest,
    PushResult,
)
from ..services import ingest_contribution

router = APIRouter(prefix="/sync", tags=["offline-sync"])


@router.get("/dataset", response_model=DatasetSnapshot)
async def dataset(db: AsyncSession = Depends(get_db)):
    version = await dataset_version(db)
    stations = (await db.execute(select(Station))).scalars().all()
    routes = (
        await db.execute(select(Route).options(selectinload(Route.stops)))
    ).scalars().all()
    return DatasetSnapshot(
        version=version,
        generated_at=datetime.now(UTC),
        stations=stations,
        routes=routes,
    )


@router.get("/changes", response_model=ChangeSet)
async def changes(since: int = 0, db: AsyncSession = Depends(get_db)):
    version = await dataset_version(db)
    stations = (
        await db.execute(select(Station).where(Station.version > since))
    ).scalars().all()
    routes = (
        await db.execute(
            select(Route).options(selectinload(Route.stops)).where(Route.version > since)
        )
    ).scalars().all()
    return ChangeSet(since=since, version=version, stations=stations, routes=routes)


@router.post("/push", response_model=PushResult)
async def push(
    body: PushRequest,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    accepted, duplicates, ids = 0, 0, []
    for item in body.items:
        seen = False
        if item.client_key:
            seen = (
                await db.execute(
                    select(func.count())
                    .select_from(Contribution)
                    .where(Contribution.client_key == item.client_key)
                )
            ).scalar() > 0
        contrib = await ingest_contribution(
            db, user, item.kind, item.target_id, item.payload, item.note, item.client_key
        )
        if seen:
            duplicates += 1
        else:
            accepted += 1
        ids.append(contrib.id)
    return PushResult(accepted=accepted, duplicates=duplicates, ids=ids)
