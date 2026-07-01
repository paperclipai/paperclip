"""Dynamics 365 integration — opportunity creation via OAuth2 client credentials."""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# OAuth2 token acquisition
# ---------------------------------------------------------------------------


async def _get_d365_token() -> str:
    """Acquire an OAuth2 access token via client credentials grant."""
    import httpx

    tenant_id = getattr(settings, "D365_TENANT_ID", "")
    client_id = getattr(settings, "D365_CLIENT_ID", "")
    client_secret = getattr(settings, "D365_CLIENT_SECRET", "")
    resource = getattr(settings, "D365_RESOURCE_URL", "")

    token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
                "scope": f"{resource}/.default",
            },
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


# ---------------------------------------------------------------------------
# Opportunity creation
# ---------------------------------------------------------------------------


async def create_d365_opportunity(
    order_data: dict[str, Any],
    property_data: dict[str, Any] | None = None,
    quote_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a Dynamics 365 opportunity from an approved order.

    Maps property + quote/order data to D365 opportunity fields.
    Returns dict with opportunity_id, opportunity_url, and status.
    """
    import httpx

    d365_api_url = getattr(settings, "D365_API_URL", "")
    if not d365_api_url:
        raise ValueError("D365_API_URL is not configured")

    token = await _get_d365_token()

    # Build the opportunity payload
    opportunity = _map_to_d365_opportunity(order_data, property_data, quote_data)

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{d365_api_url}/api/data/v9.2/opportunities",
            json=opportunity,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                "Prefer": "return=representation",
            },
        )
        resp.raise_for_status()
        data = resp.json()

    opportunity_id = data.get("opportunityid", "")
    return {
        "opportunity_id": opportunity_id,
        "opportunity_url": f"{d365_api_url}/main.aspx?etn=opportunity&id={opportunity_id}",
        "status": "created",
    }


async def get_d365_opportunity_status(opportunity_id: str) -> dict[str, Any]:
    """Fetch the current status of a D365 opportunity."""
    import httpx

    d365_api_url = getattr(settings, "D365_API_URL", "")
    token = await _get_d365_token()

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{d365_api_url}/api/data/v9.2/opportunities({opportunity_id})",
            headers={
                "Authorization": f"Bearer {token}",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            },
            params={"$select": "opportunityid,name,statecode,statuscode,estimatedvalue"},
        )
        resp.raise_for_status()
        data = resp.json()

    state_map = {0: "open", 1: "won", 2: "lost"}
    return {
        "opportunity_id": opportunity_id,
        "name": data.get("name"),
        "state": state_map.get(data.get("statecode"), "unknown"),
        "estimated_value": data.get("estimatedvalue"),
        "status": "fetched",
    }


# ---------------------------------------------------------------------------
# D365 field mapping
# ---------------------------------------------------------------------------


def _map_to_d365_opportunity(
    order_data: dict[str, Any],
    property_data: dict[str, Any] | None = None,
    quote_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Map GCP order/property/quote data to D365 opportunity fields."""
    prop = property_data or {}
    quote = quote_data or {}

    address = prop.get("address", "")
    city = prop.get("city", "")
    state = prop.get("state", "")
    zip_code = prop.get("zip", "")
    full_address = f"{address}, {city}, {state} {zip_code}".strip(", ")

    total = order_data.get("total_amount")
    if total is not None:
        total = float(Decimal(str(total)))

    name = f"GCP Renovation — {full_address}" if full_address else f"GCP Order {order_data.get('id', 'N/A')}"

    opportunity: dict[str, Any] = {
        "name": name[:300],
        "description": (
            f"Renovation order from GCP platform.\n"
            f"Order ID: {order_data.get('id', 'N/A')}\n"
            f"Quote ID: {order_data.get('quote_id', 'N/A')}\n"
            f"Property: {full_address}\n"
            f"Property Type: {prop.get('property_type', 'N/A')}\n"
            f"Sq Ft: {prop.get('sqft', 'N/A')}\n"
            f"Beds/Baths: {prop.get('beds', 'N/A')}/{prop.get('baths', 'N/A')}"
        ),
        "estimatedvalue": total,
        "estimatedclosedate": None,
    }

    # Custom fields (GCP-specific, configured in D365)
    custom: dict[str, Any] = {}
    if prop.get("id"):
        custom["gcp_property_id"] = prop["id"]
    if order_data.get("id"):
        custom["gcp_order_id"] = order_data["id"]
    if order_data.get("sage_order_id"):
        custom["gcp_sage_order_id"] = order_data["sage_order_id"]
    if prop.get("arv_estimate"):
        custom["gcp_arv_estimate"] = float(Decimal(str(prop["arv_estimate"])))

    # Merge custom fields (D365 custom field names would be prefixed in real config)
    for key, val in custom.items():
        opportunity[f"new_{key}"] = val

    return opportunity
