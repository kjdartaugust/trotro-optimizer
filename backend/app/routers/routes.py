from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..auth import get_current_user
from ..database import get_db
from ..loader import load_graph
from ..models import Route, User
from ..redis_client import cache_get, cache_set
from ..routing.engine import plan
from ..schemas import (
    ContributionOut,
    ItineraryOut,
    PlanRequest,
    PlanResponse,
    RouteCreate,
    RouteOut,
)
from ..services import ingest_contribution

router = APIRouter(prefix="/routes", tags=["routes"])


@router.get("", response_model=list[RouteOut])
async def list_routes(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(select(Route).options(selectinload(Route.stops)))
    ).scalars().all()
    return rows


@router.post("/plan", response_model=PlanResponse)
async def plan_trip(body: PlanRequest, db: AsyncSession = Depends(get_db)):
    modes = body.modes or ["fastest", "cheapest", "fewest"]
    o = (body.origin.lat, body.origin.lon)
    d = (body.destination.lat, body.destination.lon)

    ck = f"plan:{o}:{d}:{','.join(sorted(modes))}"
    cached = await cache_get(ck)
    if cached:
        return PlanResponse.model_validate_json(cached)

    g = await load_graph(db)
    itineraries: dict[str, ItineraryOut] = {}
    for m in modes:
        it = plan(g, o, d, m)  # type: ignore[arg-type]
        if it:
            itineraries[m] = ItineraryOut(**it.__dict__ | {"legs": [leg.__dict__ for leg in it.legs]})

    resp = PlanResponse(itineraries=itineraries)
    await cache_set(ck, resp.model_dump_json(), ttl=120)
    return resp


@router.post("", response_model=ContributionOut, status_code=201)
async def propose_route(
    body: RouteCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    contrib = await ingest_contribution(
        db, user, kind="route", target_id=None, payload=body.model_dump()
    )
    return contrib
