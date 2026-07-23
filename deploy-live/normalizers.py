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

    When a FILLED order reports cummulativeQuoteQty=0 but executedQty>0 the
    USD figure is missing from the exchange response and cannot be trusted
    (executedQty is base-currency, not USD). Mirror BloFin's silent-failure
    handling: flip success to False rather than fabricating a USD figure.
    """
    status = raw.get("status", "")
    success = status in _MEXC_FILLED_STATUSES
    filled_size_usd = float(raw.get("cummulativeQuoteQty", 0) or 0)
    fill_price = float(raw.get("price", 0) or 0)
    fees_usd = float(raw.get("fees", 0) or 0)
    side_raw = str(raw.get("side", "")).lower()
    if side_raw not in ("buy", "sell"):
        raise ValueError(f"unexpected MEXC side: {side_raw!r}")

    # FILLED but quote qty is zero while base qty is nonzero = missing USD field.
    # Refuse to invent a number; flip success off so callers don't treat this
    # as a successful fill. The cross-field validator on the schema would also
    # reject filled_size_usd>0 with fill_price=0, but we want explicit
    # failure semantics, not a ValidationError, so the caller can record
    # an unparseable_response event without exception handling.
    if success and filled_size_usd == 0 and float(raw.get("executedQty", 0) or 0) > 0:
        success = False
        filled_size_usd = 0.0
        fill_price = 0.0

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


def _strip_dash(symbol: str) -> str:
    """OKX / BloFin use 'BASE-QUOTE'; bot uses 'BASEQUOTE'."""
    return symbol.replace("-", "")


def normalize_okx_order(raw: dict[str, Any], *, requested_size_usd: float) -> ExchangeOrderResponse:
    state = str(raw.get("state", "")).lower()
    success = state in ("filled", "partially_filled")
    side_raw = str(raw.get("side", "")).lower()
    if side_raw not in ("buy", "sell"):
        raise ValueError(f"unexpected OKX side: {side_raw!r}")
    fee = float(raw.get("fee", 0) or 0)
    return ExchangeOrderResponse(
        exchange="OKX",
        success=success,
        order_id=str(raw.get("ordId", "")),
        symbol=_strip_dash(str(raw.get("instId", ""))),
        side=side_raw,
        requested_size_usd=requested_size_usd,
        filled_size_usd=float(raw.get("fillNotionalUsd", 0) or 0),
        fill_price=float(raw.get("avgPx", 0) or 0),
        fees_usd=abs(fee),  # OKX returns fees as negative numbers
        timestamp_ms=int(raw.get("uTime", 0) or 0),
        raw=raw,
    )


def normalize_bybit_order(raw: dict[str, Any], *, requested_size_usd: float) -> ExchangeOrderResponse:
    status = str(raw.get("orderStatus", "")).lower()
    success = status in ("filled", "partiallyfilled")
    side_raw = str(raw.get("side", "")).lower()
    if side_raw not in ("buy", "sell"):
        raise ValueError(f"unexpected Bybit side: {side_raw!r}")
    return ExchangeOrderResponse(
        exchange="BYBIT",
        success=success,
        order_id=str(raw.get("orderId", "")),
        symbol=str(raw.get("symbol", "")),
        side=side_raw,
        requested_size_usd=requested_size_usd,
        filled_size_usd=float(raw.get("cumExecValue", 0) or 0),
        fill_price=float(raw.get("avgPrice", 0) or 0),
        fees_usd=float(raw.get("cumExecFee", 0) or 0),
        timestamp_ms=int(raw.get("updatedTime", 0) or 0),
        raw=raw,
    )


def normalize_blofin_order(raw: dict[str, Any], *, requested_size_usd: float) -> ExchangeOrderResponse:
    """BloFin's silent-failure mode: state=filled but filledSize=0.

    The strategy needs to know if money actually moved, not what BloFin
    claims. Treat success as filledSize>0 AND state=filled, otherwise False.
    """
    state = str(raw.get("state", "")).lower()
    filled_size_usd = float(raw.get("filledQuoteSize", 0) or 0)
    success = state in ("filled", "partially_filled") and filled_size_usd > 0
    side_raw = str(raw.get("side", "")).lower()
    if side_raw not in ("buy", "sell"):
        raise ValueError(f"unexpected BloFin side: {side_raw!r}")
    fee = float(raw.get("fee", 0) or 0)
    return ExchangeOrderResponse(
        exchange="BLOFIN",
        success=success,
        order_id=str(raw.get("orderId", "")),
        symbol=_strip_dash(str(raw.get("instId", ""))),
        side=side_raw,
        requested_size_usd=requested_size_usd,
        filled_size_usd=filled_size_usd,
        fill_price=float(raw.get("averagePrice", 0) or 0),
        fees_usd=abs(fee),
        timestamp_ms=int(raw.get("updateTime", 0) or 0),
        raw=raw,
    )
