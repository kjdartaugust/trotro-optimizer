"""Who gets which pass: a rider's is free to anyone, a moderator's takes the server's key
(app/auth.py). Against a real database: test_auth_db.py."""
import uuid

import pytest
from fastapi.testclient import TestClient
from jose import jwt

from app import limits
from app.auth import MODERATOR_PASS_HOURS, create_token, is_moderator_pass, moderator_stamp
from app.config import settings
from app.main import app

KEY = "a-long-key-only-the-moderators-know"
api = TestClient(app)


def claims(token: str) -> dict:
    return jwt.decode(token, settings.supabase_jwt_secret, algorithms=[settings.jwt_algorithm])


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(settings, "dev_auth", True)
    monkeypatch.setattr(settings, "moderator_key", "")
    limits._moderator_misses.clear()


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setattr(settings, "moderator_key", KEY)
    return KEY


def ask(role: str = "moderator", key: str | None = None, sub: str = "ama", addr: str = "10.0.0.1"):
    headers = {"X-Forwarded-For": addr}
    if key is not None:
        headers["X-Moderator-Key"] = key
    return api.post("/auth/token", params={"sub": sub, "role": role}, headers=headers)


# ── A rider's pass ─────────────────────────────────────────────────────────────────────────────

def test_anyone_gets_a_riders_pass():
    r = api.post("/auth/token", params={"sub": "demo-commuter", "role": "user"})
    assert r.status_code == 200
    c = claims(r.json()["access_token"])
    assert c["role"] == "user" and "mod" not in c
    assert not is_moderator_pass(c)
    # The account every phone shares is the one the app has always used.
    assert c["sub"] == str(uuid.uuid5(uuid.NAMESPACE_DNS, "trotro-dev:demo-commuter"))
    assert c["email"] == "demo-commuter@example.com"


def test_a_pass_is_never_in_an_existing_accounts_id():
    someone = str(uuid.uuid4())  # the seeded moderator's id, say: ids show in public lists
    c = claims(api.post("/auth/token", params={"sub": someone}).json()["access_token"])
    assert c["sub"] != someone
    assert c["email"] is None  # the account the old endpoint made in that id holds that address


def test_no_other_roles():
    assert ask(role="superuser").status_code == 422


# ── A moderator's pass ─────────────────────────────────────────────────────────────────────────

def test_nobody_moderates_until_a_key_is_set():
    assert moderator_stamp() is None
    assert ask().status_code == 403
    assert ask(key="anything-at-all-sent-here").status_code == 403
    assert ask(role="admin", key="").status_code == 403


def test_a_short_key_counts_as_no_key(monkeypatch):
    monkeypatch.setattr(settings, "moderator_key", "tooshort")
    assert moderator_stamp() is None
    assert ask(key="tooshort").status_code == 403


def test_a_moderators_pass_takes_the_key(key):
    assert ask().status_code == 403  # none sent
    assert ask(key=key[:-1]).status_code == 403  # nearly
    for role in ("moderator", "admin"):
        r = ask(role=role, key=key)
        assert r.status_code == 200
        c = claims(r.json()["access_token"])
        assert c["role"] == role and is_moderator_pass(c)
        assert c["exp"] - c["iat"] == MODERATOR_PASS_HOURS * 3600
        # The key can't be read back out of the pass.
        assert key not in str(c)


def test_passes_from_before_stop_moderating(key, monkeypatch):
    # What the old endpoint handed anyone who asked: it says "moderator" and nothing more.
    assert not is_moderator_pass(claims(create_token(str(uuid.uuid4()), role="moderator")))
    # Saying "user" with a stamp is no moderator either.
    assert not is_moderator_pass({"sub": "x", "role": "user", "mod": moderator_stamp()})
    # And a real one ends when the key changes or goes.
    real = claims(ask(key=key).json()["access_token"])
    assert is_moderator_pass(real)
    monkeypatch.setattr(settings, "moderator_key", "another-long-key-entirely")
    assert not is_moderator_pass(real)
    monkeypatch.setattr(settings, "moderator_key", "")
    assert not is_moderator_pass(real)


def test_with_dev_auth_off_only_moderators_get_a_pass(key, monkeypatch):
    monkeypatch.setattr(settings, "dev_auth", False)
    assert ask(role="user").status_code == 403
    assert ask(key=key).status_code == 200


def test_moderation_refuses_every_pass_but_a_moderators(key):
    # Refused before the database is asked anything, so this runs without one.
    assert api.get("/moderation/queue").status_code == 401
    rider = api.post("/auth/token", params={"sub": "demo-commuter"}).json()["access_token"]
    old = create_token(str(uuid.uuid4()), role="moderator")
    for token in (rider, old):
        auth = {"Authorization": f"Bearer {token}"}
        assert api.get("/moderation/queue", headers=auth).status_code == 403
        decide = api.post(f"/moderation/{uuid.uuid4()}/decision", json={"decision": "approve"}, headers=auth)
        assert decide.status_code == 403


# ── Guessing the key ───────────────────────────────────────────────────────────────────────────

def test_wrong_keys_are_capped_per_address(key):
    for _ in range(limits.MODERATOR_MISSES_PER_HOUR):
        assert ask(key="not-the-key-at-all").status_code == 403
    assert ask(key="not-the-key-at-all").status_code == 429
    assert ask(key=key).status_code == 429  # even the right one, from there, this hour
    assert ask(key=key, addr="10.0.0.2").status_code == 200  # a moderator elsewhere isn't held up


def test_wrong_keys_are_forgotten_after_an_hour():
    n = limits.MODERATOR_MISSES_PER_HOUR
    for i in range(n):
        limits.moderator_miss("10.0.0.9", now=1000.0 + i)
    assert not limits.moderator_try_allowed("10.0.0.9", now=1000.0 + n)
    assert limits.moderator_try_allowed("10.0.0.9", now=1000.0 + 3601 + n)
    assert "10.0.0.9" not in limits._moderator_misses


def test_a_flood_of_made_up_addresses_is_not_kept(monkeypatch):
    monkeypatch.setattr(limits, "_MODERATOR_ADDRESSES_KEPT", 3)
    for i in range(10):
        limits.moderator_miss(f"10.0.1.{i}", now=1000.0)
    assert len(limits._moderator_misses) <= 3
