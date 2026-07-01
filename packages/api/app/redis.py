"""Redis connection pool singleton."""

from __future__ import annotations

import redis.asyncio as redis

from app.config import settings

_pool: redis.Redis | None = None


async def get_redis() -> redis.Redis | None:
    """Return a shared async Redis client, or None if REDIS_URL is unset."""
    global _pool
    if not settings.REDIS_URL:
        return None
    if _pool is None:
        _pool = redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
        )
    return _pool
