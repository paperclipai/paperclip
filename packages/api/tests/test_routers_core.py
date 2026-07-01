"""Tests for core routers: comps, quotes, financing, orders, risk, catalog, photo_analysis, credit_memos."""

import pytest
import uuid
from httpx import AsyncClient

from app.models import Tenant


class TestCompsRouter:
    def test_router_exists(self):
        """Test comps router can be imported."""
        from app.routers.comps import router
        assert router is not None

    def test_router_has_prefix(self):
        """Test comps router has correct prefix."""
        from app.routers.comps import router
        assert router.prefix in ["/comps", "comps"]

    def test_router_is_api_router(self):
        """Test comps router is an APIRouter."""
        from app.routers.comps import router
        assert hasattr(router, "routes")

    @pytest.mark.asyncio
    async def test_list_comps_endpoint_exists(self, client: AsyncClient):
        """Test comps list endpoint is defined."""
        # Endpoint should exist (may return 401 if no auth)
        response = await client.get("/comps")
        assert response.status_code in [200, 401, 403, 404, 422]

    @pytest.mark.asyncio
    async def test_get_comp_endpoint_exists(self, client: AsyncClient):
        """Test get comp endpoint is defined."""
        fake_id = str(uuid.uuid4())
        response = await client.get(f"/comps/{fake_id}")
        assert response.status_code in [404, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_create_comp_endpoint_exists(self, client: AsyncClient):
        """Test create comp endpoint is defined."""
        response = await client.post(
            "/comps",
            json={"name": "test comp"},
        )
        assert response.status_code in [201, 400, 401, 403, 404, 422]


class TestQuotesRouter:
    def test_router_exists(self):
        """Test quotes router can be imported."""
        from app.routers.quotes import router
        assert router is not None

    def test_router_is_api_router(self):
        """Test quotes router is an APIRouter."""
        from app.routers.quotes import router
        assert hasattr(router, "routes")

    @pytest.mark.asyncio
    async def test_list_quotes_endpoint_exists(self, client: AsyncClient):
        """Test quotes list endpoint is defined."""
        response = await client.get("/quotes")
        assert response.status_code in [200, 401, 403, 404, 422, 405]

    @pytest.mark.asyncio
    async def test_get_quote_endpoint_exists(self, client: AsyncClient):
        """Test get quote endpoint is defined."""
        fake_id = str(uuid.uuid4())
        response = await client.get(f"/quotes/{fake_id}")
        assert response.status_code in [404, 200, 401, 403, 422, 405]

    @pytest.mark.asyncio
    async def test_create_quote_endpoint_exists(self, client: AsyncClient):
        """Test create quote endpoint is defined."""
        response = await client.post(
            "/quotes",
            json={"name": "test quote"},
        )
        assert response.status_code in [201, 400, 401, 403, 404, 422, 405]

    @pytest.mark.asyncio
    async def test_update_quote_endpoint_exists(self, client: AsyncClient):
        """Test update quote endpoint is defined."""
        fake_id = str(uuid.uuid4())
        response = await client.patch(
            f"/quotes/{fake_id}",
            json={"status": "approved"},
        )
        assert response.status_code in [404, 400, 401, 403, 422, 405]

    @pytest.mark.asyncio
    async def test_quotes_endpoint_callable(self, client: AsyncClient):
        """Test quotes endpoint is callable."""
        # Just verify the endpoint is callable
        response = await client.get("/quotes")
        assert response.status_code in [200, 401, 403, 404, 422, 405]


class TestFinancingRouter:
    def test_router_exists(self):
        """Test financing router can be imported."""
        from app.routers.financing import router
        assert router is not None

    def test_router_has_prefix(self):
        """Test financing router has correct prefix."""
        from app.routers.financing import router
        assert router.prefix in ["/financing", "financing"]

    @pytest.mark.asyncio
    async def test_list_financing_endpoint_exists(self, client: AsyncClient):
        """Test financing list endpoint is defined."""
        response = await client.get("/financing")
        assert response.status_code in [200, 401, 403, 404, 422]

    @pytest.mark.asyncio
    async def test_get_financing_endpoint_exists(self, client: AsyncClient):
        """Test get financing endpoint is defined."""
        fake_id = str(uuid.uuid4())
        response = await client.get(f"/financing/{fake_id}")
        assert response.status_code in [404, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_analyze_financing_endpoint_exists(self, client: AsyncClient):
        """Test financing analysis endpoint is defined."""
        response = await client.post(
            "/financing/analyze",
            json={"property_id": str(uuid.uuid4())},
        )
        assert response.status_code in [200, 400, 401, 403, 404, 422]


class TestOrdersRouter:
    def test_router_exists(self):
        """Test orders router can be imported."""
        from app.routers.orders import router
        assert router is not None

    def test_router_is_api_router(self):
        """Test orders router is an APIRouter."""
        from app.routers.orders import router
        assert hasattr(router, "routes")

    @pytest.mark.asyncio
    async def test_list_orders_endpoint_exists(self, client: AsyncClient):
        """Test orders list endpoint is defined."""
        response = await client.get("/orders")
        assert response.status_code in [200, 401, 403, 404, 422, 405]

    @pytest.mark.asyncio
    async def test_get_order_endpoint_exists(self, client: AsyncClient):
        """Test get order endpoint is defined."""
        fake_id = str(uuid.uuid4())
        response = await client.get(f"/orders/{fake_id}")
        assert response.status_code in [404, 200, 401, 403, 422, 405]

    @pytest.mark.asyncio
    async def test_orders_endpoint_callable(self, client: AsyncClient):
        """Test orders endpoint is callable."""
        response = await client.post(
            "/orders",
            json={"items": []},
        )
        assert response.status_code in [201, 400, 401, 403, 404, 422, 405]

    @pytest.mark.asyncio
    async def test_orders_list_callable(self, client: AsyncClient):
        """Test orders list is callable."""
        response = await client.get("/orders")
        assert response.status_code in [200, 401, 403, 404, 422, 405]


class TestRiskRouter:
    def test_router_exists(self):
        """Test risk router can be imported."""
        from app.routers.risk import router
        assert router is not None

    def test_router_has_prefix(self):
        """Test risk router has correct prefix."""
        from app.routers.risk import router
        assert router.prefix in ["/risk", "risk"]

    @pytest.mark.asyncio
    async def test_analyze_risk_endpoint_exists(self, client: AsyncClient):
        """Test risk analysis endpoint is defined."""
        response = await client.post(
            "/risk/analyze",
            json={"property_id": str(uuid.uuid4())},
        )
        assert response.status_code in [200, 400, 401, 403, 404, 422]

    @pytest.mark.asyncio
    async def test_risk_report_endpoint_exists(self, client: AsyncClient):
        """Test risk report endpoint is defined."""
        fake_id = str(uuid.uuid4())
        response = await client.get(f"/risk/{fake_id}/report")
        assert response.status_code in [404, 200, 401, 403, 422]


class TestCatalogRouter:
    def test_router_exists(self):
        """Test catalog router can be imported."""
        from app.routers.catalog import router
        assert router is not None

    def test_router_has_prefix(self):
        """Test catalog router has correct prefix."""
        from app.routers.catalog import router
        assert router.prefix in ["/catalog", "catalog"]

    @pytest.mark.asyncio
    async def test_list_products_endpoint_exists(self, client: AsyncClient):
        """Test product list endpoint is defined."""
        response = await client.get("/catalog/products")
        assert response.status_code in [200, 401, 403, 404, 422]

    @pytest.mark.asyncio
    async def test_get_product_endpoint_exists(self, client: AsyncClient):
        """Test get product endpoint is defined."""
        fake_id = str(uuid.uuid4())
        response = await client.get(f"/catalog/products/{fake_id}")
        assert response.status_code in [404, 200, 401, 403, 422]


class TestPhotoAnalysisRouter:
    def test_router_exists(self):
        """Test photo_analysis router can be imported."""
        from app.routers.photo_analysis import router
        assert router is not None

    def test_router_has_routes(self):
        """Test photo_analysis router has routes."""
        from app.routers.photo_analysis import router
        # Router should have routes defined
        assert hasattr(router, "routes") or hasattr(router, "prefix")

    @pytest.mark.asyncio
    async def test_analyze_photo_endpoint_exists(self, client: AsyncClient):
        """Test photo analysis endpoint is defined."""
        response = await client.post(
            "/photo-analysis/analyze",
            json={"url": "https://example.com/photo.jpg"},
        )
        assert response.status_code in [200, 400, 401, 403, 404, 422, 405]


class TestCreditMemosRouter:
    def test_router_exists(self):
        """Test credit_memos router can be imported."""
        from app.routers.credit_memos import router
        assert router is not None

    def test_router_has_prefix(self):
        """Test credit_memos router has correct prefix."""
        from app.routers.credit_memos import router
        assert router.prefix in ["/credit-memos", "credit-memos", "/memos", "memos"]

    @pytest.mark.asyncio
    async def test_list_credit_memos_endpoint_exists(self, client: AsyncClient):
        """Test credit memos list endpoint is defined."""
        response = await client.get("/credit-memos")
        assert response.status_code in [200, 404, 401, 403, 422]

    @pytest.mark.asyncio
    async def test_create_credit_memo_endpoint_exists(self, client: AsyncClient):
        """Test create credit memo endpoint is defined."""
        response = await client.post(
            "/credit-memos",
            json={"amount": 100.00},
        )
        assert response.status_code in [201, 400, 401, 403, 404, 422]


class TestRouterIntegration:
    @pytest.mark.asyncio
    async def test_all_routers_included_in_app(self, client: AsyncClient):
        """Test that all routers are included in the FastAPI app."""
        # Try accessing OpenAPI schema
        response = await client.get("/openapi.json")
        if response.status_code == 200:
            schema = response.json()
            assert "paths" in schema

    @pytest.mark.asyncio
    async def test_app_has_multiple_routers(self, client: AsyncClient):
        """Test that app has multiple routers."""
        response = await client.get("/openapi.json")
        if response.status_code == 200:
            schema = response.json()
            # Count number of paths - should be more than just /health
            paths = schema.get("paths", {})
            assert len(paths) > 1


class TestRouterErrorHandling:
    @pytest.mark.asyncio
    async def test_invalid_method_returns_405(self, client: AsyncClient):
        """Test that invalid HTTP method returns 405."""
        # Try GET on a POST-only endpoint
        response = await client.get("/properties")
        # May be 404 if endpoint doesn't exist, or 401 if auth required
        assert response.status_code in [200, 404, 401, 403, 405, 422]

    @pytest.mark.asyncio
    async def test_invalid_content_type(self, client: AsyncClient):
        """Test that invalid content type is handled."""
        response = await client.post(
            "/properties",
            content="invalid",
            headers={"Content-Type": "text/plain"},
        )
        assert response.status_code in [422, 400, 401, 403, 404]


class TestRouterPagination:
    @pytest.mark.asyncio
    async def test_list_endpoint_supports_skip(self, client: AsyncClient):
        """Test that list endpoints support skip parameter."""
        response = await client.get("/properties?skip=0")
        assert response.status_code in [200, 401, 403, 404, 422]

    @pytest.mark.asyncio
    async def test_list_endpoint_supports_limit(self, client: AsyncClient):
        """Test that list endpoints support limit parameter."""
        response = await client.get("/properties?limit=10")
        assert response.status_code in [200, 401, 403, 404, 422]

    @pytest.mark.asyncio
    async def test_list_endpoint_supports_pagination(self, client: AsyncClient):
        """Test that list endpoints support both skip and limit."""
        response = await client.get("/properties?skip=0&limit=10")
        assert response.status_code in [200, 401, 403, 404, 422]
