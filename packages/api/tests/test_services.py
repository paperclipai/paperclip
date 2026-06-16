"""Tests for service modules."""

from __future__ import annotations

import pytest

from app.services.apillow import merge_enrichment, normalize_apillow_data
from app.services.propstream import RateLimiter, normalize_propstream_data
from app.services.zillow_scraper import parse_zillow_url, _parse_html_meta


# ---------------------------------------------------------------------------
# PropStream normalization
# ---------------------------------------------------------------------------


def test_normalize_propstream_data() -> None:
    raw = {
        "property": {
            "id": "PS123",
            "address": {"full": "123 Main St", "city": "Austin", "state": "TX", "zip": "78701", "county": "Travis"},
            "location": {"lat": 30.27, "lng": -97.74},
            "details": {"year_built": 2005, "sqft": 1800, "lot_sqft": 5000, "beds": 3, "baths": 2.0, "property_type": "SFR"},
            "valuation": {"listing_price": 450000, "arv": 550000, "arv_confidence": 0.85},
            "tax": {"assessed_value": 380000},
            "mls_id": "MLS456",
            "ownership_history": [{"date": "2020-01-15", "buyer": "Smith"}],
        }
    }
    result = normalize_propstream_data(raw)
    assert result["address"] == "123 Main St"
    assert result["city"] == "Austin"
    assert result["propstream_id"] == "PS123"
    assert result["data_source"] == "propstream"
    assert result["tax_assessment"] == 380000
    assert result["beds"] == 3


# ---------------------------------------------------------------------------
# APIllow merge logic
# ---------------------------------------------------------------------------


def test_merge_enrichment_fills_gaps() -> None:
    existing = {"beds": 3, "baths": None, "sqft": 1800, "zillow_estimate": None, "neighborhood": None}
    enrichment = {"beds": 4, "baths": 2.0, "sqft": 2000, "zillow_estimate": 500000, "neighborhood": "Downtown"}

    merged = merge_enrichment(existing, enrichment)
    # beds should NOT be overwritten (PropStream is source-of-truth)
    assert merged["beds"] == 3
    # baths was None, so APIllow fills the gap
    assert merged["baths"] == 2.0
    # sqft was set, NOT overwritten
    assert merged["sqft"] == 1800
    # zillow_estimate is APIllow-exclusive, always set
    assert merged["zillow_estimate"] == 500000
    # neighborhood is APIllow-exclusive, always set
    assert merged["neighborhood"] == "Downtown"


def test_merge_enrichment_ignores_none() -> None:
    existing = {"beds": 3}
    enrichment = {"beds": None, "baths": None}
    merged = merge_enrichment(existing, enrichment)
    assert merged["beds"] == 3
    assert "baths" not in merged


def test_normalize_apillow_data() -> None:
    raw = {
        "zestimate": 520000,
        "neighborhood": "East Austin",
        "bedrooms": 4,
        "bathrooms": 2.5,
        "living_area": 2200,
        "year_built": 2010,
        "lot_size": 6000,
        "home_type": "SINGLE_FAMILY",
        "latitude": 30.26,
        "longitude": -97.73,
        "arv": 580000,
    }
    result = normalize_apillow_data(raw)
    assert result["zillow_estimate"] == 520000
    assert result["neighborhood"] == "East Austin"
    assert result["beds"] == 4


# ---------------------------------------------------------------------------
# Zillow URL parsing
# ---------------------------------------------------------------------------


def test_parse_zillow_url_valid() -> None:
    url = "https://www.zillow.com/homedetails/123-Main-St-Austin-TX-78701/12345678_zpid/"
    result = parse_zillow_url(url)
    assert result["zpid"] == "12345678"
    assert result["url"] == url
    assert "Main" in result["address_slug"]


def test_parse_zillow_url_invalid() -> None:
    with pytest.raises(ValueError):
        parse_zillow_url("https://www.zillow.com/homes/")


def test_parse_html_meta_extracts_data() -> None:
    html = '''
    <html>
    <head>
    <meta property="og:title" content="123 Main St, Austin, TX 78701">
    <meta name="description" content="3 bd, 2.0 ba, 1800 sqft home">
    </head>
    <body>
    <script>"latitude": 30.27, "longitude": -97.74, "yearBuilt": 2005, "homeType": "SINGLE_FAMILY", "price": "450000"</script>
    </body>
    </html>
    '''
    parsed_url = {"url": "https://www.zillow.com/homedetails/test/123_zpid/"}
    result = _parse_html_meta(html, parsed_url)
    assert result["address"] == "123 Main St"
    assert result["city"] == "Austin"
    assert result["state"] == "TX"
    assert result["zip"] == "78701"
    assert result["beds"] == 3
    assert result["baths"] == 2.0
    assert result["sqft"] == 1800
    assert result["lat"] == 30.27
    assert result["year_built"] == 2005
    assert result["property_type"] == "SINGLE_FAMILY"
    assert result["listing_price"] == 450000.0


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------


def test_normalize_propstream_missing_fields() -> None:
    """PropStream response with missing nested fields should not crash."""
    raw = {"property": {"id": "PS999", "address": {}, "location": {}, "details": {}, "valuation": {}, "tax": {}}}
    result = normalize_propstream_data(raw)
    assert result["address"] == ""
    assert result["city"] == ""
    assert result["lat"] is None
    assert result["beds"] is None
    assert result["tax_assessment"] is None
    assert result["data_source"] == "propstream"


def test_normalize_propstream_malformed_no_property_key() -> None:
    """PropStream response without 'property' wrapper uses raw dict as fallback."""
    raw = {"id": "PS-FLAT", "address": {"full": "Flat St", "city": "X", "state": "Y", "zip": "00000"}}
    result = normalize_propstream_data(raw)
    assert result["address"] == "Flat St"
    assert result["propstream_id"] == "PS-FLAT"


def test_merge_enrichment_missing_zestimate() -> None:
    """APIllow enrichment with None zestimate should not overwrite anything."""
    existing = {"beds": 3, "zillow_estimate": None}
    enrichment = {"beds": 4, "zillow_estimate": None, "neighborhood": "East Side"}
    merged = merge_enrichment(existing, enrichment)
    assert merged["beds"] == 3  # PropStream source-of-truth
    assert merged["zillow_estimate"] is None  # APIllow sent None
    assert merged["neighborhood"] == "East Side"  # exclusive, non-None


def test_merge_enrichment_zestimate_always_set() -> None:
    """APIllow zillow_estimate is exclusive and always overrides when non-None."""
    existing = {"zillow_estimate": 400000}
    enrichment = {"zillow_estimate": 520000}
    merged = merge_enrichment(existing, enrichment)
    assert merged["zillow_estimate"] == 520000


# ---------------------------------------------------------------------------
# Google Places autocomplete — mocked integration
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_google_places_autocomplete_returns_formatted_address() -> None:
    """Google Places autocomplete → formatted address + lat/lng via geocode."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from app.services.google_places import autocomplete, geocode

    mock_autocomplete_response = {
        "status": "OK",
        "predictions": [
            {
                "place_id": "ChIJ_abc123",
                "description": "123 Main St, Austin, TX 78701, USA",
                "structured_formatting": {"main_text": "123 Main St"},
            }
        ],
    }
    mock_geocode_response = {
        "status": "OK",
        "results": [
            {
                "formatted_address": "123 Main St, Austin, TX 78701, USA",
                "geometry": {"location": {"lat": 30.2672, "lng": -97.7431}},
            }
        ],
    }

    with patch("app.services.google_places.settings") as mock_settings:
        mock_settings.GOOGLE_PLACES_API_KEY = "test-key"
        with patch("app.services.google_places.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            # autocomplete call — httpx.Response.json() and raise_for_status() are sync
            mock_resp_ac = MagicMock()
            mock_resp_ac.json.return_value = mock_autocomplete_response
            mock_client.get.return_value = mock_resp_ac

            results = await autocomplete("123 Main")
            assert len(results) == 1
            assert results[0]["place_id"] == "ChIJ_abc123"
            assert "123 Main St" in results[0]["description"]

            # geocode call
            mock_resp_geo = MagicMock()
            mock_resp_geo.json.return_value = mock_geocode_response
            mock_client.get.return_value = mock_resp_geo

            geo = await geocode("123 Main St, Austin, TX 78701")
            assert geo is not None
            assert geo["lat"] == 30.2672
            assert geo["lng"] == -97.7431
            assert "123 Main St" in geo["formatted_address"]


@pytest.mark.anyio
async def test_rate_limiter_allows_under_limit() -> None:
    limiter = RateLimiter(max_requests=5, window=60)
    for _ in range(5):
        await limiter.acquire()
    # Should not raise
