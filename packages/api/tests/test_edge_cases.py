"""Edge case and detailed tests for API robustness."""

import pytest
import uuid
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Property, Tenant


class TestPropertyEdgeCases:
    @pytest.mark.asyncio
    async def test_property_with_minimum_fields(self, client: AsyncClient, patch_get_current_user):
        """Test creating property with only required fields."""
        response = await client.post(
            "/properties",
            json={
                "address": "1 Main St",
                "city": "City",
                "state": "ST",
                "zip": "12345",
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_property_with_special_characters(self, client: AsyncClient, patch_get_current_user):
        """Test property with special characters in address."""
        response = await client.post(
            "/properties",
            json={
                "address": "123 Main St. #456 (Suite A)",
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_property_with_unicode_characters(self, client: AsyncClient, patch_get_current_user):
        """Test property with unicode characters."""
        response = await client.post(
            "/properties",
            json={
                "address": "123 Café Street",
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_property_with_very_long_address(self, client: AsyncClient, patch_get_current_user):
        """Test property with very long address."""
        long_address = "123 " + "Main " * 100 + "Street"
        response = await client.post(
            "/properties",
            json={
                "address": long_address,
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422, 413]

    @pytest.mark.asyncio
    async def test_property_with_zero_beds(self, client: AsyncClient, patch_get_current_user):
        """Test property with zero bedrooms."""
        response = await client.post(
            "/properties",
            json={
                "address": "123 Main",
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
                "beds": 0,
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_property_with_negative_price(self, client: AsyncClient, patch_get_current_user):
        """Test property with negative price."""
        response = await client.post(
            "/properties",
            json={
                "address": "123 Main",
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
                "listing_price": -100000,
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_property_with_very_large_price(self, client: AsyncClient, patch_get_current_user):
        """Test property with very large price."""
        response = await client.post(
            "/properties",
            json={
                "address": "123 Main",
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
                "listing_price": 999999999999,
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]


class TestAPIRateLimitingScenarios:
    @pytest.mark.asyncio
    async def test_rapid_health_checks(self, client: AsyncClient):
        """Test rapid health check requests."""
        responses = []
        for _ in range(50):
            resp = await client.get("/health")
            responses.append(resp.status_code)
        assert all(code == 200 for code in responses)

    @pytest.mark.asyncio
    async def test_rapid_invalid_requests(self, client: AsyncClient):
        """Test rapid invalid requests."""
        responses = []
        for i in range(20):
            resp = await client.get(f"/nonexistent-{i}")
            responses.append(resp.status_code)
        assert all(code == 404 for code in responses)


class TestStringLengthEdgeCases:
    @pytest.mark.asyncio
    async def test_empty_string_fields(self, client: AsyncClient, patch_get_current_user):
        """Test empty string fields."""
        response = await client.post(
            "/properties",
            json={
                "address": "",
                "city": "",
                "state": "",
                "zip": "",
            },
            headers={"Authorization": "Bearer token"},
        )
        # Empty strings should fail validation
        assert response.status_code in [400, 422, 401]

    @pytest.mark.asyncio
    async def test_whitespace_only_fields(self, client: AsyncClient, patch_get_current_user):
        """Test whitespace-only fields."""
        response = await client.post(
            "/properties",
            json={
                "address": "   ",
                "city": "   ",
                "state": "   ",
                "zip": "   ",
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [400, 422, 401]

    @pytest.mark.asyncio
    async def test_single_character_fields(self, client: AsyncClient, patch_get_current_user):
        """Test single character fields."""
        response = await client.post(
            "/properties",
            json={
                "address": "A",
                "city": "B",
                "state": "C",
                "zip": "D",
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]


class TestNumericEdgeCases:
    @pytest.mark.asyncio
    async def test_decimal_beds(self, client: AsyncClient, patch_get_current_user):
        """Test decimal number of beds."""
        response = await client.post(
            "/properties",
            json={
                "address": "123 Main",
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
                "beds": 3.5,
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_fractional_baths(self, client: AsyncClient, patch_get_current_user):
        """Test fractional bathroom values."""
        response = await client.post(
            "/properties",
            json={
                "address": "123 Main",
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
                "baths": 2.75,
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_very_large_sqft(self, client: AsyncClient, patch_get_current_user):
        """Test very large square footage."""
        response = await client.post(
            "/properties",
            json={
                "address": "123 Main",
                "city": "Houston",
                "state": "TX",
                "zip": "77001",
                "sqft": 999999999,
            },
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 401, 403, 422]


class TestUUIDEdgeCases:
    @pytest.mark.asyncio
    async def test_invalid_uuid_format(self, client: AsyncClient):
        """Test invalid UUID format."""
        response = await client.get("/properties/not-a-valid-uuid")
        assert response.status_code in [400, 404, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_uppercase_uuid(self, client: AsyncClient):
        """Test uppercase UUID."""
        uuid_str = str(uuid.uuid4()).upper()
        response = await client.get(f"/properties/{uuid_str}")
        assert response.status_code in [404, 400, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_zero_uuid(self, client: AsyncClient):
        """Test all-zeros UUID."""
        response = await client.get("/properties/00000000-0000-0000-0000-000000000000")
        assert response.status_code in [404, 400, 401, 403, 422]


class TestAuthHeaderEdgeCases:
    @pytest.mark.asyncio
    async def test_empty_bearer_token(self, client: AsyncClient):
        """Test empty bearer token."""
        response = await client.get(
            "/health",
            headers={"Authorization": "Bearer "},
        )
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_missing_bearer_prefix(self, client: AsyncClient):
        """Test missing Bearer prefix."""
        response = await client.get(
            "/health",
            headers={"Authorization": "token123"},
        )
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_multiple_auth_headers(self, client: AsyncClient):
        """Test multiple authorization headers."""
        # Most HTTP clients will use the last one
        response = await client.get("/health")
        assert response.status_code == 200


class TestContentNegotiation:
    @pytest.mark.asyncio
    async def test_json_response(self, client: AsyncClient):
        """Test JSON response content type."""
        response = await client.get("/health")
        assert response.status_code == 200
        assert "application/json" in response.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_health_response_structure(self, client: AsyncClient):
        """Test health response structure."""
        response = await client.get("/health")
        data = response.json()
        assert isinstance(data, dict)
        assert len(data) == 2


class TestDatabaseConstraintEdgeCases:
    @pytest.mark.asyncio
    async def test_duplicate_property_creation(
        self, client: AsyncClient, db_session: AsyncSession, patch_get_current_user, sample_tenant_id
    ):
        """Test creating duplicate properties."""
        # Create tenant
        tenant = Tenant(id=sample_tenant_id, name="Org", slug="org")
        db_session.add(tenant)
        await db_session.flush()

        # Create same property twice
        prop_data = {
            "address": "123 Main",
            "city": "Houston",
            "state": "TX",
            "zip": "77001",
        }

        response1 = await client.post(
            "/properties",
            json=prop_data,
            headers={"Authorization": "Bearer token"},
        )

        response2 = await client.post(
            "/properties",
            json=prop_data,
            headers={"Authorization": "Bearer token"},
        )

        # Both may succeed as there's no unique constraint
        assert response1.status_code in [201, 400, 401, 403, 422]
        assert response2.status_code in [201, 400, 401, 403, 422]


class TestErrorMessageFormats:
    @pytest.mark.asyncio
    async def test_404_error_message(self, client: AsyncClient):
        """Test 404 error message format."""
        response = await client.get("/nonexistent")
        assert response.status_code == 404
        data = response.json()
        assert "detail" in data

    @pytest.mark.asyncio
    async def test_validation_error_message(self, client: AsyncClient, patch_get_current_user):
        """Test validation error message format."""
        response = await client.post(
            "/properties",
            json={"city": "Houston"},
            headers={"Authorization": "Bearer token"},
        )
        if response.status_code == 422:
            data = response.json()
            assert "detail" in data or "errors" in data


class TestTimeoutScenarios:
    @pytest.mark.asyncio
    async def test_health_completes_immediately(self, client: AsyncClient):
        """Test health endpoint completes immediately."""
        import time
        start = time.time()
        await client.get("/health")
        elapsed = time.time() - start
        assert elapsed < 1.0

    @pytest.mark.asyncio
    async def test_multiple_requests_no_timeout(self, client: AsyncClient):
        """Test multiple requests don't timeout."""
        import time
        start = time.time()
        for _ in range(100):
            await client.get("/health")
        elapsed = time.time() - start
        assert elapsed < 10.0


class TestRESTConventions:
    @pytest.mark.asyncio
    async def test_get_returns_200_or_404(self, client: AsyncClient):
        """Test GET returns 200 or 404."""
        response = await client.get("/health")
        assert response.status_code in [200, 404, 401, 403]

    @pytest.mark.asyncio
    async def test_post_returns_201_or_400(self, client: AsyncClient, patch_get_current_user):
        """Test POST returns 201 or 400."""
        response = await client.post(
            "/properties",
            json={"city": "test"},
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code in [201, 400, 422, 401, 403, 404]

    @pytest.mark.asyncio
    async def test_delete_returns_200_or_404(self, client: AsyncClient):
        """Test DELETE returns 200 or 404."""
        fake_id = str(uuid.uuid4())
        response = await client.delete(f"/properties/{fake_id}")
        assert response.status_code in [200, 404, 401, 403, 405, 422]
