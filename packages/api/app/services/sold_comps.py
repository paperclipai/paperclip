"""Sold comps service — queries PropStream for comparable sold properties."""

from __future__ import annotations

import logging
import math
from datetime import date, timedelta
from typing import Any

from app.services import propstream

logger = logging.getLogger(__name__)

# Haversine earth radius in miles
_EARTH_RADIUS_MI = 3958.8


def _haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Return distance in miles between two lat/lng points."""
    r = math.radians
    dlat = r(lat2 - lat1)
    dlng = r(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(dlng / 2) ** 2
    return _EARTH_RADIUS_MI * 2 * math.asin(math.sqrt(a))


def _similarity_score(
    subject: dict[str, Any],
    comp: dict[str, Any],
    distance_mi: float,
    months_old: float,
) -> float:
    """Compute 0-1 similarity score based on distance, recency, and attributes.

    Weights:
      distance   30 %
      recency    25 %
      sqft       20 %
      bed/bath   15 %
      year_built 10 %
    """
    # Distance score (0 = far, 1 = same location)
    dist_score = max(0.0, 1.0 - distance_mi / 5.0)

    # Recency score (0 = old, 1 = today)
    recency_score = max(0.0, 1.0 - months_old / 12.0)

    # Sqft similarity (+/- 20% band)
    s_sqft = subject.get("sqft") or 0
    c_sqft = comp.get("sqft") or 0
    if s_sqft > 0 and c_sqft > 0:
        ratio = min(s_sqft, c_sqft) / max(s_sqft, c_sqft)
        sqft_score = ratio
    else:
        sqft_score = 0.5  # neutral when unknown

    # Bed/bath similarity
    bed_diff = abs((subject.get("beds") or 0) - (comp.get("beds") or 0))
    bath_diff = abs((subject.get("baths") or 0) - (comp.get("baths") or 0))
    bedbath_score = max(0.0, 1.0 - (bed_diff + bath_diff) / 4.0)

    # Year built similarity (+/- 10 years)
    s_year = subject.get("year_built") or 0
    c_year = comp.get("year_built") or 0
    if s_year > 0 and c_year > 0:
        year_diff = abs(s_year - c_year)
        year_score = max(0.0, 1.0 - year_diff / 20.0)
    else:
        year_score = 0.5

    return (
        0.30 * dist_score
        + 0.25 * recency_score
        + 0.20 * sqft_score
        + 0.15 * bedbath_score
        + 0.10 * year_score
    )


def _passes_filter(
    comp: dict[str, Any],
    subject: dict[str, Any],
    *,
    property_type: str | None = None,
    min_beds: int | None = None,
    max_beds: int | None = None,
    min_baths: float | None = None,
    max_baths: float | None = None,
    min_sqft: int | None = None,
    max_sqft: int | None = None,
    min_year_built: int | None = None,
    max_year_built: int | None = None,
) -> bool:
    """Apply configurable filters; defaults are subject ± tolerance."""
    # Property type
    ptype = property_type or subject.get("property_type")
    if ptype and comp.get("property_type") and comp["property_type"].lower() != ptype.lower():
        return False

    # Beds: default ±1 from subject
    s_beds = subject.get("beds")
    c_beds = comp.get("beds")
    if c_beds is not None and s_beds is not None:
        lo = min_beds if min_beds is not None else max(0, s_beds - 1)
        hi = max_beds if max_beds is not None else s_beds + 1
        if not (lo <= c_beds <= hi):
            return False

    # Baths: default ±1 from subject
    s_baths = subject.get("baths")
    c_baths = comp.get("baths")
    if c_baths is not None and s_baths is not None:
        lo = min_baths if min_baths is not None else max(0, s_baths - 1)
        hi = max_baths if max_baths is not None else s_baths + 1
        if not (lo <= c_baths <= hi):
            return False

    # Sqft: default ±20%
    s_sqft = subject.get("sqft")
    c_sqft = comp.get("sqft")
    if c_sqft is not None and s_sqft is not None and s_sqft > 0:
        lo = min_sqft if min_sqft is not None else int(s_sqft * 0.80)
        hi = max_sqft if max_sqft is not None else int(s_sqft * 1.20)
        if not (lo <= c_sqft <= hi):
            return False

    # Year built: default ±10 years
    s_year = subject.get("year_built")
    c_year = comp.get("year_built")
    if c_year is not None and s_year is not None:
        lo = min_year_built if min_year_built is not None else s_year - 10
        hi = max_year_built if max_year_built is not None else s_year + 10
        if not (lo <= c_year <= hi):
            return False

    return True


async def search_sold_comps(
    subject: dict[str, Any],
    *,
    radius_miles: float = 0.5,
    months_back: int = 6,
    property_type: str | None = None,
    min_beds: int | None = None,
    max_beds: int | None = None,
    min_baths: float | None = None,
    max_baths: float | None = None,
    min_sqft: int | None = None,
    max_sqft: int | None = None,
    min_year_built: int | None = None,
    max_year_built: int | None = None,
) -> list[dict[str, Any]]:
    """Search sold comps for a subject property.

    Returns a list of normalized comp dicts sorted by relevance (similarity desc).
    Subject must contain at least lat/lng for geo search.
    """
    lat = subject.get("lat")
    lng = subject.get("lng")
    if lat is None or lng is None:
        # Fallback: search by address
        address = subject.get("address")
        if not address:
            return []
        raw = await propstream.search_by_address(address)
    else:
        raw = await propstream.search_by_coordinates(lat, lng, radius_miles)

    cutoff_date = date.today() - timedelta(days=months_back * 30)
    results: list[dict[str, Any]] = []

    # PropStream returns a list of properties in the results key
    raw_comps = raw.get("results", raw.get("properties", []))
    if isinstance(raw_comps, dict):
        raw_comps = [raw_comps]

    for raw_comp in raw_comps:
        normalized = propstream.normalize_propstream_data(raw_comp)

        # Must have a sale date and price to be a sold comp
        sale_date_str = raw_comp.get("sale", {}).get("date") or raw_comp.get("sale_date")
        sale_price = raw_comp.get("sale", {}).get("price") or raw_comp.get("sale_price")
        if not sale_date_str or not sale_price:
            continue

        try:
            if isinstance(sale_date_str, str):
                sale_date_val = date.fromisoformat(sale_date_str[:10])
            else:
                sale_date_val = sale_date_str
        except (ValueError, TypeError):
            continue

        # Time window filter
        if sale_date_val < cutoff_date:
            continue

        # Distance filter
        c_lat = normalized.get("lat")
        c_lng = normalized.get("lng")
        if c_lat is not None and c_lng is not None and lat is not None and lng is not None:
            dist = _haversine(lat, lng, c_lat, c_lng)
            if dist > radius_miles:
                continue
        else:
            dist = None

        # Attribute filters
        if not _passes_filter(
            normalized,
            subject,
            property_type=property_type,
            min_beds=min_beds,
            max_beds=max_beds,
            min_baths=min_baths,
            max_baths=max_baths,
            min_sqft=min_sqft,
            max_sqft=max_sqft,
            min_year_built=min_year_built,
            max_year_built=max_year_built,
        ):
            continue

        # Compute similarity
        months_old = (date.today() - sale_date_val).days / 30.0
        sim = _similarity_score(subject, normalized, dist or 0.0, months_old)

        comp_data = {
            "address": normalized.get("address", ""),
            "city": normalized.get("city"),
            "state": normalized.get("state"),
            "zip": normalized.get("zip"),
            "lat": c_lat,
            "lng": c_lng,
            "sale_price": float(sale_price),
            "sale_date": sale_date_val,
            "sqft": normalized.get("sqft"),
            "beds": normalized.get("beds"),
            "baths": normalized.get("baths"),
            "year_built": normalized.get("year_built"),
            "property_type": normalized.get("property_type"),
            "distance": round(dist, 3) if dist is not None else None,
            "similarity": round(sim, 4),
            "source": "propstream",
            "mls_id": normalized.get("mls_id"),
            "propstream_id": normalized.get("propstream_id"),
        }
        results.append(comp_data)

    # Sort by similarity descending (most relevant first)
    results.sort(key=lambda c: c.get("similarity", 0), reverse=True)
    return results
