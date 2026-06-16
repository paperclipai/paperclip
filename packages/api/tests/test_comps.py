"""Tests for comps engine — sold comps, ARV calculator, rental comps, and endpoints."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Comp, Property, RentalComp
from app.services.arv_calculator import InsufficientCompsError, calculate_arv
from app.services.sold_comps import _haversine, _passes_filter, _similarity_score
from tests.conftest import TENANT_ID


# ---------------------------------------------------------------------------
# Haversine distance
# ---------------------------------------------------------------------------


def test_haversine_same_point() -> None:
    assert _haversine(30.27, -97.74, 30.27, -97.74) == 0.0


def test_haversine_short_distance() -> None:
    # ~1 mile apart in Austin
    dist = _haversine(30.27, -97.74, 30.284, -97.74)
    assert 0.5 < dist < 2.0


# ---------------------------------------------------------------------------
# Similarity scoring
# ---------------------------------------------------------------------------


def test_similarity_score_identical() -> None:
    subject = {"sqft": 2000, "beds": 3, "baths": 2.0, "year_built": 2010}
    comp = {"sqft": 2000, "beds": 3, "baths": 2.0, "year_built": 2010}
    score = _similarity_score(subject, comp, distance_mi=0.0, months_old=0.0)
    assert score > 0.9


def test_similarity_score_decreases_with_distance() -> None:
    subject = {"sqft": 2000, "beds": 3, "baths": 2.0, "year_built": 2010}
    comp = {"sqft": 2000, "beds": 3, "baths": 2.0, "year_built": 2010}
    near = _similarity_score(subject, comp, distance_mi=0.1, months_old=1.0)
    far = _similarity_score(subject, comp, distance_mi=3.0, months_old=1.0)
    assert near > far


def test_similarity_score_decreases_with_age() -> None:
    subject = {"sqft": 2000, "beds": 3, "baths": 2.0, "year_built": 2010}
    comp = {"sqft": 2000, "beds": 3, "baths": 2.0, "year_built": 2010}
    recent = _similarity_score(subject, comp, distance_mi=0.5, months_old=1.0)
    old = _similarity_score(subject, comp, distance_mi=0.5, months_old=10.0)
    assert recent > old


# ---------------------------------------------------------------------------
# Filter logic
# ---------------------------------------------------------------------------


def test_passes_filter_matching() -> None:
    subject = {"beds": 3, "baths": 2.0, "sqft": 2000, "year_built": 2010, "property_type": "SFR"}
    comp = {"beds": 3, "baths": 2.0, "sqft": 1900, "year_built": 2008, "property_type": "SFR"}
    assert _passes_filter(comp, subject) is True


def test_passes_filter_beds_out_of_range() -> None:
    subject = {"beds": 3, "baths": 2.0, "sqft": 2000, "year_built": 2010}
    comp = {"beds": 6, "baths": 2.0, "sqft": 2000, "year_built": 2010}
    assert _passes_filter(comp, subject) is False


def test_passes_filter_sqft_too_different() -> None:
    subject = {"beds": 3, "baths": 2.0, "sqft": 2000, "year_built": 2010}
    comp = {"beds": 3, "baths": 2.0, "sqft": 1000, "year_built": 2010}
    assert _passes_filter(comp, subject) is False


def test_passes_filter_custom_range() -> None:
    subject = {"beds": 3, "baths": 2.0, "sqft": 2000, "year_built": 2010}
    comp = {"beds": 5, "baths": 2.0, "sqft": 2000, "year_built": 2010}
    # Default filter rejects 5 beds (3 ± 1), but custom max_beds=6 accepts
    assert _passes_filter(comp, subject) is False
    assert _passes_filter(comp, subject, min_beds=2, max_beds=6) is True


def test_passes_filter_property_type_mismatch() -> None:
    subject = {"beds": 3, "baths": 2.0, "sqft": 2000, "year_built": 2010, "property_type": "SFR"}
    comp = {"beds": 3, "baths": 2.0, "sqft": 2000, "year_built": 2010, "property_type": "Condo"}
    assert _passes_filter(comp, subject) is False


# ---------------------------------------------------------------------------
# ARV Calculator
# ---------------------------------------------------------------------------


def _make_comp(
    sale_price: float,
    sqft: int = 2000,
    distance: float = 0.3,
    days_old: int = 30,
    similarity: float = 0.8,
) -> dict:
    return {
        "sale_price": sale_price,
        "sqft": sqft,
        "distance": distance,
        "sale_date": date.today() - timedelta(days=days_old),
        "similarity": similarity,
        "beds": 3,
        "baths": 2.0,
        "year_built": 2010,
    }


def test_arv_requires_minimum_comps() -> None:
    comps = [_make_comp(300000), _make_comp(310000)]
    with pytest.raises(InsufficientCompsError) as exc_info:
        calculate_arv(comps)
    assert exc_info.value.available == 2


def test_arv_returns_band() -> None:
    comps = [
        _make_comp(300000, days_old=30),
        _make_comp(310000, days_old=60),
        _make_comp(320000, days_old=90),
        _make_comp(305000, days_old=45),
    ]
    result = calculate_arv(comps, subject={"sqft": 2000})
    assert result["arv_low"] < result["arv_mid"] < result["arv_high"]
    assert 0 < result["confidence"] <= 1.0
    assert result["comp_count"] == 4
    assert result["methodology"]["method"] == "weighted_comparable_sales"


def test_arv_low_lt_high() -> None:
    comps = [_make_comp(500000), _make_comp(520000), _make_comp(480000)]
    result = calculate_arv(comps)
    assert result["arv_low"] < result["arv_high"]


def test_arv_confidence_increases_with_comps() -> None:
    few = [_make_comp(300000), _make_comp(310000), _make_comp(320000)]
    many = few + [_make_comp(305000), _make_comp(315000), _make_comp(308000), _make_comp(312000), _make_comp(318000)]
    r_few = calculate_arv(few)
    r_many = calculate_arv(many)
    assert r_many["confidence"] >= r_few["confidence"]


def test_arv_skips_zero_price_comps() -> None:
    comps = [_make_comp(300000), _make_comp(310000), _make_comp(0), _make_comp(320000)]
    result = calculate_arv(comps)
    assert result["comp_count"] == 3


# ---------------------------------------------------------------------------
# Rentcast normalization
# ---------------------------------------------------------------------------


def test_normalize_rental_comps() -> None:
    from app.services.rentcast import normalize_rental_comps

    raw = {
        "rent": 2500,
        "rentRangeLow": 2200,
        "rentRangeHigh": 2800,
        "comparables": [
            {
                "formattedAddress": "456 Oak St, Austin, TX 78702",
                "city": "Austin",
                "state": "TX",
                "zipCode": "78702",
                "latitude": 30.26,
                "longitude": -97.73,
                "price": 2400,
                "squareFootage": 1800,
                "bedrooms": 3,
                "bathrooms": 2.0,
                "propertyType": "Single Family",
                "distance": 0.3,
                "correlation": 0.92,
            }
        ],
    }
    result = normalize_rental_comps(raw)
    assert result["rent_estimate_low"] == 2200
    assert result["rent_estimate_mid"] == 2500
    assert result["rent_estimate_high"] == 2800
    assert len(result["comps"]) == 1
    assert result["comps"][0]["address"] == "456 Oak St, Austin, TX 78702"
    assert result["comps"][0]["rent_price"] == 2400
    assert result["comps"][0]["source"] == "rentcast"


def test_normalize_rental_comps_calculates_mid() -> None:
    from app.services.rentcast import normalize_rental_comps

    raw = {"rentRangeLow": 2000, "rentRangeHigh": 3000, "comparables": []}
    result = normalize_rental_comps(raw)
    assert result["rent_estimate_mid"] == 2500.0


# ---------------------------------------------------------------------------
# Comps API endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def _property_id() -> str:
    return str(uuid.uuid4())


@pytest_asyncio.fixture
async def seeded_property(db_session: AsyncSession) -> Property:
    prop = Property(
        tenant_id=TENANT_ID,
        address="100 Main St",
        city="Austin",
        state="TX",
        zip="78701",
        lat=30.27,
        lng=-97.74,
        sqft=2000,
        beds=3,
        baths=2.0,
        year_built=2010,
        property_type="SFR",
        data_source="manual",
        status="active",
    )
    db_session.add(prop)
    await db_session.flush()
    await db_session.refresh(prop)
    return prop


@pytest.mark.anyio
async def test_search_sold_comps_endpoint(client: AsyncClient, seeded_property: Property) -> None:
    mock_raw = {
        "results": [
            {
                "property": {
                    "id": "PS999",
                    "address": {"full": "200 Elm St", "city": "Austin", "state": "TX", "zip": "78701"},
                    "location": {"lat": 30.271, "lng": -97.741},
                    "details": {"sqft": 1900, "beds": 3, "baths": 2.0, "year_built": 2008, "property_type": "SFR"},
                    "valuation": {},
                    "tax": {},
                    "mls_id": "MLS999",
                },
                "sale": {"date": str(date.today() - timedelta(days=30)), "price": 310000},
            }
        ]
    }

    with patch("app.services.propstream.search_by_coordinates", new_callable=AsyncMock, return_value=mock_raw):
        resp = await client.post("/comps/sold", json={"property_id": seeded_property.id})

    assert resp.status_code == 200
    data = resp.json()
    assert data["property_id"] == seeded_property.id
    assert data["total"] >= 1
    assert data["comps"][0]["source"] == "propstream"


@pytest.mark.anyio
async def test_list_sold_comps_empty(client: AsyncClient, seeded_property: Property) -> None:
    resp = await client.get(f"/comps/{seeded_property.id}/sold")
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


@pytest.mark.anyio
async def test_arv_endpoint_insufficient_comps(client: AsyncClient, seeded_property: Property) -> None:
    # No comps exist and PropStream returns empty
    with patch("app.services.propstream.search_by_coordinates", new_callable=AsyncMock, return_value={"results": []}):
        resp = await client.post("/comps/arv", json={"property_id": seeded_property.id})

    assert resp.status_code == 422
    assert "Insufficient comps" in resp.json()["detail"]


@pytest.mark.anyio
async def test_rental_comps_endpoint(client: AsyncClient, seeded_property: Property) -> None:
    mock_raw = {
        "rent": 2500,
        "rentRangeLow": 2200,
        "rentRangeHigh": 2800,
        "comparables": [
            {
                "formattedAddress": "300 Pine St, Austin, TX 78701",
                "city": "Austin",
                "state": "TX",
                "zipCode": "78701",
                "latitude": 30.269,
                "longitude": -97.739,
                "price": 2400,
                "squareFootage": 1850,
                "bedrooms": 3,
                "bathrooms": 2.0,
                "propertyType": "Single Family",
                "distance": 0.2,
                "correlation": 0.95,
            }
        ],
    }

    with patch("app.services.rentcast.get_rental_comps_by_coordinates", new_callable=AsyncMock, return_value=mock_raw):
        resp = await client.post("/comps/rental", json={"property_id": seeded_property.id})

    assert resp.status_code == 200
    data = resp.json()
    assert data["property_id"] == seeded_property.id
    assert data["rent_estimate_low"] == 2200
    assert data["rent_estimate_mid"] == 2500
    assert data["total"] >= 1
    assert data["comps"][0]["source"] == "rentcast"


@pytest.mark.anyio
async def test_list_rental_comps_empty(client: AsyncClient, seeded_property: Property) -> None:
    resp = await client.get(f"/comps/{seeded_property.id}/rental")
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


@pytest.mark.anyio
async def test_sold_comps_property_not_found(client: AsyncClient) -> None:
    fake_id = str(uuid.uuid4())
    resp = await client.post("/comps/sold", json={"property_id": fake_id})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# QA Gate: ARV never returns a single number without range
# ---------------------------------------------------------------------------


def test_arv_always_returns_band_not_single_number() -> None:
    """ARV result must always include low, mid, and high — never a bare number."""
    comps = [
        _make_comp(300000, days_old=10),
        _make_comp(310000, days_old=20),
        _make_comp(320000, days_old=30),
    ]
    result = calculate_arv(comps)
    assert "arv_low" in result
    assert "arv_mid" in result
    assert "arv_high" in result
    assert result["arv_low"] < result["arv_mid"]
    assert result["arv_mid"] < result["arv_high"]
    # Ensure these are all different values (not collapsed to single point)
    assert result["arv_low"] != result["arv_high"]


def test_arv_confidence_degrades_with_fewer_comps() -> None:
    """Confidence score should be lower with 3 comps than with 8."""
    base = [_make_comp(300000 + i * 5000, days_old=30 + i * 10) for i in range(3)]
    many = [_make_comp(300000 + i * 5000, days_old=30 + i * 10) for i in range(8)]
    r_few = calculate_arv(base)
    r_many = calculate_arv(many)
    assert r_many["confidence"] > r_few["confidence"]


def test_arv_comp_rejection_triggers_recalculation() -> None:
    """Removing a comp should change the ARV result (recalculation)."""
    comps = [
        _make_comp(300000, days_old=10),
        _make_comp(310000, days_old=20),
        _make_comp(400000, days_old=30),  # outlier
        _make_comp(305000, days_old=15),
    ]
    result_with_outlier = calculate_arv(comps)

    # "Reject" the outlier
    filtered = [c for c in comps if c["sale_price"] != 400000]
    result_without_outlier = calculate_arv(filtered)

    # Mid should be noticeably lower without the outlier
    assert result_without_outlier["arv_mid"] < result_with_outlier["arv_mid"]


def test_rental_comps_returns_rent_band() -> None:
    """Normalized rental comps must include low/mid/high rent band."""
    from app.services.rentcast import normalize_rental_comps

    raw = {
        "rent": 2500,
        "rentRangeLow": 2200,
        "rentRangeHigh": 2800,
        "comparables": [
            {
                "formattedAddress": "100 Oak St, Austin, TX 78701",
                "city": "Austin",
                "state": "TX",
                "zipCode": "78701",
                "latitude": 30.27,
                "longitude": -97.74,
                "price": 2400,
                "squareFootage": 1800,
                "bedrooms": 3,
                "bathrooms": 2.0,
                "propertyType": "Single Family",
                "distance": 0.5,
                "correlation": 0.88,
            }
        ],
    }
    result = normalize_rental_comps(raw)
    assert result["rent_estimate_low"] == 2200
    assert result["rent_estimate_mid"] == 2500
    assert result["rent_estimate_high"] == 2800
    assert result["rent_estimate_low"] < result["rent_estimate_mid"] < result["rent_estimate_high"]


# ---------------------------------------------------------------------------
# QA Gate: Realistic comp scenario (known market, known comps)
# ---------------------------------------------------------------------------


def test_arv_realistic_austin_scenario() -> None:
    """Realistic Austin TX comp scenario: 4 recent sales near a 2000 sqft subject.

    Subject: 2000 sqft, 3/2, built 2010 in 78701
    Comp 1: 1900 sqft, sold $310K, 0.3mi away, 30 days ago
    Comp 2: 2100 sqft, sold $340K, 0.5mi away, 45 days ago
    Comp 3: 1850 sqft, sold $295K, 0.4mi away, 60 days ago
    Comp 4: 2050 sqft, sold $325K, 0.2mi away, 20 days ago

    Expected ARV mid should be approximately $315K–$330K range.
    """
    comps = [
        _make_comp(310000, sqft=1900, distance=0.3, days_old=30, similarity=0.85),
        _make_comp(340000, sqft=2100, distance=0.5, days_old=45, similarity=0.80),
        _make_comp(295000, sqft=1850, distance=0.4, days_old=60, similarity=0.78),
        _make_comp(325000, sqft=2050, distance=0.2, days_old=20, similarity=0.90),
    ]
    result = calculate_arv(comps, subject={"sqft": 2000})
    # ARV mid should be in a realistic range
    assert 290_000 < result["arv_mid"] < 360_000
    assert result["arv_low"] < result["arv_mid"] < result["arv_high"]
    assert result["confidence"] > 0.5
    assert result["comp_count"] == 4
    assert result["methodology"]["sqft_adjusted_avg"] is not None
