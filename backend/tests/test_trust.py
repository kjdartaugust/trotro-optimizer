from datetime import UTC, datetime, timedelta

from app.trust import (
    apply_trust_delta,
    contribution_confidence,
    time_decay,
    votes_factor,
)


def test_trusted_reporter_higher_confidence():
    low = contribution_confidence(reporter_trust=10, net_weighted_votes=0, kind="route")
    high = contribution_confidence(reporter_trust=90, net_weighted_votes=0, kind="route")
    assert high > low


def test_votes_increase_confidence():
    base = contribution_confidence(30, 0, "route")
    upvoted = contribution_confidence(30, 4, "route")
    assert upvoted > base
    assert votes_factor(4) > votes_factor(0) > votes_factor(-4)


def test_fare_time_decay():
    fresh = time_decay(datetime.now(UTC), halflife_days=30)
    old = time_decay(datetime.now(UTC) - timedelta(days=60), halflife_days=30)
    assert fresh > old
    assert old == __import__("pytest").approx(0.25, abs=0.02)  # two half-lives


def test_trust_delta_bounds():
    assert apply_trust_delta(99, approved=True) <= 100
    assert apply_trust_delta(2, approved=False) >= 0


def test_confidence_clamped():
    c = contribution_confidence(100, 100, "route")
    assert 0.0 <= c <= 1.0
