import asyncio
import json
import os
import uuid
from typing import AsyncGenerator, Generator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession, AsyncEngine, create_async_engine, async_sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.database import Base, AsyncSessionLocal, get_db
from app.config import settings
from app.auth import CurrentUser


@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture
async def db_engine() -> AsyncGenerator[AsyncEngine, None]:
    """Create an in-memory SQLite database for testing."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_engine: AsyncEngine) -> AsyncGenerator[AsyncSession, None]:
    """Create a new database session for each test."""
    async_session = async_sessionmaker(
        db_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
        autocommit=False,
    )

    async with async_session() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Create a test client with overridden database dependency."""
    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.fixture
def mock_jwt_token():
    """Create a mock JWT token payload."""
    return {
        "sub": "user_12345",
        "email": "test@example.com",
        "aud": "test-audience",
        "exp": 9999999999,
    }


@pytest.fixture
def mock_clerk_user(mock_jwt_token):
    """Create a mock CurrentUser object."""
    return CurrentUser(
        user_id=mock_jwt_token["sub"],
        tenant_id=str(uuid.uuid4()),
        claims=mock_jwt_token,
    )


@pytest.fixture
def mock_clerk_user_no_org(mock_jwt_token):
    """Create a mock CurrentUser with no organization."""
    return CurrentUser(
        user_id=mock_jwt_token["sub"],
        tenant_id=None,
        claims=mock_jwt_token,
    )


@pytest.fixture
async def auth_headers(mock_jwt_token):
    """Create authorization headers with a mock JWT token."""
    token = "mock_token_" + mock_jwt_token["sub"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def mock_jwks():
    """Create mock JWKS response."""
    return {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "kid": "test-key-1",
                "n": "test",
                "e": "AQAB",
            }
        ]
    }


@pytest.fixture
def patch_get_current_user(mock_clerk_user):
    """Patch get_current_user to return mock user."""
    with patch("app.auth.get_current_user") as mock:
        mock.return_value = mock_clerk_user
        yield mock


@pytest.fixture
def patch_fetch_jwks():
    """Patch _fetch_jwks to return mock JWKS."""
    mock_jwks_data = {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "kid": "test-key-1",
                "n": "test",
                "e": "AQAB",
            }
        ]
    }
    with patch("app.auth._fetch_jwks") as mock:
        mock.return_value = mock_jwks_data
        yield mock


@pytest.fixture
def patch_httpx_get():
    """Patch httpx.get for external API calls."""
    with patch("httpx.AsyncClient.get") as mock:
        yield mock


@pytest.fixture
def patch_redis():
    """Patch Redis client."""
    with patch("app.redis.redis_client") as mock:
        yield mock


@pytest.fixture
def sample_tenant_id():
    """Generate a sample tenant ID."""
    return str(uuid.uuid4())


@pytest.fixture
def sample_user_id():
    """Generate a sample user ID."""
    return str(uuid.uuid4())


@pytest.fixture
def sample_property_data():
    """Sample property data for testing."""
    return {
        "address": "1234 Oak Creek Dr",
        "city": "The Woodlands",
        "state": "TX",
        "zip": "77381",
        "beds": 4,
        "baths": 3.0,
        "sqft": 2800,
        "listing_price": 450000,
        "arv_estimate": 520000,
        "property_type": "Single Family",
        "data_source": "demo",
    }


@pytest.fixture
def sample_user_data():
    """Sample user data for testing."""
    return {
        "email": "testuser@example.com",
        "clerk_id": "user_" + str(uuid.uuid4()),
        "role": "member",
    }


@pytest.fixture
def sample_deal_data():
    """Sample deal data for testing."""
    return {
        "name": "Test Deal",
        "status": "active",
        "description": "A test deal",
    }
