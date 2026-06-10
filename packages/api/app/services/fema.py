"""FEMA National Flood Hazard Layer (NFHL) API client."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# FEMA NFHL ArcGIS REST endpoint
FEMA_NFHL_URL = (
    "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query"
)

MAX_RETRIES = 3
RETRY_BACKOFF = 1.0  # seconds
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX_REQUESTS = 50

# Zones considered high-risk for lending / insurance purposes
HIGH_RISK_ZONES = {"A", "AE", "AH", "AO", "AR", "V", "VE", "A99"}


class _RateLimiter:
    """Sliding-window rate limiter for FEMA requests."""

    def __init__(
        self,
        max_requests: int = RATE_LIMIT_MAX_REQUESTS,
        window: float = RATE_LIMIT_WINDOW,
    ):
        self._max_requests = max_requests
        self._window = window
        self._timestamps: list[float] = []

    async def acquire(self) -> None:
        now = time.monotonic()
        self._timestamps = [t for t in self._timestamps if now - t < self._window]
        if len(self._timestamps) >= self._max_requests:
            sleep_time = self._window - (now - self._timestamps[0])
            logger.warning("FEMA rate limit reached, sleeping %.1fs", sleep_time)
            await asyncio.sleep(sleep_time)
        self._timestamps.append(time.monotonic())


_rate_limiter = _RateLimiter()


async def query_flood_zone(lat: float, lng: float) -> dict[str, Any] | None:
    """Query FEMA NFHL for the flood zone at the given coordinates.

    Returns a normalized dict with zone info, or None on failure/timeout.
    """
    params = {
        "geometry": f"{lng},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "FLD_ZONE,ZONE_SUBTY,DFIRM_ID,PANEL",
        "returnGeometry": "false",
        "f": "json",
    }

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        await _rate_limiter.acquire()
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(FEMA_NFHL_URL, params=params)
                if resp.status_code == 429:
                    wait = RETRY_BACKOFF * (2**attempt)
                    logger.warning("FEMA 429, retrying in %.1fs", wait)
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as exc:
            last_error = exc
            if exc.response.status_code >= 500:
                wait = RETRY_BACKOFF * (2**attempt)
                logger.warning(
                    "FEMA %d, retrying in %.1fs", exc.response.status_code, wait
                )
                await asyncio.sleep(wait)
                continue
            logger.error("FEMA HTTP error: %s", exc)
            return None
        except (httpx.RequestError, httpx.TimeoutException) as exc:
            last_error = exc
            wait = RETRY_BACKOFF * (2**attempt)
            logger.warning("FEMA request error: %s, retrying in %.1fs", exc, wait)
            await asyncio.sleep(wait)
            continue
        else:
            return _normalize_fema_response(data)

    logger.error("FEMA request failed after %d retries: %s", MAX_RETRIES, last_error)
    return None


def _normalize_fema_response(data: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize the FEMA ArcGIS JSON response to a clean dict."""
    features = data.get("features", [])
    if not features:
        # No flood zone data at this location — likely outside mapped areas
        return {
            "zone": "X",
            "zone_subtype": "AREA OF MINIMAL FLOOD HAZARD",
            "is_high_risk": False,
            "panel_number": None,
        }

    attrs = features[0].get("attributes", {})
    zone = (attrs.get("FLD_ZONE") or "X").strip().upper()

    return {
        "zone": zone,
        "zone_subtype": attrs.get("ZONE_SUBTY"),
        "is_high_risk": zone in HIGH_RISK_ZONES,
        "panel_number": attrs.get("PANEL"),
    }
