"""Trust & verification scoring for crowdsourced contributions.

Confidence of a contribution combines:
  * the reporter's trust (0..100 -> 0..1),
  * corroborating votes (sigmoid over net votes weighted by voter trust),
  * time-decay for fare reports so fuel-price jumps converge on the new consensus quickly.

When ``confidence >= AUTO_APPROVE_THRESHOLD`` the change is applied automatically; otherwise it
waits in the moderation queue. Approvals raise the reporter's trust, rejections lower it.
"""
from __future__ import annotations

import math
from datetime import UTC, datetime

from .config import settings


def reporter_weight(trust_score: float) -> float:
    return max(0.0, min(1.0, trust_score / 100.0))


def votes_factor(net_weighted_votes: float) -> float:
    """Map net (trust-weighted) votes to a 0..1 corroboration factor via a logistic curve."""
    return 1.0 / (1.0 + math.exp(-net_weighted_votes / 2.0))


def time_decay(reported_at: datetime, halflife_days: float | None = None) -> float:
    hl = halflife_days if halflife_days is not None else settings.fare_report_halflife_days
    age_days = (datetime.now(UTC) - reported_at).total_seconds() / 86400.0
    return 0.5 ** (age_days / max(hl, 0.1))


def contribution_confidence(
    reporter_trust: float,
    net_weighted_votes: float,
    kind: str,
    reported_at: datetime | None = None,
) -> float:
    base = 0.55 * reporter_weight(reporter_trust) + 0.45 * votes_factor(net_weighted_votes)
    if kind == "fare" and reported_at is not None:
        # Fresh fare reports are trusted more; old ones decay toward needing re-confirmation.
        base *= 0.5 + 0.5 * time_decay(reported_at)
    return round(max(0.0, min(1.0, base)), 4)


def apply_trust_delta(current: float, approved: bool) -> float:
    delta = 4.0 if approved else -6.0
    return max(0.0, min(100.0, current + delta))
