"""Rentcast API client for rental comp data and estimates."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import date
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

RENTCAST_BASE_URL = "https://api.rentcast.io/v1"
MAX_RETRIES = 3
RETRY_BACKOFF = 1.0
RATE_LIMIT_WINDOW = 60
RATE_LIMIT_MAX_REQUESTS = 50  # Rentcast free tier is lower


class _RateLimiter:
    """Sliding-window rate limiter for Rentcast."""

    def __init__(self, max_requests: int = RATE_LIMIT_MAX_REQUESTS, window: float = RATE_LIMIT_WINDOW):
        self._max_requests = max_requests
        self._window = window
        self._timestamps: list[float] = []

    async def acquire(self) -> None:
        now = time.monotonic()
        self._timestamps = [t for t in self._timestamps if now - t < self._window]
        if len(self._timestamps) >= self._max_requests:
            sleep_time = self._window - (now - self._timestamps[0])
            logger.warning("Rentcast rate limit reached, sleeping %.1fs", sleep_time)
            await asyncio.sleep(sleep_time)
        self._timestamps.append(time.monotonic())


_rate_limiter = _RateLimiter()


async def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Make a rate-limited, retrying request to Rentcast."""
    url = f"{RENTCAST_BASE_URL}{path}"
    headers = {
        "X-Api-Key": settings.RENTCAST_API_KEY,
        "Accept": "application/json",
    }

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        await _rate_limiter.acquire()
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.request(method, url, headers=headers, params=params)
                if resp.status_code == 429:
                    wait = RETRY_BACKOFF * (2 ** attempt)
                    logger.warning("Rentcast 429, retrying in %.1fs", wait)
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPStatusError as exc:
            last_error = exc
            if exc.response.status_code >= 500:
                wait = RETRY_BACKOFF * (2 ** attempt)
                logger.warning("Rentcast %d, retrying in %.1fs", exc.response.status_code, wait)
                await asyncio.sleep(wait)
                continue
            raise
        except httpx.RequestError as exc:
            last_error = exc
            wait = RETRY_BACKOFF * (2 ** attempt)
            logger.warning("Rentcast request error: %s, retrying in %.1fs", exc, wait)
            await asyncio.sleep(wait)

    raise RuntimeError(f"Rentcast request failed after {MAX_RETRIES} retries") from last_error


async def get_rental_comps_by_address(address: str) -> dict[str, Any]:
    """Fetch rental comps and estimate for an address."""
    return await _request("GET", "/avm/rent/long-term", params={"address": address})


async def get_rental_comps_by_coordinates(lat: float, lng: float) -> dict[str, Any]:
    """Fetch rental comps and estimate for coordinates."""
    return await _request(
        "GET",
        "/avm/rent/long-term",
        params={"latitude": lat, "longitude": lng},
    )


def normalize_rental_comps(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize Rentcast response to our schema.

    Returns dict with:
      - rent_estimate_low / mid / high
      - comps: list of normalized rental comp dicts
    """
    # Extract rent estimate
    rent_low = raw.get("rentRangeLow") or raw.get("rent_range_low")
    rent_high = raw.get("rentRangeHigh") or raw.get("rent_range_high")
    rent_mid = raw.get("rent") or raw.get("rentEstimate")

    if rent_low and rent_high and not rent_mid:
        rent_mid = (rent_low + rent_high) / 2.0

    # Extract comps list
    raw_comps = raw.get("comparables", raw.get("comps", []))
    comps: list[dict[str, Any]] = []

    for rc in raw_comps:
        comp = {
            "address": rc.get("formattedAddress", rc.get("address", "")),
            "city": rc.get("city"),
            "state": rc.get("state"),
            "zip": rc.get("zipCode", rc.get("zip")),
            "lat": rc.get("latitude", rc.get("lat")),
            "lng": rc.get("longitude", rc.get("lng")),
            "rent_price": rc.get("price", rc.get("rent")),
            "sqft": rc.get("squareFootage", rc.get("sqft")),
            "beds": rc.get("bedrooms", rc.get("beds")),
            "baths": rc.get("bathrooms", rc.get("baths")),
            "property_type": rc.get("propertyType", rc.get("property_type")),
            "distance": rc.get("distance"),
            "correlation": rc.get("correlation"),
            "source": "rentcast",
            "last_seen_date": _parse_date(rc.get("lastSeenDate", rc.get("last_seen_date"))),
        }
        comps.append(comp)

    return {
        "rent_estimate_low": rent_low,
        "rent_estimate_mid": rent_mid,
        "rent_estimate_high": rent_high,
        "comps": comps,
    }


def _parse_date(val: Any) -> date | None:
    """Parse a date string to date object, or return None."""
    if val is None:
        return None
    if isinstance(val, date):
        return val
    try:
        return date.fromisoformat(str(val)[:10])
    except (ValueError, TypeError):
        return None
