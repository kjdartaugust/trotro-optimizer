from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import require_moderator
from ..database import get_db
from ..models import Contribution, User
from ..schemas import ContributionOut, ModerationDecision
from ..services import moderate

router = APIRouter(prefix="/moderation", tags=["moderation"])


@router.get("/queue", response_model=list[ContributionOut])
async def queue(
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _mod: User = Depends(require_moderator),
):
    stmt = (
        select(Contribution)
        .where(Contribution.status == "pending")
        .order_by(Contribution.confidence.desc(), Contribution.created_at.asc())
        .limit(limit)
    )
    return (await db.execute(stmt)).scalars().all()


@router.post("/{contribution_id}/decision", response_model=ContributionOut)
async def decide(
    contribution_id: str,
    body: ModerationDecision,
    db: AsyncSession = Depends(get_db),
    mod: User = Depends(require_moderator),
):
    contrib = await db.get(Contribution, contribution_id)
    if not contrib:
        raise HTTPException(404, "Contribution not found")
    if contrib.status != "pending":
        raise HTTPException(409, f"Already {contrib.status}")
    return await moderate(db, contrib, mod, body.decision)
