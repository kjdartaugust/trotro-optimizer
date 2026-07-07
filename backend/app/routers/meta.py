import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import create_token
from ..config import settings
from ..database import get_db

router = APIRouter(tags=["meta"])


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    db_ok = True
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    return {"status": "ok" if db_ok else "degraded", "db": db_ok}


@router.post("/auth/token")
async def dev_token(sub: str = "dev-user", role: str = "user"):
    """Dev-only: mint a JWT so the flow is testable without a Supabase project."""
    if not settings.dev_auth:
        raise HTTPException(403, "Dev auth disabled")
    # users.id is a UUID (Supabase subs are UUIDs). Coerce a friendly dev sub like "dev-user"
    # to a stable UUID so the local users row inserts cleanly and stays idempotent per sub.
    try:
        uuid.UUID(sub)
        uid = sub
    except ValueError:
        uid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"trotro-dev:{sub}"))
    return {"access_token": create_token(uid, email=f"{sub}@example.com", role=role),
            "token_type": "bearer"}
