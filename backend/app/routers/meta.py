import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import MODERATOR_PASS_HOURS, create_token, moderator_key_matches, moderator_stamp
from ..config import settings
from ..database import get_db
from ..limits import address, moderator_miss, moderator_try_allowed

router = APIRouter(tags=["meta"])


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    db_ok = True
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    return {"status": "ok" if db_ok else "degraded", "db": db_ok}


def _is_uuid(s: str) -> bool:
    try:
        uuid.UUID(s)
        return True
    except ValueError:
        return False


@router.post("/auth/token")
async def auth_token(
    request: Request,
    sub: str = Query("dev-user", min_length=1, max_length=64),
    role: Literal["user", "moderator", "admin"] = "user",
    x_moderator_key: str | None = Header(None),
):
    """A rider's pass for anyone who asks while ``DEV_AUTH`` is on (riders have no accounts); a
    moderator's pass only for whoever sends this server's ``MODERATOR_KEY`` as ``X-Moderator-Key``
    (see app/auth.py)."""
    # The account is always worked out from the name, never taken as given: a pass can be asked
    # for in a name, not in an existing account's id (the seeded moderator's, a real user's).
    uid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"trotro-dev:{sub}"))
    # Emails are unique, and an account the old endpoint made in that very id holds this one.
    email = None if _is_uuid(sub) else f"{sub}@example.com"

    if role == "user":
        if not settings.dev_auth:
            raise HTTPException(403, "Dev auth disabled")
        return {"access_token": create_token(uid, email=email), "token_type": "bearer"}

    stamp = moderator_stamp()
    if stamp is None:
        raise HTTPException(403, "Moderating is off on this server: MODERATOR_KEY isn't set (16 characters or more).")
    addr = address(request)
    if not moderator_try_allowed(addr):
        raise HTTPException(429, "Too many wrong moderator keys from here. Try again in an hour.")
    if not moderator_key_matches(x_moderator_key):
        moderator_miss(addr)
        raise HTTPException(403, "A moderator's pass needs the right X-Moderator-Key.")
    return {
        "access_token": create_token(uid, email=email, role=role, hours=MODERATOR_PASS_HOURS, stamp=stamp),
        "token_type": "bearer",
    }
