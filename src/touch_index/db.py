"""PostgreSQL engine factory for the Touch Index ingestion workers."""

from __future__ import annotations

import os

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine


def get_engine(pool_size: int = 2) -> Engine:
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    db = os.getenv("POSTGRES_DB", "optimizer_v3")
    user = os.getenv("POSTGRES_USER", "optimizer_admin")
    password = os.getenv("POSTGRES_PASSWORD", "")
    url = f"postgresql://{user}:{password}@{host}:{port}/{db}"
    return create_engine(url, pool_size=pool_size, max_overflow=0, pool_pre_ping=True)


def health_check(engine: Engine) -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
