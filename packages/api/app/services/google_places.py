"""Google Places integration — address autocomplete and geocoding."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

PLACES_AUTOCOMPLETE_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json"
GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"


async def autocomplete(input_text: str, session_token: str | None = None) -> list[dict[str, Any]]:
    """Return address autocomplete predictions from Google Places."""
    if not settings.GOOGLE_PLACES_API_KEY:
        logger.warning("GOOGLE_PLACES_API_KEY not configured")
        return []

    params: dict[str, str] = {
        "input": input_text,
        "types": "address",
        "components": "country:us",
        "key": settings.GOOGLE_PLACES_API_KEY,
    }
    if session_token:
        params["sessiontoken"] = session_token

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(PLACES_AUTOCOMPLETE_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        logger.error("Google Places autocomplete failed: %s", exc)
        return []

    if data.get("status") != "OK":
        logger.warning("Google Places status: %s", data.get("status"))
        return []

    return [
        {
            "place_id": p["place_id"],
            "description": p["description"],
            "structured_formatting": p.get("structured_formatting"),
        }
        for p in data.get("predictions", [])
    ]


async def geocode(address: str) -> dict[str, Any] | None:
    """Geocode an address to lat/lng using Google Geocoding API."""
    if not settings.GOOGLE_PLACES_API_KEY:
        logger.warning("GOOGLE_PLACES_API_KEY not configured")
        return None

    params = {
        "address": address,
        "key": settings.GOOGLE_PLACES_API_KEY,
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(GEOCODE_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        logger.error("Google geocoding failed: %s", exc)
        return None

    if data.get("status") != "OK" or not data.get("results"):
        return None

    result = data["results"][0]
    location = result["geometry"]["location"]
    return {
        "lat": location["lat"],
        "lng": location["lng"],
        "formatted_address": result["formatted_address"],
    }


async def geocode_by_place_id(place_id: str) -> dict[str, Any] | None:
    """Geocode a Google Place ID to lat/lng."""
    if not settings.GOOGLE_PLACES_API_KEY:
        return None

    params = {
        "place_id": place_id,
        "key": settings.GOOGLE_PLACES_API_KEY,
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(GEOCODE_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        logger.error("Google geocoding by place_id failed: %s", exc)
        return None

    if data.get("status") != "OK" or not data.get("results"):
        return None

    result = data["results"][0]
    location = result["geometry"]["location"]
    return {
        "lat": location["lat"],
        "lng": location["lng"],
        "formatted_address": result["formatted_address"],
    }
