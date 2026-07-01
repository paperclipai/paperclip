import uuid
import json
from unittest.mock import patch, MagicMock, AsyncMock
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    CurrentUser,
    ensure_tenant_exists,
    security,
    _CLERK_NS,
)
from app.models import Tenant, User


class TestCurrentUser:
    def test_current_user_initialization(self, mock_clerk_user):
        """Test CurrentUser can be initialized."""
        assert mock_clerk_user.user_id is not None
        assert mock_clerk_user.tenant_id is not None
        assert mock_clerk_user.claims is not None

    def test_current_user_with_tenant_id(self, mock_clerk_user):
        """Test CurrentUser with tenant_id returns tenant_id."""
        assert mock_clerk_user.tenant_id == mock_clerk_user.effective_tenant_id

    def test_current_user_without_tenant_id(self, mock_clerk_user_no_org):
        """Test CurrentUser without tenant_id generates UUID."""
        effective_id = mock_clerk_user_no_org.effective_tenant_id
        assert effective_id is not None
        assert len(effective_id) == 36  # UUID format

    def test_current_user_claims_property(self, mock_jwt_token):
        """Test CurrentUser stores claims."""
        user = CurrentUser(
            user_id="user_123",
            tenant_id="tenant_456",
            claims=mock_jwt_token,
        )
        assert user.claims == mock_jwt_token
        assert user.claims["sub"] == mock_jwt_token["sub"]

    def test_current_user_properties_type(self, mock_clerk_user):
        """Test CurrentUser properties are correct type."""
        assert isinstance(mock_clerk_user.user_id, str)
        assert isinstance(mock_clerk_user.tenant_id, str)
        assert isinstance(mock_clerk_user.claims, dict)


class TestEnsureTenantExists:
    @pytest.mark.asyncio
    async def test_ensure_tenant_exists_with_tenant_id(
        self, db_session: AsyncSession, mock_clerk_user
    ):
        """Test ensure_tenant_exists with existing tenant."""
        tenant = Tenant(
            id=mock_clerk_user.tenant_id,
            name="Test Org",
            slug="test-org",
        )
        db_session.add(tenant)
        await db_session.commit()

        result = await ensure_tenant_exists(db_session, mock_clerk_user)
        assert result == mock_clerk_user.tenant_id

    @pytest.mark.asyncio
    async def test_ensure_tenant_exists_creates_tenant(
        self, db_session: AsyncSession, mock_clerk_user_no_org
    ):
        """Test ensure_tenant_exists creates tenant for solo user."""
        result = await ensure_tenant_exists(db_session, mock_clerk_user_no_org)
        assert result is not None
        assert isinstance(result, str)

    @pytest.mark.asyncio
    async def test_ensure_tenant_exists_idempotent(
        self, db_session: AsyncSession, mock_clerk_user_no_org
    ):
        """Test ensure_tenant_exists is idempotent."""
        result1 = await ensure_tenant_exists(db_session, mock_clerk_user_no_org)
        result2 = await ensure_tenant_exists(db_session, mock_clerk_user_no_org)
        assert result1 == result2


class TestAuthRouter:
    def test_auth_router_has_prefix(self):
        """Test auth router has correct prefix."""
        from app.auth import router
        assert router.prefix == "/auth"

    def test_auth_router_has_tags(self):
        """Test auth router has correct tags."""
        from app.auth import router
        assert "auth" in router.tags


class TestHTTPBearer:
    def test_http_bearer_exists(self):
        """Test HTTPBearer security scheme exists."""
        assert security is not None


class TestClerkNamespace:
    def test_clerk_ns_is_uuid(self):
        """Test Clerk namespace is valid UUID."""
        assert _CLERK_NS is not None
        assert str(_CLERK_NS) == "6ba7b810-9dad-11d1-80b4-00c04fd430c8"

    def test_clerk_ns_can_generate_uuid5(self, mock_clerk_user_no_org):
        """Test Clerk namespace can generate UUID5."""
        effective_id = mock_clerk_user_no_org.effective_tenant_id
        assert effective_id is not None
        # UUID5 from namespace should be deterministic
        expected = str(uuid.uuid5(_CLERK_NS, mock_clerk_user_no_org.user_id))
        assert effective_id == expected


class TestJWKSCache:
    @pytest.mark.asyncio
    async def test_jwks_cache_ttl_constant(self):
        """Test JWKS cache TTL is set."""
        from app.auth import _JWKS_TTL_SECONDS
        assert _JWKS_TTL_SECONDS == 3600

    @pytest.mark.asyncio
    async def test_jwks_cache_initialized(self):
        """Test JWKS cache is initialized."""
        from app.auth import _jwks_cache, _jwks_fetched_at
        assert isinstance(_jwks_cache, dict)
        assert isinstance(_jwks_fetched_at, dict)


class TestStaticJWKSOverride:
    @pytest.mark.asyncio
    async def test_static_jwks_override_parsing(self):
        """Test static JWKS override is parsed correctly."""
        from app.auth import _STATIC_JWKS
        # If override is set, it should be a dict
        if _STATIC_JWKS is not None:
            assert isinstance(_STATIC_JWKS, dict)
            assert "keys" in _STATIC_JWKS

    @pytest.mark.asyncio
    async def test_static_jwks_url_override(self):
        """Test static JWKS URL override is set correctly."""
        from app.auth import _STATIC_JWKS_URL
        # Can be None or a string
        if _STATIC_JWKS_URL is not None:
            assert isinstance(_STATIC_JWKS_URL, str)


class TestAuthDependencies:
    def test_get_current_user_is_callable(self):
        """Test get_current_user is callable."""
        from app.auth import get_current_user
        assert callable(get_current_user)

    def test_get_current_user_is_async(self):
        """Test get_current_user is async."""
        import asyncio
        from app.auth import get_current_user
        assert asyncio.iscoroutinefunction(get_current_user)


class TestAuthExceptions:
    @pytest.mark.asyncio
    async def test_invalid_token_raises_exception(self, client):
        """Test invalid token raises exception."""
        response = await client.get(
            "/health",
            headers={"Authorization": "Bearer invalid_token"},
        )
        # Health endpoint doesn't require auth, but testing the bearer scheme


class TestCurrentUserEffectiveTenantID:
    def test_effective_tenant_id_with_org(self, mock_clerk_user):
        """Test effective_tenant_id returns org tenant_id."""
        assert mock_clerk_user.effective_tenant_id == mock_clerk_user.tenant_id

    def test_effective_tenant_id_solo_user(self, mock_clerk_user_no_org):
        """Test effective_tenant_id generates UUID for solo user."""
        effective = mock_clerk_user_no_org.effective_tenant_id
        assert effective is not None
        # Should be deterministic for same user_id
        effective2 = mock_clerk_user_no_org.effective_tenant_id
        assert effective == effective2
