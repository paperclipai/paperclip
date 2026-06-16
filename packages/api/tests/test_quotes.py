"""Integration tests for the quote builder endpoints."""

from __future__ import annotations

import uuid
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Deal,
    PhotoLabel,
    Property,
    PropertyPhotoAnalysis,
    Quote,
    QuoteItem,
    Tenant,
)
from tests.conftest import TENANT_ID, USER_ID


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def tenant(db_session: AsyncSession) -> Tenant:
    t = Tenant(id=TENANT_ID, name="Test Co", slug="test-co", plan="pro")
    db_session.add(t)
    await db_session.flush()
    return t


@pytest_asyncio.fixture
async def property_(db_session: AsyncSession, tenant: Tenant) -> Property:
    p = Property(
        tenant_id=tenant.id,
        address="123 Main St",
        city="Austin",
        state="TX",
        zip="78701",
        property_type="Single Family",
        sqft=1800,
        beds=3,
        baths=2.0,
    )
    db_session.add(p)
    await db_session.flush()
    return p


@pytest_asyncio.fixture
async def deal(db_session: AsyncSession, tenant: Tenant, property_: Property) -> Deal:
    d = Deal(tenant_id=tenant.id, property_id=property_.id, status="active")
    db_session.add(d)
    await db_session.flush()
    return d


@pytest_asyncio.fixture
async def photo_analysis(
    db_session: AsyncSession, property_: Property
) -> PropertyPhotoAnalysis:
    analysis = PropertyPhotoAnalysis(
        property_id=property_.id,
        status="completed",
        photo_count=2,
        model_id="claude-sonnet-4-6-20250514",
        renovation_signal="moderate",
        renovation_confidence=0.85,
    )
    db_session.add(analysis)
    await db_session.flush()

    labels = [
        PhotoLabel(
            analysis_id=analysis.id,
            photo_url="https://example.com/kitchen.jpg",
            photo_index=0,
            room_type="kitchen",
            condition="poor",
            damage_issues=["outdated_fixtures", "damaged_flooring"],
            renovation_needed="major",
            confidence=0.88,
            confidence_tier="high",
            review_status="auto_accepted",
        ),
        PhotoLabel(
            analysis_id=analysis.id,
            photo_url="https://example.com/bathroom.jpg",
            photo_index=1,
            room_type="bathroom",
            condition="fair",
            damage_issues=["peeling_paint"],
            renovation_needed="cosmetic",
            confidence=0.92,
            confidence_tier="high",
            review_status="auto_accepted",
        ),
    ]
    for lbl in labels:
        db_session.add(lbl)
    await db_session.flush()
    return analysis


@pytest_asyncio.fixture
async def quote_with_items(
    db_session: AsyncSession, tenant: Tenant, property_: Property, deal: Deal
) -> Quote:
    q = Quote(
        deal_id=deal.id,
        tenant_id=tenant.id,
        property_id=property_.id,
        status="draft",
        version=1,
        platform_fee_pct=Decimal("0.05"),
    )
    db_session.add(q)
    await db_session.flush()

    items = [
        QuoteItem(
            quote_id=q.id,
            room="Kitchen",
            trade_category="plumbing",
            description="Replace kitchen sink",
            quantity=1,
            unit_cost=Decimal("200.00"),
            labor_cost=Decimal("150.00"),
            subtotal=Decimal("350.00"),
            is_ai_generated=False,
        ),
        QuoteItem(
            quote_id=q.id,
            room="Bathroom",
            trade_category="tile",
            description="Retile floor",
            quantity=50,
            unit_cost=Decimal("8.00"),
            labor_cost=Decimal("300.00"),
            subtotal=Decimal("700.00"),
            is_ai_generated=False,
        ),
    ]
    for item in items:
        db_session.add(item)
    await db_session.flush()

    q.total_material = Decimal("600.00")
    q.total_labor = Decimal("450.00")
    q.platform_fee = Decimal("52.50")
    q.grand_total = Decimal("1102.50")
    await db_session.flush()

    return q


# ---------------------------------------------------------------------------
# POST /properties/{id}/quotes — manual
# ---------------------------------------------------------------------------


class TestCreateQuoteManual:
    async def test_create_empty_manual_quote(
        self, client: AsyncClient, property_: Property, deal: Deal
    ):
        resp = await client.post(
            f"/properties/{property_.id}/quotes",
            json={"mode": "manual", "deal_id": deal.id},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "draft"
        assert data["property_id"] == property_.id
        assert data["deal_id"] == deal.id
        assert data["version"] == 1
        assert data["items"] == []

    async def test_create_manual_with_items(
        self, client: AsyncClient, property_: Property, deal: Deal
    ):
        resp = await client.post(
            f"/properties/{property_.id}/quotes",
            json={
                "mode": "manual",
                "deal_id": deal.id,
                "notes": "Initial estimate",
                "items": [
                    {
                        "room": "Kitchen",
                        "trade_category": "plumbing",
                        "description": "Faucet replacement",
                        "quantity": 1,
                        "unit_cost": "150.00",
                        "labor_cost": "75.00",
                    }
                ],
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["items"][0]["room"] == "Kitchen"
        assert data["notes"] == "Initial estimate"
        assert float(data["grand_total"]) > 0

    async def test_create_auto_creates_deal(
        self, client: AsyncClient, property_: Property
    ):
        resp = await client.post(
            f"/properties/{property_.id}/quotes",
            json={"mode": "manual"},
        )
        assert resp.status_code == 201
        assert resp.json()["deal_id"] is not None

    async def test_create_404_bad_property(self, client: AsyncClient):
        resp = await client.post(
            f"/properties/{uuid.uuid4()}/quotes",
            json={"mode": "manual"},
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /properties/{id}/quotes — AI mode
# ---------------------------------------------------------------------------


class TestCreateQuoteAI:
    async def test_ai_generates_items(
        self,
        client: AsyncClient,
        property_: Property,
        deal: Deal,
        photo_analysis: PropertyPhotoAnalysis,
    ):
        resp = await client.post(
            f"/properties/{property_.id}/quotes",
            json={
                "mode": "ai",
                "deal_id": deal.id,
                "photo_analysis_id": photo_analysis.id,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert len(data["items"]) > 0
        assert data["photo_analysis_id"] == photo_analysis.id
        # All items should be AI generated
        for item in data["items"]:
            assert item["is_ai_generated"] is True
            assert item["ai_confidence"] is not None
        assert float(data["grand_total"]) > 0

    async def test_ai_requires_analysis_id(
        self, client: AsyncClient, property_: Property, deal: Deal
    ):
        resp = await client.post(
            f"/properties/{property_.id}/quotes",
            json={"mode": "ai", "deal_id": deal.id},
        )
        assert resp.status_code == 400

    async def test_ai_404_bad_analysis(
        self, client: AsyncClient, property_: Property, deal: Deal
    ):
        resp = await client.post(
            f"/properties/{property_.id}/quotes",
            json={
                "mode": "ai",
                "deal_id": deal.id,
                "photo_analysis_id": str(uuid.uuid4()),
            },
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /properties/{id}/quotes
# ---------------------------------------------------------------------------


class TestListQuotes:
    async def test_list_quotes(
        self, client: AsyncClient, property_: Property, quote_with_items: Quote
    ):
        resp = await client.get(f"/properties/{property_.id}/quotes")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert len(data["items"]) == 1
        assert data["items"][0]["id"] == quote_with_items.id

    async def test_list_empty(self, client: AsyncClient, property_: Property):
        resp = await client.get(f"/properties/{property_.id}/quotes")
        assert resp.status_code == 200
        assert resp.json()["total"] == 0

    async def test_filter_by_status(
        self, client: AsyncClient, property_: Property, quote_with_items: Quote
    ):
        resp = await client.get(
            f"/properties/{property_.id}/quotes", params={"status": "submitted"}
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 0

        resp = await client.get(
            f"/properties/{property_.id}/quotes", params={"status": "draft"}
        )
        assert resp.json()["total"] == 1


# ---------------------------------------------------------------------------
# GET /quotes/{id}
# ---------------------------------------------------------------------------


class TestGetQuote:
    async def test_get_quote_detail(
        self, client: AsyncClient, quote_with_items: Quote
    ):
        resp = await client.get(f"/quotes/{quote_with_items.id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == quote_with_items.id
        assert len(data["items"]) == 2
        assert data["status"] == "draft"

    async def test_get_404(self, client: AsyncClient, tenant: Tenant):
        resp = await client.get(f"/quotes/{uuid.uuid4()}")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /quotes/{id}
# ---------------------------------------------------------------------------


class TestUpdateQuote:
    async def test_update_status(
        self, client: AsyncClient, quote_with_items: Quote
    ):
        resp = await client.patch(
            f"/quotes/{quote_with_items.id}",
            json={"status": "submitted"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "submitted"

    async def test_add_item(
        self, client: AsyncClient, quote_with_items: Quote
    ):
        resp = await client.patch(
            f"/quotes/{quote_with_items.id}",
            json={
                "add_items": [
                    {
                        "room": "Bedroom",
                        "trade_category": "painting",
                        "description": "Paint walls",
                        "quantity": 1,
                        "unit_cost": "300.00",
                        "labor_cost": "200.00",
                    }
                ]
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 3
        assert data["version"] == 2  # bumped

    async def test_remove_item(
        self, client: AsyncClient, quote_with_items: Quote, db_session: AsyncSession
    ):
        # Get item ID to remove
        resp = await client.get(f"/quotes/{quote_with_items.id}")
        item_id = resp.json()["items"][0]["id"]

        resp = await client.patch(
            f"/quotes/{quote_with_items.id}",
            json={"remove_item_ids": [item_id]},
        )
        assert resp.status_code == 200
        assert len(resp.json()["items"]) == 1
        assert resp.json()["version"] == 2

    async def test_update_item(
        self, client: AsyncClient, quote_with_items: Quote
    ):
        resp = await client.get(f"/quotes/{quote_with_items.id}")
        item_id = resp.json()["items"][0]["id"]

        resp = await client.patch(
            f"/quotes/{quote_with_items.id}",
            json={
                "update_items": {
                    item_id: {"quantity": 5, "unit_cost": "250.00"}
                }
            },
        )
        assert resp.status_code == 200
        updated_item = next(
            i for i in resp.json()["items"] if i["id"] == item_id
        )
        assert updated_item["quantity"] == 5

    async def test_update_notes(
        self, client: AsyncClient, quote_with_items: Quote
    ):
        resp = await client.patch(
            f"/quotes/{quote_with_items.id}",
            json={"notes": "Updated notes"},
        )
        assert resp.status_code == 200
        assert resp.json()["notes"] == "Updated notes"


# ---------------------------------------------------------------------------
# POST /quotes/{id}/generate-sow
# ---------------------------------------------------------------------------


class TestGenerateSOW:
    @patch("app.routers.quotes.upload_sow_to_s3")
    async def test_generate_sow(
        self,
        mock_upload: AsyncMock,
        client: AsyncClient,
        quote_with_items: Quote,
    ):
        mock_upload.return_value = "sow/test/abc123.pdf"

        resp = await client.post(f"/quotes/{quote_with_items.id}/generate-sow")
        assert resp.status_code == 200
        data = resp.json()
        assert data["pdf_s3_key"] == "sow/test/abc123.pdf"
        assert "generated" in data["message"].lower()
        mock_upload.assert_called_once()

    async def test_generate_sow_404(self, client: AsyncClient, tenant: Tenant):
        resp = await client.post(f"/quotes/{uuid.uuid4()}/generate-sow")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /quotes/{id}/sow
# ---------------------------------------------------------------------------


class TestDownloadSOW:
    @patch("app.routers.quotes.download_sow_from_s3")
    async def test_download_sow(
        self,
        mock_download: AsyncMock,
        client: AsyncClient,
        quote_with_items: Quote,
        db_session: AsyncSession,
    ):
        # Set pdf_s3_key on the quote
        quote_with_items.pdf_s3_key = "sow/test/abc123.pdf"
        await db_session.flush()

        mock_download.return_value = b"%PDF-1.4 fake pdf content"

        resp = await client.get(f"/quotes/{quote_with_items.id}/sow")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"
        assert b"%PDF" in resp.content

    async def test_download_sow_no_pdf(
        self, client: AsyncClient, quote_with_items: Quote
    ):
        resp = await client.get(f"/quotes/{quote_with_items.id}/sow")
        assert resp.status_code == 404
        assert "no sow" in resp.json()["detail"].lower()
