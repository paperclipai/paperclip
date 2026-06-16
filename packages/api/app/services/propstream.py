"""PropStream API client with rate limiting and retry logic."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

PROPSTREAM_BASE_URL = "https://api.propstream.com/v1"
MAX_RETRIES = 3
RETRY_BACKOFF = 1.0  # seconds
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX_REQUESTS = 100


class RateLimiter:
    """Simple sliding-window rate limiter."""

    def __init__(self, max_requests: int = RATE_LIMIT_MAX_REQUESTS, window: float = RATE_LIMIT_WINDOW):
        self._max_requests = max_requests
        self._window = window
        self._timestamps: list[float] = []

    async def acquire(self) -> None:
        now = time.monotonic()
        self._timestamps = [t for t in self._timestamps if now - t < self._window]
        if len(self._timestamps) >= self._max_requests:
            sleep_time = self._window - (now - self._timestamps[0])
            logger.warning("PropStream rate limit reached, sleeping %.1fs", sleep_time)
            await asyncio.sleep(sleep_time)
        self._timestamps.append(time.monotonic())


_rate_limiter = RateLimiter()


async def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Make a rate-limited, retrying request to PropStream."""
    url = f"{PROPSTREAM_BASE_URL}{path}"
    headers = {
        "Authorization": f"Bearer {settings.PROPSTREAM_API_KEY}",
        "Content-Type": "application/json",
    }

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        await _rate_limiter.acquire()
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.request(
                    method, url, headers=headers, params=params, json=json_body
                )
                if resp.status_code == 429:
                    wait = RETRY_BACKOFF * (2 ** attempt)
                    logger.warning("PropStream 429, retrying in %.1fs", wait)
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPStatusError as exc:
            last_error = exc
            if exc.response.status_code >= 500:
                wait = RETRY_BACKOFF * (2 ** attempt)
                logger.warning("PropStream %d, retrying in %.1fs", exc.response.status_code, wait)
                await asyncio.sleep(wait)
                continue
            raise
        except httpx.RequestError as exc:
            last_error = exc
            wait = RETRY_BACKOFF * (2 ** attempt)
            logger.warning("PropStream request error: %s, retrying in %.1fs", exc, wait)
            await asyncio.sleep(wait)

    raise RuntimeError(f"PropStream request failed after {MAX_RETRIES} retries") from last_error


async def search_by_address(address: str) -> dict[str, Any]:
    """Search PropStream for a property by address."""
    return await _request("GET", "/properties/search", params={"address": address})


async def search_by_mls_id(mls_id: str) -> dict[str, Any]:
    """Search PropStream for a property by MLS ID."""
    return await _request("GET", "/properties/search", params={"mls_id": mls_id})


async def search_by_coordinates(lat: float, lng: float, radius_miles: float = 1.0) -> dict[str, Any]:
    """Search PropStream for properties near coordinates."""
    return await _request(
        "GET",
        "/properties/search",
        params={"lat": lat, "lng": lng, "radius": radius_miles},
    )


async def get_property_detail(propstream_id: str) -> dict[str, Any]:
    """Fetch full property details from PropStream."""
    return await _request("GET", f"/properties/{propstream_id}")


def normalize_propstream_data(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize PropStream response to our property schema fields."""
    prop = raw.get("property", raw)
    return {
        "address": prop.get("address", {}).get("full", ""),
        "city": prop.get("address", {}).get("city", ""),
        "state": prop.get("address", {}).get("state", ""),
        "zip": prop.get("address", {}).get("zip", ""),
        "county": prop.get("address", {}).get("county"),
        "lat": prop.get("location", {}).get("lat"),
        "lng": prop.get("location", {}).get("lng"),
        "year_built": prop.get("details", {}).get("year_built"),
        "sqft": prop.get("details", {}).get("sqft"),
        "lot_sqft": prop.get("details", {}).get("lot_sqft"),
        "beds": prop.get("details", {}).get("beds"),
        "baths": prop.get("details", {}).get("baths"),
        "property_type": prop.get("details", {}).get("property_type"),
        "propstream_id": str(prop.get("id", "")),
        "mls_id": prop.get("mls_id"),
        "listing_price": prop.get("valuation", {}).get("listing_price"),
        "arv_estimate": prop.get("valuation", {}).get("arv"),
        "arv_confidence": prop.get("valuation", {}).get("arv_confidence"),
        "tax_assessment": prop.get("tax", {}).get("assessed_value"),
        "ownership_history": prop.get("ownership_history"),
        "data_source": "propstream",
    }
