"""Shared test fixtures."""

from __future__ import annotations

import uuid
from typing import Any, AsyncGenerator
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth import CurrentUser
from app.database import Base, get_db
from app.main import app

# In-memory SQLite for tests (sync driver wrapped in async)
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

engine = create_async_engine(TEST_DATABASE_URL, echo=False)
TestSessionLocal = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

TENANT_ID = str(uuid.uuid4())
USER_ID = str(uuid.uuid4())


@pytest_asyncio.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with TestSessionLocal() as session:
        yield session

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    async def _override_db() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    def _override_user() -> CurrentUser:
        return CurrentUser(user_id=USER_ID, tenant_id=TENANT_ID, claims={})

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[CurrentUser] = _override_user

    # Also override get_current_user
    from app.auth import get_current_user

    app.dependency_overrides[get_current_user] = _override_user

    transport = ASGITransport(app=app)  # type: ignore[arg-type]
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()
