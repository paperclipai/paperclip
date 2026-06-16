"""Tests for the risk flag system — year flags, FEMA, lendability, router."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ARVCalculation, Property, RiskFlag, Tenant
from app.services.lendability import calculate_lendability
from app.services.risk_flags import evaluate_year_flags
from tests.conftest import TENANT_ID, USER_ID


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


VALID_PROPERTY = {
    "address": "123 Main St",
    "city": "Tampa",
    "state": "FL",
    "zip": "33602",
    "lat": 27.9506,
    "lng": -82.4572,
    "year_built": 1960,
    "sqft": 1800,
    "beds": 3,
    "baths": 2.0,
    "listing_price": 200000,
}


async def _create_tenant_and_property(
    db: AsyncSession,
    *,
    year_built: int | None = 1960,
    lat: float | None = 27.9506,
    lng: float | None = -82.4572,
    listing_price: float | None = 200000,
) -> Property:
    tenant = Tenant(id=TENANT_ID, name="Test Co", slug="test-co", plan="free")
    db.add(tenant)
    await db.flush()

    prop = Property(
        tenant_id=TENANT_ID,
        address="123 Main St",
        city="Tampa",
        state="FL",
        zip="33602",
        lat=lat,
        lng=lng,
        year_built=year_built,
        sqft=1800,
        beds=3,
        baths=2.0,
        listing_price=listing_price,
    )
    db.add(prop)
    await db.flush()
    await db.refresh(prop)
    return prop


# ===========================================================================
# Unit tests — Year-based risk flags
# ===========================================================================


class TestYearFlags:
    def test_old_property_triggers_all_flags(self):
        """Property built 1960 triggers all 5 year-based flags."""
        flags = evaluate_year_flags(1960)
        assert len(flags) == 5
        types = {f["flag_type"] for f in flags}
        assert types == {
            "knob_and_tube_wiring",
            "lead_paint",
            "asbestos",
            "polybutylene_plumbing",
            "cast_iron_drains",
        }
        assert all(f["source"] == "year_built" for f in flags)

    def test_1990_property_triggers_two_flags(self):
        """Property built 1990 triggers polybutylene + cast iron only."""
        flags = evaluate_year_flags(1990)
        assert len(flags) == 2
        types = {f["flag_type"] for f in flags}
        assert types == {"polybutylene_plumbing", "cast_iron_drains"}

    def test_modern_property_no_flags(self):
        """Property built 2005 triggers no year-based flags."""
        flags = evaluate_year_flags(2005)
        assert len(flags) == 0

    def test_none_year_built_returns_advisory(self):
        """None year_built returns single unknown_year advisory flag."""
        flags = evaluate_year_flags(None)
        assert len(flags) == 1
        assert flags[0]["flag_type"] == "unknown_year"
        assert flags[0]["severity"] == "low"

    def test_boundary_1978_no_lead_flag(self):
        """Property built in 1978 should NOT trigger lead paint (pre-1978 only)."""
        flags = evaluate_year_flags(1978)
        types = {f["flag_type"] for f in flags}
        assert "lead_paint" not in types

    def test_boundary_1977_has_lead_flag(self):
        """Property built 1977 triggers lead paint."""
        flags = evaluate_year_flags(1977)
        types = {f["flag_type"] for f in flags}
        assert "lead_paint" in types

    # --- Additional boundary year tests per QA checklist ---

    def test_boundary_1950_triggers_all_five(self):
        """1950 < all thresholds → all 5 year flags."""
        flags = evaluate_year_flags(1950)
        assert len(flags) == 5

    def test_boundary_1949_triggers_all_five(self):
        """1949 < all thresholds → all 5 year flags."""
        flags = evaluate_year_flags(1949)
        assert len(flags) == 5

    def test_boundary_1960_triggers_four(self):
        """1960 < 1965 (knob_and_tube), 1978, 1985, 1994, 2000 → 5 flags."""
        flags = evaluate_year_flags(1960)
        assert len(flags) == 5

    def test_boundary_1959_triggers_five(self):
        """1959 < all thresholds → 5 flags."""
        flags = evaluate_year_flags(1959)
        assert len(flags) == 5

    def test_boundary_1965_no_knob_and_tube(self):
        """1965 is NOT < 1965, so no knob_and_tube. Still has 4 other flags."""
        flags = evaluate_year_flags(1965)
        types = {f["flag_type"] for f in flags}
        assert "knob_and_tube_wiring" not in types
        assert len(flags) == 4

    def test_boundary_1973_has_lead_and_asbestos(self):
        """1973 < 1978, 1985, 1994, 2000 → 4 flags (no knob_and_tube)."""
        flags = evaluate_year_flags(1973)
        types = {f["flag_type"] for f in flags}
        assert "lead_paint" in types
        assert "asbestos" in types
        assert "knob_and_tube_wiring" not in types
        assert len(flags) == 4

    def test_boundary_1980_no_lead(self):
        """1980 >= 1978 → no lead. Still < 1985, 1994, 2000 → 3 flags."""
        flags = evaluate_year_flags(1980)
        types = {f["flag_type"] for f in flags}
        assert "lead_paint" not in types
        assert "asbestos" in types
        assert len(flags) == 3

    def test_boundary_1979_no_lead(self):
        """1979 >= 1978 → no lead. Still < 1985, 1994, 2000 → 3 flags."""
        flags = evaluate_year_flags(1979)
        types = {f["flag_type"] for f in flags}
        assert "lead_paint" not in types
        assert "knob_and_tube_wiring" not in types
        assert len(flags) == 3

    def test_all_flags_have_detail_and_source(self):
        """Every flag must have a non-empty detail (explanation) and source."""
        for year in [1940, 1960, 1970, 1980, 1990, None]:
            flags = evaluate_year_flags(year)
            for flag in flags:
                assert flag["detail"], f"Empty detail for {flag['flag_type']} at year={year}"
                assert flag["source"], f"Empty source for {flag['flag_type']} at year={year}"
                assert len(flag["detail"]) > 20, "Detail should be a meaningful explanation"


# ===========================================================================
# Unit tests — Lendability score
# ===========================================================================


class TestLendability:
    def test_clean_property_scores_green(self):
        """Property with no risks and good ARV scores green."""
        result = calculate_lendability(
            {"year_built": 2015, "listing_price": 200000},
            [],  # no risk flags
            [{"arv_mid": 350000, "confidence": 0.85}],
        )
        assert result["category"] == "green"
        assert result["score"] >= 70
        assert result["breakdown"]["year_risk"] == 30
        assert result["breakdown"]["arv_ratio"] == 25

    def test_risky_property_scores_red(self):
        """Property with many high-severity flags and bad ARV scores red."""
        flags = [
            {"flag_type": "lead_paint", "severity": "high", "source": "year_built"},
            {"flag_type": "asbestos", "severity": "high", "source": "year_built"},
            {"flag_type": "knob_and_tube_wiring", "severity": "high", "source": "year_built"},
            {"flag_type": "flood_zone", "severity": "high", "source": "fema"},
        ]
        result = calculate_lendability(
            {"year_built": 1950, "listing_price": 200000},
            flags,
            [{"arv_mid": 190000, "confidence": 0.5}],
        )
        assert result["category"] == "red"
        assert result["score"] < 40

    def test_moderate_property_scores_yellow(self):
        """Property with some risks scores yellow."""
        flags = [
            {"flag_type": "cast_iron_drains", "severity": "medium", "source": "year_built"},
            {"flag_type": "polybutylene_plumbing", "severity": "medium", "source": "year_built"},
        ]
        result = calculate_lendability(
            {"year_built": 1990, "listing_price": 200000},
            flags,
            [{"arv_mid": 260000, "confidence": 0.7}],
        )
        # Breakdown should sum to total score
        breakdown = result["breakdown"]
        assert result["score"] == sum(breakdown.values())
        assert result["category"] in {"green", "yellow", "red"}

    def test_missing_data_uses_neutral_defaults(self):
        """Missing data should use neutral defaults, not crash."""
        result = calculate_lendability(
            {"year_built": None, "listing_price": None},
            [],
            [],
        )
        assert result["score"] > 0
        assert result["category"] in {"green", "yellow", "red"}
        breakdown = result["breakdown"]
        assert result["score"] == sum(breakdown.values())

    def test_no_arv_calculations(self):
        """No ARV data should use neutral default."""
        result = calculate_lendability(
            {"year_built": 2000, "listing_price": 200000},
            [],
            [],
        )
        assert result["breakdown"]["arv_ratio"] == 15

    def test_zero_flags_scores_high(self):
        """Property with 0 risk flags should have max year_risk score (30)."""
        result = calculate_lendability(
            {"year_built": 2020, "listing_price": 200000},
            [],
            [{"arv_mid": 350000, "confidence": 0.9}],
        )
        assert result["breakdown"]["year_risk"] == 30
        assert result["category"] == "green"
        assert result["score"] >= 70

    def test_two_medium_flags(self):
        """2 medium-severity flags: year_risk = 30 - 5 - 5 = 20."""
        flags = [
            {"flag_type": "polybutylene_plumbing", "severity": "medium", "source": "year_built"},
            {"flag_type": "cast_iron_drains", "severity": "medium", "source": "year_built"},
        ]
        result = calculate_lendability(
            {"year_built": 1990, "listing_price": 200000},
            flags,
            [{"arv_mid": 280000, "confidence": 0.75}],
        )
        assert result["breakdown"]["year_risk"] == 20

    def test_three_plus_high_flags_warning(self):
        """3+ high-severity flags should push lendability to yellow or red."""
        flags = [
            {"flag_type": "knob_and_tube_wiring", "severity": "high", "source": "year_built"},
            {"flag_type": "lead_paint", "severity": "high", "source": "year_built"},
            {"flag_type": "asbestos", "severity": "high", "source": "year_built"},
        ]
        result = calculate_lendability(
            {"year_built": 1955, "listing_price": 200000},
            flags,
            [{"arv_mid": 250000, "confidence": 0.6}],
        )
        # 3 high flags: 30 - 10 - 10 - 10 = 0
        assert result["breakdown"]["year_risk"] == 0
        assert result["category"] in {"yellow", "red"}


# ===========================================================================
# Integration tests — Risk router
# ===========================================================================


@pytest.mark.anyio
async def test_list_flags_empty(client: AsyncClient, db_session: AsyncSession):
    """GET /risk/{id}/flags returns empty list for new property."""
    prop = await _create_tenant_and_property(db_session)
    resp = await client.get(f"/risk/{prop.id}/flags")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["flags"] == []


@pytest.mark.anyio
async def test_list_flags_not_found(client: AsyncClient, db_session: AsyncSession):
    """GET /risk/{id}/flags returns 404 for non-existent property."""
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/risk/{fake_id}/flags")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_evaluate_creates_flags_and_score(client: AsyncClient, db_session: AsyncSession):
    """POST /risk/{id}/evaluate creates year flags + lendability score."""
    prop = await _create_tenant_and_property(db_session, year_built=1960)

    with patch("app.routers.risk.fema.query_flood_zone", new_callable=AsyncMock) as mock_fema:
        mock_fema.return_value = {
            "zone": "X",
            "zone_subtype": "AREA OF MINIMAL FLOOD HAZARD",
            "is_high_risk": False,
            "panel_number": None,
        }
        resp = await client.post(f"/risk/{prop.id}/evaluate")

    assert resp.status_code == 200
    data = resp.json()

    # Should have 5 year flags + 1 FEMA flag = 6 total
    assert len(data["flags"]) == 6

    # Lendability score present
    assert "lendability" in data
    assert data["lendability"]["score"] > 0
    assert data["lendability"]["category"] in {"green", "yellow", "red"}
    assert "breakdown" in data["lendability"]


@pytest.mark.anyio
async def test_evaluate_high_risk_flood_zone(client: AsyncClient, db_session: AsyncSession):
    """POST /risk/{id}/evaluate with high-risk FEMA zone sets severity high."""
    prop = await _create_tenant_and_property(db_session, year_built=2020)

    with patch("app.routers.risk.fema.query_flood_zone", new_callable=AsyncMock) as mock_fema:
        mock_fema.return_value = {
            "zone": "AE",
            "zone_subtype": "FLOODWAY",
            "is_high_risk": True,
            "panel_number": "12057C0235H",
        }
        resp = await client.post(f"/risk/{prop.id}/evaluate")

    assert resp.status_code == 200
    data = resp.json()
    fema_flags = [f for f in data["flags"] if f["source"] == "fema"]
    assert len(fema_flags) == 1
    assert fema_flags[0]["severity"] == "high"
    assert "AE" in fema_flags[0]["detail"]


@pytest.mark.anyio
async def test_fema_endpoint_missing_coords(client: AsyncClient, db_session: AsyncSession):
    """POST /risk/{id}/fema returns 422 when property has no coordinates."""
    prop = await _create_tenant_and_property(db_session, lat=None, lng=None)
    resp = await client.post(f"/risk/{prop.id}/fema")
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_fema_endpoint_success(client: AsyncClient, db_session: AsyncSession):
    """POST /risk/{id}/fema stores flood zone flag."""
    prop = await _create_tenant_and_property(db_session)

    with patch("app.routers.risk.fema.query_flood_zone", new_callable=AsyncMock) as mock_fema:
        mock_fema.return_value = {
            "zone": "V",
            "zone_subtype": "COASTAL HIGH HAZARD AREA",
            "is_high_risk": True,
            "panel_number": None,
        }
        resp = await client.post(f"/risk/{prop.id}/fema")

    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["flags"][0]["flag_type"] == "flood_zone"
    assert data["flags"][0]["severity"] == "high"


@pytest.mark.anyio
async def test_lendability_not_computed_yet(client: AsyncClient, db_session: AsyncSession):
    """GET /risk/{id}/lendability returns 404 when score not yet computed."""
    prop = await _create_tenant_and_property(db_session)
    resp = await client.get(f"/risk/{prop.id}/lendability")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_lendability_after_evaluate(client: AsyncClient, db_session: AsyncSession):
    """GET /risk/{id}/lendability works after evaluate has been run."""
    prop = await _create_tenant_and_property(db_session, year_built=2020)

    with patch("app.routers.risk.fema.query_flood_zone", new_callable=AsyncMock) as mock_fema:
        mock_fema.return_value = {
            "zone": "X",
            "zone_subtype": None,
            "is_high_risk": False,
            "panel_number": None,
        }
        await client.post(f"/risk/{prop.id}/evaluate")

    resp = await client.get(f"/risk/{prop.id}/lendability")
    assert resp.status_code == 200
    data = resp.json()
    assert data["score"] >= 70
    assert data["category"] == "green"
