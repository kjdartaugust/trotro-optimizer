from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import get_current_user
from ..database import get_db
from ..models import Station, User
from ..routing.geo import haversine_m
from ..schemas import ContributionOut, StationCreate, StationOut
from ..services import ingest_contribution

router = APIRouter(prefix="/stations", tags=["stations"])


@router.get("", response_model=list[StationOut])
async def list_stations(
    q: str | None = Query(None, description="name search"),
    near_lat: float | None = None,
    near_lon: float | None = None,
    radius_m: float = 2000,
    limit: int = 200,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Station)
    if q:
        stmt = stmt.where(Station.name.ilike(f"%{q}%"))
    rows = (await db.execute(stmt.limit(limit))).scalars().all()
    if near_lat is not None and near_lon is not None:
        rows = [
            s for s in rows if haversine_m(near_lat, near_lon, s.lat, s.lon) <= radius_m
        ]
        rows.sort(key=lambda s: haversine_m(near_lat, near_lon, s.lat, s.lon))
    return rows


@router.post("", response_model=ContributionOut, status_code=201)
async def propose_station(
    body: StationCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Proposing a station is a contribution — it may auto-apply if the reporter is trusted."""
    contrib = await ingest_contribution(
        db, user, kind="station", target_id=None, payload=body.model_dump()
    )
    return contrib
