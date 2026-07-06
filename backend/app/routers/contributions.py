from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import get_current_user
from ..database import get_db
from ..models import Contribution, User
from ..schemas import ContributionCreate, ContributionOut, VoteIn
from ..services import cast_vote, ingest_contribution

router = APIRouter(prefix="/contributions", tags=["crowdsourcing"])


@router.get("", response_model=list[ContributionOut])
async def list_contributions(
    status: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Contribution).order_by(Contribution.created_at.desc()).limit(limit)
    if status:
        stmt = stmt.where(Contribution.status == status)
    return (await db.execute(stmt)).scalars().all()


@router.post("", response_model=ContributionOut, status_code=201)
async def submit_contribution(
    body: ContributionCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await ingest_contribution(
        db, user, body.kind, body.target_id, body.payload, body.note, body.client_key
    )


@router.post("/{contribution_id}/vote", response_model=ContributionOut)
async def vote(
    contribution_id: str,
    body: VoteIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    contrib = await db.get(Contribution, contribution_id)
    if not contrib:
        raise HTTPException(404, "Contribution not found")
    return await cast_vote(db, contrib, user, body.value)
