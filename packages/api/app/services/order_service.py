"""Order service — Sage order submission, status sync, and order lifecycle."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ORDER_STATUSES = (
    "pending",
    "submitted",
    "confirmed",
    "partially_shipped",
    "shipped",
    "delivered",
    "failed",
    "cancelled",
)

MAX_RETRY_COUNT = 3


# ---------------------------------------------------------------------------
# Sage order submission (API-first with Playwright fallback)
# ---------------------------------------------------------------------------


async def submit_order_to_sage(
    order_lines: list[dict[str, Any]],
    method: str | None = None,
) -> dict[str, Any]:
    """Submit a purchase order to Sage.

    Tries the formal REST API first. If unavailable, falls back to
    the Playwright portal bridge (reuses Sprint 1.6 infrastructure).

    Returns dict with sage_order_id, confirmation, method used.
    """
    use_method = method or _detect_submission_method()

    if use_method == "api":
        return await _submit_via_api(order_lines)
    else:
        return await _submit_via_playwright(order_lines)


def _detect_submission_method() -> str:
    """Detect whether Sage API is available; fall back to Playwright."""
    if getattr(settings, "SAGE_API_KEY", ""):
        return "api"
    return "playwright"


async def _submit_via_api(order_lines: list[dict[str, Any]]) -> dict[str, Any]:
    """Submit order via the Sage REST API (formal integration path)."""
    import httpx

    sage_api_url = getattr(settings, "SAGE_API_URL", "")
    sage_api_key = getattr(settings, "SAGE_API_KEY", "")

    payload = {
        "lines": [
            {
                "sku": line.get("sage_sku"),
                "quantity": line.get("quantity", 1),
                "unit_price": str(line.get("unit_cost", 0)),
                "description": line.get("description", ""),
            }
            for line in order_lines
            if line.get("sage_sku")
        ],
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{sage_api_url}/api/v1/purchase-orders",
            json=payload,
            headers={
                "Authorization": f"Bearer {sage_api_key}",
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        data = resp.json()

    return {
        "sage_order_id": data.get("order_id") or data.get("id"),
        "sage_confirmation": data.get("confirmation_number"),
        "method": "api",
        "line_ids": data.get("line_ids", []),
    }


async def _submit_via_playwright(order_lines: list[dict[str, Any]]) -> dict[str, Any]:
    """Submit order via Playwright portal automation (fallback path).

    Reuses the SagePlaywrightBridge from Sprint 1.6 to navigate
    the Sage ordering portal and submit a purchase order.
    """
    from app.services.sage_playwright import SagePlaywrightBridge

    bridge = SagePlaywrightBridge()
    try:
        page = await bridge._get_page()
        try:
            portal_url = bridge._portal_url

            # Navigate to order creation page
            await page.goto(f"{portal_url}/orders/new", timeout=30000)
            await page.wait_for_selector(
                'form[action*="order"], .order-form', timeout=15000
            )

            # Add each line item with a Sage SKU
            for i, line in enumerate(order_lines):
                sku = line.get("sage_sku")
                if not sku:
                    continue

                qty = line.get("quantity", 1)

                # Fill SKU search
                sku_input = await page.query_selector(
                    f'.line-item[data-index="{i}"] input[name*="sku"], '
                    'input[name*="sku"]:last-of-type'
                )
                if sku_input:
                    await sku_input.fill(sku)

                # Fill quantity
                qty_input = await page.query_selector(
                    f'.line-item[data-index="{i}"] input[name*="quantity"], '
                    'input[name*="quantity"]:last-of-type'
                )
                if qty_input:
                    await qty_input.fill(str(qty))

                # Click add line button if available
                add_btn = await page.query_selector(
                    'button.add-line, button[data-action="add-line"]'
                )
                if add_btn and i < len(order_lines) - 1:
                    await add_btn.click()
                    await page.wait_for_timeout(500)

            # Submit the order
            submit_btn = await page.query_selector(
                'button[type="submit"], button.submit-order'
            )
            if submit_btn:
                await submit_btn.click()

            # Wait for confirmation
            await page.wait_for_selector(
                ".order-confirmation, .confirmation-number", timeout=30000
            )

            confirmation_el = await page.query_selector(
                ".confirmation-number, [data-field='confirmation']"
            )
            confirmation = None
            if confirmation_el:
                confirmation = (await confirmation_el.text_content() or "").strip()

            order_id_el = await page.query_selector(
                ".order-id, [data-field='order-id']"
            )
            sage_order_id = None
            if order_id_el:
                sage_order_id = (await order_id_el.text_content() or "").strip()

            return {
                "sage_order_id": sage_order_id or f"PW-{uuid.uuid4().hex[:8].upper()}",
                "sage_confirmation": confirmation,
                "method": "playwright",
                "line_ids": [],
            }
        finally:
            await page.close()
    finally:
        await bridge.close()


# ---------------------------------------------------------------------------
# Sage status sync
# ---------------------------------------------------------------------------


async def sync_order_status_from_sage(
    sage_order_id: str,
) -> dict[str, Any]:
    """Poll Sage for the current status of an order.

    Returns dict with status, tracking info, and timestamps.
    """
    use_method = _detect_submission_method()

    if use_method == "api":
        return await _sync_status_via_api(sage_order_id)
    else:
        return await _sync_status_via_playwright(sage_order_id)


async def _sync_status_via_api(sage_order_id: str) -> dict[str, Any]:
    """Fetch order status from the Sage REST API."""
    import httpx

    sage_api_url = getattr(settings, "SAGE_API_URL", "")
    sage_api_key = getattr(settings, "SAGE_API_KEY", "")

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{sage_api_url}/api/v1/purchase-orders/{sage_order_id}",
            headers={"Authorization": f"Bearer {sage_api_key}"},
        )
        resp.raise_for_status()
        data = resp.json()

    sage_status = (data.get("status") or "").lower()
    status_map = {
        "pending": "submitted",
        "processing": "confirmed",
        "confirmed": "confirmed",
        "partial_ship": "partially_shipped",
        "shipped": "shipped",
        "delivered": "delivered",
        "cancelled": "cancelled",
    }

    return {
        "status": status_map.get(sage_status, "submitted"),
        "sage_confirmation": data.get("confirmation_number"),
        "tracking_number": data.get("tracking_number"),
        "estimated_delivery": data.get("estimated_delivery"),
        "line_statuses": data.get("line_statuses", []),
    }


async def _sync_status_via_playwright(sage_order_id: str) -> dict[str, Any]:
    """Scrape order status from the Sage portal (fallback)."""
    from app.services.sage_playwright import SagePlaywrightBridge

    bridge = SagePlaywrightBridge()
    try:
        page = await bridge._get_page()
        try:
            await page.goto(
                f"{bridge._portal_url}/orders/{sage_order_id}", timeout=30000
            )
            await page.wait_for_selector(
                ".order-status, [data-field='status']", timeout=15000
            )

            status_el = await page.query_selector(
                ".order-status, [data-field='status']"
            )
            raw_status = ""
            if status_el:
                raw_status = (await status_el.text_content() or "").strip().lower()

            status_map = {
                "pending": "submitted",
                "processing": "confirmed",
                "confirmed": "confirmed",
                "shipped": "shipped",
                "delivered": "delivered",
                "cancelled": "cancelled",
            }

            confirmation_el = await page.query_selector(
                ".confirmation-number, [data-field='confirmation']"
            )
            confirmation = None
            if confirmation_el:
                confirmation = (await confirmation_el.text_content() or "").strip()

            return {
                "status": status_map.get(raw_status, "submitted"),
                "sage_confirmation": confirmation,
                "tracking_number": None,
                "estimated_delivery": None,
                "line_statuses": [],
            }
        finally:
            await page.close()
    finally:
        await bridge.close()


# ---------------------------------------------------------------------------
# Order creation helpers
# ---------------------------------------------------------------------------


def snapshot_quote_items(quote_items: list[Any]) -> list[dict[str, Any]]:
    """Create order line item dicts from quote items (point-in-time snapshot)."""
    return [
        {
            "quote_item_id": item.id,
            "room": item.room,
            "trade_category": item.trade_category,
            "description": item.description,
            "sage_sku": item.sage_sku,
            "quantity": item.quantity or 1,
            "unit_cost": item.unit_cost,
            "labor_cost": item.labor_cost,
            "markup_pct": item.markup_pct,
            "subtotal": item.subtotal,
            "unit_of_measure": item.unit_of_measure,
        }
        for item in quote_items
    ]


def calculate_order_total(line_items: list[dict[str, Any]]) -> Decimal:
    """Sum subtotals from line item dicts."""
    total = Decimal("0")
    for item in line_items:
        subtotal = item.get("subtotal")
        if subtotal is not None:
            total += Decimal(str(subtotal))
    return total.quantize(Decimal("0.01"))
