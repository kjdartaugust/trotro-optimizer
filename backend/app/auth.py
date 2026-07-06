"""Auth: verifies Supabase-issued (or dev-minted) JWTs.

Production: Supabase Auth signs access tokens with the project's JWT secret (HS256). Set
``SUPABASE_JWT_SECRET`` to that value and tokens verify transparently. The ``sub`` claim is the
user id; we upsert a local ``users`` row to attach trust score + role.

Dev: with ``DEV_AUTH=true`` the ``/auth/token`` endpoint mints a signed token so the whole flow
is testable without a Supabase project.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .database import get_db
from .models import User

bearer = HTTPBearer(auto_error=False)


def create_token(sub: str, email: str | None = None, role: str = "user", hours: int = 720) -> str:
    now = datetime.now(UTC)
    claims = {
        "sub": sub,
        "email": email,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=hours)).timestamp()),
    }
    return jwt.encode(claims, settings.supabase_jwt_secret, algorithm=settings.jwt_algorithm)


async def _upsert_user(db: AsyncSession, sub: str, email: str | None, role: str) -> User:
    user = await db.get(User, sub)
    if user is None:
        user = User(
            id=sub, email=email, role=role, trust_score=float(settings.default_trust_score)
        )
        db.add(user)
        await db.flush()
    return user


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    try:
        payload = jwt.decode(
            creds.credentials,
            settings.supabase_jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"verify_aud": False},
        )
    except JWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}") from exc

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token missing sub")
    user = await _upsert_user(db, sub, payload.get("email"), payload.get("role", "user"))
    await db.commit()
    return user


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


def require_moderator(user: User = Depends(get_current_user)) -> User:
    if user.role not in ("moderator", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Moderator role required")
    return user
