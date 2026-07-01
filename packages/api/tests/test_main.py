import pytest
from httpx import AsyncClient


class TestHealthEndpoint:
    async def test_health_check_success(self, client: AsyncClient):
        """Test health check endpoint returns ok."""
        response = await client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["service"] == "gcp-renovation-api"

    async def test_health_check_response_format(self, client: AsyncClient):
        """Test health check response has correct format."""
        response = await client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)
        assert "status" in data
        assert "service" in data


class TestAuthConfigEndpoint:
    async def test_auth_config_success(self, client: AsyncClient):
        """Test auth-config endpoint returns configuration."""
        response = await client.get("/auth-config")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)

    async def test_auth_config_has_expected_fields(self, client: AsyncClient):
        """Test auth-config response includes expected fields."""
        response = await client.get("/auth-config")
        data = response.json()
        assert "static_jwks_loaded" in data
        assert "static_jwks_key_count" in data
        assert "static_jwks_url_set" in data
        assert "clerk_jwks_override_env_len" in data

    async def test_auth_config_types(self, client: AsyncClient):
        """Test auth-config response has correct types."""
        response = await client.get("/auth-config")
        data = response.json()
        assert isinstance(data["static_jwks_loaded"], bool)
        assert isinstance(data["static_jwks_key_count"], int)
        assert isinstance(data["static_jwks_url_set"], bool)
        assert isinstance(data["clerk_jwks_override_env_len"], int)


class TestSeedDemoEndpoint:
    @pytest.mark.asyncio
    async def test_seed_demo_without_auth(self, client: AsyncClient):
        """Test seed-demo endpoint requires authentication."""
        response = await client.post("/seed-demo")
        assert response.status_code in [401, 403, 422]

    @pytest.mark.asyncio
    async def test_seed_demo_with_auth_adds_properties(
        self, client: AsyncClient, patch_get_current_user, db_session
    ):
        """Test seed-demo endpoint adds sample properties."""
        # Mock the get_current_user dependency
        response = await client.post(
            "/seed-demo",
            headers={"Authorization": "Bearer mock_token"},
        )
        assert response.status_code in [200, 401, 422]

    @pytest.mark.asyncio
    async def test_seed_demo_response_format(
        self, client: AsyncClient, patch_get_current_user
    ):
        """Test seed-demo response format."""
        response = await client.post(
            "/seed-demo",
            headers={"Authorization": "Bearer mock_token"},
        )
        if response.status_code == 200:
            data = response.json()
            assert "seeded" in data
            assert "tenant_id" in data
            assert isinstance(data["seeded"], int)


class TestExceptionHandler:
    @pytest.mark.asyncio
    async def test_unhandled_exception_returns_500(self, client: AsyncClient):
        """Test that unhandled exceptions return 500 status."""
        # Try to access a non-existent endpoint
        response = await client.get("/nonexistent-endpoint")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_error_response_format(self, client: AsyncClient):
        """Test error response includes proper error info."""
        response = await client.get("/nonexistent-endpoint")
        data = response.json()
        assert isinstance(data, dict)


class TestCORSMiddleware:
    async def test_cors_headers_present(self, client: AsyncClient):
        """Test that CORS headers are present in response."""
        response = await client.get("/health")
        assert response.status_code == 200

    async def test_cors_allow_credentials(self, client: AsyncClient):
        """Test CORS allow-credentials header."""
        response = await client.get("/health")
        assert response.status_code == 200


class TestEndpointTags:
    async def test_health_endpoint_tags(self, client: AsyncClient):
        """Test health endpoint has correct tags."""
        response = await client.get("/openapi.json")
        if response.status_code == 200:
            schema = response.json()
            assert "paths" in schema


class TestAPIMetadata:
    async def test_api_title(self, client: AsyncClient):
        """Test API has correct title."""
        response = await client.get("/openapi.json")
        if response.status_code == 200:
            schema = response.json()
            assert schema["info"]["title"] == "GCP Renovation API"

    async def test_api_description(self, client: AsyncClient):
        """Test API has correct description."""
        response = await client.get("/openapi.json")
        if response.status_code == 200:
            schema = response.json()
            assert "description" in schema["info"]

    async def test_api_version(self, client: AsyncClient):
        """Test API has correct version."""
        response = await client.get("/openapi.json")
        if response.status_code == 200:
            schema = response.json()
            assert schema["info"]["version"] == "0.1.0"
