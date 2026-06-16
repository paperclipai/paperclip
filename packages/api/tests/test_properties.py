"""Tests for property endpoints."""

from __future__ import annotations

from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.auth import CurrentUser, get_current_user
from app.database import get_db
from app.main import app
from tests.conftest import TENANT_ID, USER_ID

pytestmark = pytest.mark.anyio


# ---------------------------------------------------------------------------
# Manual CRUD
# ---------------------------------------------------------------------------


VALID_PROPERTY = {
    "address": "123 Main St",
    "city": "Austin",
    "state": "TX",
    "zip": "78701",
    "beds": 3,
    "baths": 2.0,
    "sqft": 1800,
    "year_built": 2005,
    "listing_price": 450000,
    "property_type": "single_family",
}


async def test_create_property(client: AsyncClient) -> None:
    resp = await client.post("/properties", json=VALID_PROPERTY)
    assert resp.status_code == 201
    data = resp.json()
    assert data["address"] == "123 Main St"
    assert data["city"] == "Austin"
    assert data["data_source"] == "manual"
    assert data["tenant_id"] == TENANT_ID
    assert data["status"] == "active"
    assert data["id"]


async def test_create_property_validation_error(client: AsyncClient) -> None:
    """Missing required fields should fail."""
    resp = await client.post("/properties", json={"address": "123 Main St"})
    assert resp.status_code == 422


async def test_get_property(client: AsyncClient) -> None:
    # Create first
    create_resp = await client.post("/properties", json=VALID_PROPERTY)
    prop_id = create_resp.json()["id"]

    resp = await client.get(f"/properties/{prop_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == prop_id


async def test_get_property_not_found(client: AsyncClient) -> None:
    resp = await client.get("/properties/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


async def test_update_property(client: AsyncClient) -> None:
    create_resp = await client.post("/properties", json=VALID_PROPERTY)
    prop_id = create_resp.json()["id"]

    resp = await client.patch(f"/properties/{prop_id}", json={"beds": 4, "listing_price": 500000})
    assert resp.status_code == 200
    data = resp.json()
    assert data["beds"] == 4
    assert data["listing_price"] == 500000.0


# ---------------------------------------------------------------------------
# Listing Feed
# ---------------------------------------------------------------------------


async def test_list_properties_empty(client: AsyncClient) -> None:
    resp = await client.get("/properties")
    assert resp.status_code == 200
    data = resp.json()
    assert data["items"] == []
    assert data["total"] == 0
    assert data["page"] == 1


async def test_list_properties_with_data(client: AsyncClient) -> None:
    # Create two properties
    await client.post("/properties", json=VALID_PROPERTY)
    second = {**VALID_PROPERTY, "address": "456 Oak Ave", "city": "Dallas", "listing_price": 350000}
    await client.post("/properties", json=second)

    resp = await client.get("/properties")
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2


async def test_list_properties_filter_by_city(client: AsyncClient) -> None:
    await client.post("/properties", json=VALID_PROPERTY)
    second = {**VALID_PROPERTY, "address": "456 Oak Ave", "city": "Dallas"}
    await client.post("/properties", json=second)

    resp = await client.get("/properties", params={"city": "Austin"})
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["city"] == "Austin"


async def test_list_properties_filter_by_price_range(client: AsyncClient) -> None:
    await client.post("/properties", json=VALID_PROPERTY)  # 450k
    cheap = {**VALID_PROPERTY, "address": "789 Elm", "listing_price": 200000}
    await client.post("/properties", json=cheap)

    resp = await client.get("/properties", params={"min_price": 300000, "max_price": 500000})
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["listing_price"] == 450000.0


async def test_list_properties_pagination(client: AsyncClient) -> None:
    for i in range(5):
        await client.post(
            "/properties",
            json={**VALID_PROPERTY, "address": f"{i} Test St"},
        )

    resp = await client.get("/properties", params={"page": 1, "page_size": 2})
    data = resp.json()
    assert data["total"] == 5
    assert len(data["items"]) == 2
    assert data["pages"] == 3

    resp2 = await client.get("/properties", params={"page": 3, "page_size": 2})
    data2 = resp2.json()
    assert len(data2["items"]) == 1


async def test_list_properties_sort_by_price_asc(client: AsyncClient) -> None:
    await client.post("/properties", json={**VALID_PROPERTY, "address": "A St", "listing_price": 500000})
    await client.post("/properties", json={**VALID_PROPERTY, "address": "B St", "listing_price": 200000})

    resp = await client.get("/properties", params={"sort_by": "listing_price", "sort_order": "asc"})
    items = resp.json()["items"]
    assert items[0]["listing_price"] == 200000.0
    assert items[1]["listing_price"] == 500000.0


# ---------------------------------------------------------------------------
# Zillow URL validation
# ---------------------------------------------------------------------------


async def test_zillow_import_invalid_url(client: AsyncClient) -> None:
    resp = await client.post("/properties/import/zillow", json={"url": "https://example.com/not-zillow"})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# PropStream search validation
# ---------------------------------------------------------------------------


async def test_propstream_search_no_params(client: AsyncClient) -> None:
    resp = await client.post("/properties/search/propstream", json={})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Google Places
# ---------------------------------------------------------------------------


async def test_places_autocomplete_empty_input(client: AsyncClient) -> None:
    resp = await client.post("/properties/places/autocomplete", json={"input": ""})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Sprint 1.1 — Foundation QA
# ---------------------------------------------------------------------------


async def test_health_endpoint(client: AsyncClient) -> None:
    """GET /health returns 200 with expected payload."""
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "gcp-renovation-api"


@pytest_asyncio.fixture
async def solo_client(db_session) -> AsyncGenerator[AsyncClient, None]:
    """Client whose user has no Clerk org (tenant_id=None) — exercises auto-provisioning."""
    def _solo_user() -> CurrentUser:
        return CurrentUser(user_id=USER_ID, tenant_id=None, claims={})

    async def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = _solo_user

    transport = ASGITransport(app=app)  # type: ignore[arg-type]
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


async def test_solo_user_create_property_provisions_tenant(solo_client: AsyncClient) -> None:
    """Solo users (no Clerk org) must be able to create properties without a 500.

    Regression test for: effective_tenant_id UUID5 not in tenants table → FK violation.
    """
    resp = await solo_client.post("/properties", json=VALID_PROPERTY)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["address"] == "123 Main St"


async def test_seed_demo_provisions_tenant_and_returns_seeded_count(solo_client: AsyncClient) -> None:
    """POST /seed-demo must succeed for solo users and auto-provision their tenant.

    Regression test for: seed-demo calling effective_tenant_id → FK violation on insert.
    """
    resp = await solo_client.post("/seed-demo")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["seeded"] == 3

    # Second call must be idempotent (skips existing rows)
    resp2 = await solo_client.post("/seed-demo")
    assert resp2.status_code == 200
    assert resp2.json()["seeded"] == 0


async def test_db_tables_created_from_scratch(client: AsyncClient) -> None:
    """The test fixture creates all tables from scratch (simulates migration).

    Verify the property CRUD works end-to-end after fresh schema creation.
    """
    resp = await client.post("/properties", json=VALID_PROPERTY)
    assert resp.status_code == 201
    prop_id = resp.json()["id"]
    resp2 = await client.get(f"/properties/{prop_id}")
    assert resp2.status_code == 200
    assert resp2.json()["id"] == prop_id
