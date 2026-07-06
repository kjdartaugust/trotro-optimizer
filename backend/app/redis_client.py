import redis.asyncio as redis

from .config import settings

_pool: redis.Redis | None = None


def get_redis() -> redis.Redis:
    """Lazily-created shared Redis client. Falls back gracefully if unavailable."""
    global _pool
    if _pool is None:
        _pool = redis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True)
    return _pool


async def cache_get(key: str) -> str | None:
    try:
        return await get_redis().get(key)
    except Exception:
        return None  # cache is best-effort; never block routing on Redis


async def cache_set(key: str, value: str, ttl: int = 300) -> None:
    try:
        await get_redis().set(key, value, ex=ttl)
    except Exception:
        pass
