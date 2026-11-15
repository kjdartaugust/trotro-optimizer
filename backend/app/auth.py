"""Auth: verifies Supabase-issued (or dev-minted) JWTs.

Production: Supabase Auth signs access tokens with the project's JWT secret (HS256). Set
``SUPABASE_JWT_SECRET`` to that value and tokens verify transparently. The ``sub`` claim is the
user id; we upsert a local ``users`` row to attach the trust score.

Dev: with ``DEV_AUTH=true`` the ``/auth/token`` endpoint hands a rider's pass to anyone who asks,
in any name, so the whole flow works without a Supabase project (the live app runs this way:
riders have no accounts).

Moderators. Because a rider's pass is free to anyone, neither a name nor the role an account was
first given proves anything. A moderator's pass is one made with ``MODERATOR_KEY`` (sent to
``/auth/token`` as ``X-Moderator-Key``): it carries a stamp derived from that key, and
``require_moderator`` takes no pass without the current key's stamp. So a pass made before the
key existed stops moderating at once, changing the key ends every moderator's pass, and with no
key set nobody moderates. The ``role`` column on ``users`` is a record, not a grant.
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .database import get_db
from .models import User

bearer = HTTPBearer(auto_error=False)

MODERATOR_ROLES = ("moderator", "admin")
# A shorter key is too easy to guess, so it counts as no key at all.
MODERATOR_KEY_MIN = 16
MODERATOR_PASS_HOURS = 12


def moderator_stamp() -> str | None:
    """What a moderator's pass must carry: a fingerprint of the current key (no use to anyone
    without the signing secret), or None when no usable key is set."""
    key = settings.moderator_key
    if len(key) < MODERATOR_KEY_MIN:
        return None
    mac = hmac.new(settings.supabase_jwt_secret.encode(), b"moderator:" + key.encode(), hashlib.sha256)
    return mac.hexdigest()[:32]


def moderator_key_matches(sent: str | None) -> bool:
    key = settings.moderator_key
    if len(key) < MODERATOR_KEY_MIN or not sent:
        return False
    return hmac.compare_digest(sent.encode(), key.encode())


def is_moderator_pass(claims: dict) -> bool:
    """Whether these (already verified) claims are a moderator's pass made with the current key."""
    stamp = moderator_stamp()
    carried = claims.get("mod")
    return (
        stamp is not None
        and isinstance(carried, str)
        and hmac.compare_digest(carried.encode(), stamp.encode())
        and claims.get("role") in MODERATOR_ROLES
    )


def create_token(
    sub: str, email: str | None = None, role: str = "user", hours: int = 720, stamp: str | None = None
) -> str:
    now = datetime.now(UTC)
    claims = {
        "sub": sub,
        "email": email,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=hours)).timestamp()),
    }
    if stamp:
        claims["mod"] = stamp
    return jwt.encode(claims, settings.supabase_jwt_secret, algorithm=settings.jwt_algorithm)


def _decode(creds: HTTPAuthorizationCredentials | None) -> dict:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    try:
        claims = jwt.decode(
            creds.credentials,
            settings.supabase_jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"verify_aud": False},
        )
    except JWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}") from exc
    if not claims.get("sub"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token missing sub")
    return claims


async def _upsert_user(db: AsyncSession, sub: str, email: str | None, role: str) -> User:
    user = await db.get(User, sub)
    if user is None:
        user = User(
            id=sub, email=email, role=role, trust_score=float(settings.default_trust_score)
        )
        db.add(user)
        await db.flush()
    return user


async def _user_for(db: AsyncSession, claims: dict) -> User:
    # A pass that only says "moderator" is recorded as a rider's: saying so is free.
    role = claims.get("role") or "user"
    if role in MODERATOR_ROLES and not is_moderator_pass(claims):
        role = "user"
    user = await _upsert_user(db, claims["sub"], claims.get("email"), role)
    await db.commit()
    return user


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    return await _user_for(db, _decode(creds))


async def get_optional_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    if creds is None:
        return None
    try:
        return await get_current_user(creds, db)
    except HTTPException:
        return None


async def require_moderator(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    claims = _decode(creds)
    # The pass decides, never the account's stored role: anyone can ask for a rider's pass, and
    # an account's role was whatever its first pass claimed (see the module docstring).
    if not is_moderator_pass(claims):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Moderator pass required")
    return await _user_for(db, claims)
