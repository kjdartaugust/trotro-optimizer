"""Apply the SQL migration to a (possibly remote) Postgres/PostGIS database.

Reads DATABASE_URL from the environment (the asyncpg URL used by the app) and runs
migrations/0001_init.sql — creating the PostGIS/pgcrypto extensions, tables, the generated
`geom` column, and indexes. Idempotent (uses IF NOT EXISTS throughout).

Usage (e.g. against Neon):
    DATABASE_URL=postgresql+asyncpg://user:pass@host/db?sslmode=require python -m scripts.init_db
Then seed with:  python -m app.seed
"""
import asyncio
import os
from pathlib import Path

import asyncpg

SQL = (Path(__file__).resolve().parents[1] / "migrations" / "0001_init.sql").read_text(
    encoding="utf-8"
)


def _asyncpg_dsn(url: str) -> str:
    # Strip SQLAlchemy's "+asyncpg" driver suffix; asyncpg wants a plain postgresql:// DSN.
    return url.replace("postgresql+asyncpg://", "postgresql://").replace(
        "postgresql+psycopg://", "postgresql://"
    )


async def main() -> None:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL not set")
    conn = await asyncpg.connect(_asyncpg_dsn(url))
    try:
        await conn.execute(SQL)  # simple-query protocol runs the whole multi-statement file
        print("Migration applied: extensions, tables, PostGIS geom column, indexes.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
