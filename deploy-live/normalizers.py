"""Per-exchange order-response normalizers.

Each function takes the raw exchange JSON and returns an `ExchangeOrderResponse`
pydantic model. Quirks per exchange (field names, partial-fill semantics,
status values) are contained here, not in the trading code.
"""
from __future__ import annotations

from typing import Any

from schemas import ExchangeOrderResponse


_MEXC_FILLED_STATUSES = {"FILLED", "PARTIALLY_FILLED"}


def normalize_mexc_order(raw: dict[str, Any], *, requested_size_usd: float) -> ExchangeOrderResponse:
    """Normalize a MEXC order response.

    MEXC returns base-quantity in `executedQty` and quote-quantity in
    `cummulativeQuoteQty` (note the typo in MEXC's API). We use the quote
    quantity as `filled_size_usd` since the strategy works in USD terms.

    When a FILLED order reports cummulativeQuoteQty=0 but executedQty>0 we
    fall back to executedQty so the ExchangeOrderResponse cross-field validator
    can detect the zero-price anomaly and raise ValidationError.
    """
    status = raw.get("status", "")
    success = status in _MEXC_FILLED_STATUSES
    filled_size_usd = float(raw.get("cummulativeQuoteQty", 0) or 0)
    fill_price = float(raw.get("price", 0) or 0)
    fees_usd = float(raw.get("fees", 0) or 0)
    side_raw = str(raw.get("side", "")).lower()
    if side_raw not in ("buy", "sell"):
        raise ValueError(f"unexpected MEXC side: {side_raw!r}")

    # If FILLED but quote qty is zero while base qty is nonzero, the quote
    # field is missing/corrupt.  Use executedQty as a non-zero sentinel so
    # the schema's price_required_when_filled validator fires on fill_price=0.
    if success and filled_size_usd == 0:
        executed_qty = float(raw.get("executedQty", 0) or 0)
        if executed_qty > 0:
            filled_size_usd = executed_qty

    return ExchangeOrderResponse(
        exchange="MEXC",
        success=success,
        order_id=str(raw.get("orderId", "")),
        symbol=str(raw.get("symbol", "")),
        side=side_raw,
        requested_size_usd=requested_size_usd,
        filled_size_usd=filled_size_usd,
        fill_price=fill_price,
        fees_usd=fees_usd,
        timestamp_ms=int(raw.get("transactTime", 0) or 0),
        raw=raw,
    )
