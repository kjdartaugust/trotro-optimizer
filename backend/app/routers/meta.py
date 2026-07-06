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
    return {"access_token": create_token(sub, email=f"{sub}@example.com", role=role),
            "token_type": "bearer"}
