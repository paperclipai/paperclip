"""APIllow (Zillow API) enrichment service.

PropStream is source-of-truth; APIllow fills gaps only.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

APILLOW_BASE_URL = "https://api.apillow.com/v1"


async def fetch_property_data(address: str) -> dict[str, Any] | None:
    """Fetch property data from APIllow by address."""
    if not settings.ZILLOW_API_KEY:
        logger.warning("ZILLOW_API_KEY not configured, skipping APIllow enrichment")
        return None

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{APILLOW_BASE_URL}/property",
                params={"address": address},
                headers={"Authorization": f"Bearer {settings.ZILLOW_API_KEY}"},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as exc:
        logger.error("APIllow request failed: %s", exc)
        return None


def normalize_apillow_data(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize APIllow response to our property schema fields."""
    return {
        "zillow_estimate": raw.get("zestimate"),
        "neighborhood": raw.get("neighborhood"),
        "arv_estimate": raw.get("arv"),
        "beds": raw.get("bedrooms"),
        "baths": raw.get("bathrooms"),
        "sqft": raw.get("living_area"),
        "year_built": raw.get("year_built"),
        "lot_sqft": raw.get("lot_size"),
        "property_type": raw.get("home_type"),
        "lat": raw.get("latitude"),
        "lng": raw.get("longitude"),
    }


def merge_enrichment(
    existing: dict[str, Any],
    enrichment: dict[str, Any],
) -> dict[str, Any]:
    """Merge APIllow enrichment into existing property data.

    PropStream is source-of-truth. APIllow only fills None/missing fields,
    except for zillow_estimate and neighborhood which are APIllow-exclusive.
    """
    apillow_exclusive = {"zillow_estimate", "neighborhood"}
    merged = dict(existing)

    for key, value in enrichment.items():
        if value is None:
            continue
        # APIllow-exclusive fields always override
        if key in apillow_exclusive:
            merged[key] = value
        # Other fields only fill gaps
        elif merged.get(key) is None:
            merged[key] = value

    return merged
