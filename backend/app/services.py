"""Business logic shared by routers: ingesting contributions, votes, and moderation."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .apply import apply_contribution
from .config import settings
from .models import Contribution, User, Vote
from .trust import apply_trust_delta, contribution_confidence


async def ingest_contribution(
    db: AsyncSession,
    user: User | None,
    kind: str,
    target_id: str | None,
    payload: dict,
    note: str | None = None,
    client_key: str | None = None,
) -> Contribution:
    # Idempotency: a client_key we've already seen returns the existing contribution.
    if client_key:
        existing = (
            await db.execute(select(Contribution).where(Contribution.client_key == client_key))
        ).scalar_one_or_none()
        if existing:
            return existing

    reporter_trust = user.trust_score if user else float(settings.default_trust_score)
    confidence = contribution_confidence(reporter_trust, net_weighted_votes=0.0, kind=kind)

    contrib = Contribution(
        kind=kind,
        target_id=target_id,
        payload=payload,
        note=note,
        reporter_id=user.id if user else None,
        confidence=confidence,
        client_key=client_key,
        status="pending",
    )
    db.add(contrib)
    await db.flush()

    if confidence >= settings.auto_approve_threshold:
        await _approve(db, contrib, reviewer_id=None)
    await db.commit()
    await db.refresh(contrib)
    return contrib


async def cast_vote(db: AsyncSession, contrib: Contribution, user: User, value: int) -> Contribution:
    existing = (
        await db.execute(
            select(Vote).where(Vote.contribution_id == contrib.id, Vote.user_id == user.id)
        )
    ).scalar_one_or_none()
    if existing:
        existing.value = value
    else:
        db.add(Vote(contribution_id=contrib.id, user_id=user.id, value=value))
    await db.flush()

    # Recompute confidence from trust-weighted net votes.
    net = await _net_weighted_votes(db, contrib.id)
    reporter = await db.get(User, contrib.reporter_id) if contrib.reporter_id else None
    reporter_trust = reporter.trust_score if reporter else float(settings.default_trust_score)
    contrib.confidence = contribution_confidence(
        reporter_trust, net, contrib.kind, contrib.created_at
    )

    if contrib.status == "pending" and contrib.confidence >= settings.auto_approve_threshold:
        await _approve(db, contrib, reviewer_id=None)
    elif contrib.status == "pending" and net <= -3:
        contrib.status = "rejected"

    await db.commit()
    await db.refresh(contrib)
    return contrib


async def moderate(
    db: AsyncSession, contrib: Contribution, moderator: User, decision: str
) -> Contribution:
    if decision == "approve":
        await _approve(db, contrib, reviewer_id=moderator.id)
    else:
        contrib.status = "rejected"
        contrib.reviewed_by = moderator.id
        reporter = await db.get(User, contrib.reporter_id) if contrib.reporter_id else None
        if reporter:
            reporter.trust_score = apply_trust_delta(reporter.trust_score, approved=False)
    await db.commit()
    await db.refresh(contrib)
    return contrib


async def _approve(db: AsyncSession, contrib: Contribution, reviewer_id: str | None) -> None:
    await apply_contribution(db, contrib)
    contrib.status = "approved"
    contrib.reviewed_by = reviewer_id
    reporter = await db.get(User, contrib.reporter_id) if contrib.reporter_id else None
    if reporter:
        reporter.trust_score = apply_trust_delta(reporter.trust_score, approved=True)


async def _net_weighted_votes(db: AsyncSession, contribution_id: str) -> float:
    votes = (
        await db.execute(select(Vote).where(Vote.contribution_id == contribution_id))
    ).scalars().all()
    total = 0.0
    for v in votes:
        voter = await db.get(User, v.user_id)
        w = (voter.trust_score / 100.0) if voter else 0.2
        total += v.value * (0.3 + 0.7 * w)  # everyone counts a little; trusted voters more
    return total
