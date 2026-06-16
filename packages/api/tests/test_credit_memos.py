"""Integration tests for credit memo endpoints (TDD — written before implementation).

Tests cover:
- Required-field rejection (cause_code / job_key / qc_stage)
- Enum validation for cause_code and qc_stage
- Job# lookup — happy path and miss fallback
- Create with auto-populated fields (job found)
- Create with manual job_key (job not found)
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Deal, Order, OrderLineItem, Property, Quote, QuoteItem
from tests.conftest import TENANT_ID

VALID_PAYLOAD = {
    "cause_code": "MEAS-FAB",
    "job_key": "GCP-001-20240425",
    "qc_stage": "fab",
    "amount": "250.00",
    "description": "Measurement error on slab A",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_order_with_line_item(db_session: AsyncSession) -> Order:
    """Create a complete Order with one line item for lookup tests."""
    property_obj = Property(
        tenant_id=TENANT_ID,
        address="42 Test Ave",
        city="Austin",
        state="TX",
        zip="78701",
    )
    db_session.add(property_obj)
    await db_session.flush()

    deal = Deal(tenant_id=TENANT_ID, property_id=property_obj.id, status="active")
    db_session.add(deal)
    await db_session.flush()

    quote = Quote(
        tenant_id=TENANT_ID,
        deal_id=deal.id,
        property_id=property_obj.id,
        status="approved",
        total_material=Decimal("500.00"),
        total_labor=Decimal("200.00"),
        platform_fee=Decimal("75.00"),
    )
    db_session.add(quote)
    await db_session.flush()

    order = Order(
        tenant_id=TENANT_ID,
        quote_id=quote.id,
        status="submitted",
        sage_order_id="GCP-001-20240425",
        total_amount=Decimal("775.00"),
    )
    db_session.add(order)
    await db_session.flush()

    line_item = OrderLineItem(
        order_id=order.id,
        quote_item_id=None,
        room="Kitchen",
        trade_category="countertop",
        description="Granite countertop",
        sage_sku="SKU-GCT-001",
        quantity=1,
        unit_cost=Decimal("500.00"),
        labor_cost=Decimal("200.00"),
        subtotal=Decimal("700.00"),
        unit_of_measure="each",
    )
    db_session.add(line_item)
    await db_session.commit()
    return order


# ---------------------------------------------------------------------------
# POST /credit-memos — required-field validation
# ---------------------------------------------------------------------------


class TestRequiredFields:
    async def test_missing_cause_code_returns_422(self, client: AsyncClient):
        payload = {k: v for k, v in VALID_PAYLOAD.items() if k != "cause_code"}
        response = await client.post("/credit-memos", json=payload)
        assert response.status_code == 422

    async def test_missing_job_key_returns_422(self, client: AsyncClient):
        payload = {k: v for k, v in VALID_PAYLOAD.items() if k != "job_key"}
        response = await client.post("/credit-memos", json=payload)
        assert response.status_code == 422

    async def test_missing_qc_stage_returns_422(self, client: AsyncClient):
        payload = {k: v for k, v in VALID_PAYLOAD.items() if k != "qc_stage"}
        response = await client.post("/credit-memos", json=payload)
        assert response.status_code == 422

    async def test_empty_job_key_returns_422(self, client: AsyncClient):
        payload = {**VALID_PAYLOAD, "job_key": ""}
        response = await client.post("/credit-memos", json=payload)
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# POST /credit-memos — enum validation
# ---------------------------------------------------------------------------


class TestEnumValidation:
    async def test_invalid_cause_code_returns_422(self, client: AsyncClient):
        payload = {**VALID_PAYLOAD, "cause_code": "TOTALLY-FAKE"}
        response = await client.post("/credit-memos", json=payload)
        assert response.status_code == 422

    async def test_invalid_qc_stage_returns_422(self, client: AsyncClient):
        payload = {**VALID_PAYLOAD, "qc_stage": "not-a-stage"}
        response = await client.post("/credit-memos", json=payload)
        assert response.status_code == 422

    async def test_all_cause_codes_accepted(self, client: AsyncClient):
        valid_codes = [
            "MEAS-FAB", "MEAS-TEMPLATE", "EDGE-CHIP", "POLISH", "CUTOUT",
            "INSTALL-DAMAGE", "HIDDEN-DEFECT", "CLIENT-DAMAGE", "SLAB-DEFECT",
            "DELIVERY-DAMAGE", "OTHER",
        ]
        for code in valid_codes:
            payload = {**VALID_PAYLOAD, "cause_code": code}
            response = await client.post("/credit-memos", json=payload)
            assert response.status_code == 201, f"cause_code={code!r} should be accepted, got {response.status_code}: {response.text}"

    async def test_all_qc_stages_accepted(self, client: AsyncClient):
        valid_stages = ["fab", "pre-ship", "install", "post-install"]
        for stage in valid_stages:
            payload = {**VALID_PAYLOAD, "qc_stage": stage}
            response = await client.post("/credit-memos", json=payload)
            assert response.status_code == 201, f"qc_stage={stage!r} should be accepted, got {response.status_code}: {response.text}"


# ---------------------------------------------------------------------------
# POST /credit-memos — success and optional fields
# ---------------------------------------------------------------------------


class TestCreateCreditMemo:
    async def test_create_success_returns_201(self, client: AsyncClient):
        response = await client.post("/credit-memos", json=VALID_PAYLOAD)
        assert response.status_code == 201
        data = response.json()
        assert data["cause_code"] == "MEAS-FAB"
        assert data["job_key"] == "GCP-001-20240425"
        assert data["qc_stage"] == "fab"
        assert "id" in data
        assert "created_at" in data

    async def test_nullable_fields_absent_succeeds(self, client: AsyncClient):
        minimal = {
            "cause_code": "OTHER",
            "job_key": "MANUAL-JOB-999",
            "qc_stage": "install",
        }
        response = await client.post("/credit-memos", json=minimal)
        assert response.status_code == 201
        data = response.json()
        assert data["rsm_id"] is None
        assert data["territory_id"] is None
        assert data["product_tier"] is None

    async def test_nullable_fields_stored_when_provided(self, client: AsyncClient):
        payload = {
            **VALID_PAYLOAD,
            "rsm_id": "RSM-42",
            "territory_id": "TERR-SW",
            "product_tier": "countertop",
        }
        response = await client.post("/credit-memos", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["rsm_id"] == "RSM-42"
        assert data["territory_id"] == "TERR-SW"
        assert data["product_tier"] == "countertop"


# ---------------------------------------------------------------------------
# GET /credit-memos/job-lookup — auto-population source
# ---------------------------------------------------------------------------


class TestJobLookup:
    async def test_lookup_hit_returns_order_data(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        await _make_order_with_line_item(db_session)

        response = await client.get("/credit-memos/job-lookup?job_number=GCP-001-20240425")
        assert response.status_code == 200
        data = response.json()
        assert data["found"] is True
        assert data["job_key"] == "GCP-001-20240425"
        assert data["product_tier"] == "countertop"

    async def test_lookup_miss_returns_not_found(self, client: AsyncClient):
        response = await client.get("/credit-memos/job-lookup?job_number=DOES-NOT-EXIST")
        assert response.status_code == 200
        data = response.json()
        assert data["found"] is False
        assert data["job_key"] is None
        assert data["product_tier"] is None

    async def test_lookup_missing_query_param_returns_422(self, client: AsyncClient):
        response = await client.get("/credit-memos/job-lookup")
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Auto-population integration: lookup then submit
# ---------------------------------------------------------------------------


class TestAutoPopulationFlow:
    async def test_submit_after_lookup_populates_product_tier(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Simulate the UI flow: lookup → get product_tier → submit with it."""
        await _make_order_with_line_item(db_session)

        lookup = await client.get("/credit-memos/job-lookup?job_number=GCP-001-20240425")
        assert lookup.json()["found"] is True
        auto_data = lookup.json()

        payload = {
            "cause_code": "EDGE-CHIP",
            "job_key": auto_data["job_key"],
            "qc_stage": "pre-ship",
            "product_tier": auto_data["product_tier"],
        }
        create = await client.post("/credit-memos", json=payload)
        assert create.status_code == 201
        data = create.json()
        assert data["job_key"] == "GCP-001-20240425"
        assert data["product_tier"] == "countertop"

    async def test_manual_fallback_when_lookup_misses(self, client: AsyncClient):
        """Manual job_key entry must work when no Order matches the job number."""
        payload = {
            "cause_code": "POLISH",
            "job_key": "LEGACY-JOB-2023-XYZ",
            "qc_stage": "post-install",
            "product_tier": "flooring",
        }
        response = await client.post("/credit-memos", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["job_key"] == "LEGACY-JOB-2023-XYZ"
        assert data["product_tier"] == "flooring"


# ---------------------------------------------------------------------------
# GET /credit-memos — list
# ---------------------------------------------------------------------------


class TestListCreditMemos:
    async def test_list_empty(self, client: AsyncClient):
        response = await client.get("/credit-memos")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 0
        assert data["items"] == []

    async def test_list_returns_created_memos(self, client: AsyncClient):
        await client.post("/credit-memos", json=VALID_PAYLOAD)
        await client.post(
            "/credit-memos",
            json={**VALID_PAYLOAD, "cause_code": "POLISH", "qc_stage": "install"},
        )

        response = await client.get("/credit-memos")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2
        assert len(data["items"]) == 2
