"""Zillow URL paste — parse key fields from a Zillow listing URL.

Zillow blocks server-side HTTP scraping (403). Instead we parse all required
address fields directly from the URL slug, which encodes the full address.
Example: /homedetails/38-Chamomile-Ct-Spring-TX-77382/59783766_zpid/
         → address="38 Chamomile Ct", city="Spring", state="TX", zip="77382"
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def parse_zillow_url(url: str) -> dict[str, str]:
    """Extract address slug and zpid from a Zillow listing URL.

    Example: https://www.zillow.com/homedetails/123-Main-St-Austin-TX-78701/12345678_zpid/
    """
    match = re.search(r"/homedetails/([^/]+)/(\d+)_zpid", url)
    if not match:
        raise ValueError(f"Could not parse Zillow URL: {url}")

    slug = match.group(1)
    zpid = match.group(2)
    parts = slug.replace("-", " ").strip()

    return {"address_slug": parts, "zpid": zpid, "url": url}


def _parse_html_meta(html: str, parsed_url: dict[str, str]) -> dict[str, Any]:
    """Extract property data from Zillow HTML meta tags and embedded JSON."""
    data: dict[str, Any] = {
        "zillow_url": parsed_url["url"],
        "data_source": "zillow_url",
    }

    # og:title — typically "Address, City, State Zip"
    title_match = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html)
    if title_match:
        title = title_match.group(1)
        addr_match = re.match(r"(.+),\s*(.+),\s*(\w{2})\s*(\d{5})", title)
        if addr_match:
            data["address"] = addr_match.group(1).strip()
            data["city"] = addr_match.group(2).strip()
            data["state"] = addr_match.group(3).strip()
            data["zip"] = addr_match.group(4).strip()

    # price
    price_match = re.search(r'"price"\s*:\s*"?([\d.]+)"?', html)
    if price_match:
        try:
            data["listing_price"] = float(price_match.group(1))
        except ValueError:
            pass

    # description meta — beds/baths/sqft
    desc_match = re.search(r'<meta\s+name="description"\s+content="([^"]+)"', html)
    if desc_match:
        desc = desc_match.group(1)
        beds = re.search(r"(\d+)\s*(?:bd|bed)", desc, re.IGNORECASE)
        baths = re.search(r"([\d.]+)\s*(?:ba|bath)", desc, re.IGNORECASE)
        sqft = re.search(r"([\d,]+)\s*sqft", desc, re.IGNORECASE)
        if beds:
            data["beds"] = int(beds.group(1))
        if baths:
            data["baths"] = float(baths.group(1))
        if sqft:
            data["sqft"] = int(sqft.group(1).replace(",", ""))

    # lat/lng
    lat_match = re.search(r'"latitude"\s*:\s*([-\d.]+)', html)
    lng_match = re.search(r'"longitude"\s*:\s*([-\d.]+)', html)
    if lat_match and lng_match:
        data["lat"] = float(lat_match.group(1))
        data["lng"] = float(lng_match.group(1))

    # year built / property type
    year_match = re.search(r'"yearBuilt"\s*:\s*(\d{4})', html)
    if year_match:
        data["year_built"] = int(year_match.group(1))

    type_match = re.search(r'"homeType"\s*:\s*"([^"]+)"', html)
    if type_match:
        data["property_type"] = type_match.group(1)

    return data

# All US state/territory abbreviations that appear in Zillow slugs
_STATE_CODES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
}

# Common street-type suffixes that mark the end of the street address
_STREET_SUFFIXES = {
    "st", "ave", "rd", "dr", "ln", "blvd", "way", "pl", "ct",
    "cir", "ter", "trl", "pkwy", "hwy", "loop", "path", "row",
    "run", "sq", "walk", "xing", "pass", "cv", "pt", "bnd",
}


def _parse_address_from_slug(slug: str) -> dict[str, str]:
    """Parse address components from a Zillow URL slug.

    Slug format: {number}-{street-name}-{suffix}-{city-words}-{STATE}-{zip}
    """
    parts = slug.split("-")

    # Locate zip (5-digit) and state (2-letter state code) from the right end
    zip_code = ""
    state = ""
    state_idx = -1

    for i in range(len(parts) - 1, -1, -1):
        p = parts[i]
        if re.match(r"^\d{5}$", p) and not zip_code:
            zip_code = p
        elif p.upper() in _STATE_CODES and not state:
            state = p.upper()
            state_idx = i
            break  # stop — everything to the left is address + city

    if state_idx <= 0:
        # Fallback: can't parse structure, return full slug as address
        return {
            "address": slug.replace("-", " ").title(),
            "city": "",
            "state": state,
            "zip": zip_code,
        }

    before_state = parts[:state_idx]

    # Find the last occurrence of a known street suffix to split addr / city
    suffix_idx = -1
    for i, part in enumerate(before_state):
        if part.lower() in _STREET_SUFFIXES:
            suffix_idx = i

    if suffix_idx >= 0 and suffix_idx < len(before_state) - 1:
        address = " ".join(before_state[: suffix_idx + 1]).title()
        city = " ".join(before_state[suffix_idx + 1 :]).title()
    else:
        # No recognisable suffix — heuristic: first token is number, next 1-2 are name
        split = min(3, max(1, len(before_state) - 1))
        address = " ".join(before_state[:split]).title()
        city = " ".join(before_state[split:]).title()

    return {"address": address, "city": city, "state": state, "zip": zip_code}


async def scrape_zillow_listing(url: str) -> dict[str, Any]:
    """Return property data parsed from a Zillow listing URL.

    Zillow blocks direct HTTP scraping (403), so we derive address fields
    entirely from the URL slug — no network request to Zillow is made.
    beds / baths / price are left empty for the user to fill in.
    """
    match = re.search(r"/homedetails/([^/]+)/(\d+)_zpid", url)
    if not match:
        raise ValueError(f"Not a recognised Zillow listing URL: {url}")

    slug = match.group(1)
    zpid = match.group(2)

    addr = _parse_address_from_slug(slug)
    if not addr["address"] or not addr["state"] or not addr["zip"]:
        raise ValueError(
            f"Could not parse address from Zillow URL slug '{slug}'. "
            "Please add the property manually."
        )

    if not addr["city"]:
        # Last resort — use the slug parts before state as city placeholder
        addr["city"] = addr["address"]

    return {
        "address": addr["address"],
        "city": addr["city"],
        "state": addr["state"],
        "zip": addr["zip"],
        "zillow_url": url,
        "data_source": "zillow_url",
        # zpid stored for future reference
        "mls_id": f"zpid_{zpid}",
    }
