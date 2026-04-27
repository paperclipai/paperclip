import pytest
from pydantic import ValidationError
from normalizers import normalize_mexc_order


def test_mexc_normalizer_happy_path():
    raw = {
        "symbol": "ORDIUSDT",
        "orderId": "mexc-1234",
        "side": "BUY",
        "origQty": "20.0",
        "executedQty": "20.0",
        "price": "1.234",
        "cummulativeQuoteQty": "24.68",
        "fees": "0.0247",
        "transactTime": 1700000000000,
        "status": "FILLED",
    }
    r = normalize_mexc_order(raw, requested_size_usd=24.68)
    assert r.exchange == "MEXC"
    assert r.success is True
    assert r.order_id == "mexc-1234"
    assert r.symbol == "ORDIUSDT"
    assert r.side == "buy"
    assert r.filled_size_usd == pytest.approx(24.68)
    assert r.fill_price == pytest.approx(1.234)
    assert r.fees_usd == pytest.approx(0.0247)
    assert r.timestamp_ms == 1700000000000
    assert r.raw == raw


def test_mexc_normalizer_unfilled_rejected_status():
    raw = {
        "symbol": "ORDIUSDT",
        "orderId": "mexc-1235",
        "side": "BUY",
        "origQty": "20.0",
        "executedQty": "0.0",
        "price": "0",
        "cummulativeQuoteQty": "0",
        "fees": "0",
        "transactTime": 1700000000000,
        "status": "REJECTED",
    }
    r = normalize_mexc_order(raw, requested_size_usd=24.68)
    assert r.success is False
    assert r.filled_size_usd == 0.0
    assert r.fill_price == 0.0


def test_mexc_normalizer_partial_fill():
    raw = {
        "symbol": "ORDIUSDT",
        "orderId": "mexc-1236",
        "side": "SELL",
        "origQty": "20.0",
        "executedQty": "12.0",
        "price": "1.234",
        "cummulativeQuoteQty": "14.808",
        "fees": "0.0148",
        "transactTime": 1700000000500,
        "status": "PARTIALLY_FILLED",
    }
    r = normalize_mexc_order(raw, requested_size_usd=24.68)
    assert r.success is True
    assert r.side == "sell"
    assert r.filled_size_usd == pytest.approx(14.808)


def test_mexc_normalizer_filled_with_missing_quote_qty_fails_loud():
    """When MEXC reports FILLED but cummulativeQuoteQty=0 with executedQty>0,
    the USD figure cannot be trusted. Mirror BloFin's silent-failure handling:
    return success=False with filled_size_usd=0.0 (no fallback to executedQty,
    which is base-currency, not USD)."""
    raw = {
        "symbol": "ORDIUSDT",
        "orderId": "mexc-1237",
        "side": "BUY",
        "origQty": "20.0",
        "executedQty": "20.0",
        "price": "0",
        "cummulativeQuoteQty": "0",
        "fees": "0",
        "transactTime": 1700000000000,
        "status": "FILLED",
    }
    r = normalize_mexc_order(raw, requested_size_usd=24.68)
    assert r.success is False
    assert r.filled_size_usd == 0.0
    assert r.fill_price == 0.0


def test_mexc_normalizer_filled_with_quote_qty_but_zero_price_raises():
    """If quote qty is sane but price is zero, the cross-field validator
    on ExchangeOrderResponse still catches the inconsistency."""
    raw = {
        "symbol": "ORDIUSDT",
        "orderId": "mexc-1238",
        "side": "BUY",
        "origQty": "20.0",
        "executedQty": "20.0",
        "price": "0",
        "cummulativeQuoteQty": "24.68",
        "fees": "0",
        "transactTime": 1700000000000,
        "status": "FILLED",
    }
    with pytest.raises(ValidationError):
        normalize_mexc_order(raw, requested_size_usd=24.68)


from normalizers import normalize_okx_order, normalize_bybit_order, normalize_blofin_order


def test_okx_normalizer_happy_path():
    raw = {
        "instId": "ORDI-USDT",
        "ordId": "okx-9001",
        "side": "buy",
        "sz": "20",
        "fillSz": "20",
        "avgPx": "1.234",
        "fillPx": "1.234",
        "fillNotionalUsd": "24.68",
        "fee": "-0.0247",
        "uTime": "1700000000000",
        "state": "filled",
        "tgtCcy": "quote_ccy",
    }
    r = normalize_okx_order(raw, requested_size_usd=24.68)
    assert r.exchange == "OKX"
    assert r.success is True
    assert r.order_id == "okx-9001"
    assert r.symbol == "ORDIUSDT"
    assert r.side == "buy"
    assert r.filled_size_usd == pytest.approx(24.68)
    assert r.fill_price == pytest.approx(1.234)
    assert r.fees_usd == pytest.approx(0.0247)


def test_okx_normalizer_canceled_status():
    raw = {
        "instId": "ORDI-USDT",
        "ordId": "okx-9002",
        "side": "buy",
        "sz": "20", "fillSz": "0", "avgPx": "0", "fillPx": "0",
        "fillNotionalUsd": "0", "fee": "0",
        "uTime": "1700000000000", "state": "canceled",
    }
    r = normalize_okx_order(raw, requested_size_usd=24.68)
    assert r.success is False


def test_bybit_normalizer_happy_path():
    raw = {
        "symbol": "ORDIUSDT",
        "orderId": "bybit-7001",
        "side": "Buy",
        "qty": "20",
        "cumExecQty": "20",
        "avgPrice": "1.234",
        "cumExecValue": "24.68",
        "cumExecFee": "0.0247",
        "updatedTime": "1700000000000",
        "orderStatus": "Filled",
    }
    r = normalize_bybit_order(raw, requested_size_usd=24.68)
    assert r.exchange == "BYBIT"
    assert r.success is True
    assert r.order_id == "bybit-7001"
    assert r.side == "buy"
    assert r.filled_size_usd == pytest.approx(24.68)


def test_blofin_normalizer_happy_path():
    raw = {
        "instId": "ORDI-USDT",
        "orderId": "blofin-5001",
        "side": "buy",
        "size": "20",
        "filledSize": "20",
        "averagePrice": "1.234",
        "filledQuoteSize": "24.68",
        "fee": "-0.0247",
        "updateTime": "1700000000000",
        "state": "filled",
    }
    r = normalize_blofin_order(raw, requested_size_usd=24.68)
    assert r.exchange == "BLOFIN"
    assert r.success is True
    assert r.order_id == "blofin-5001"


def test_blofin_normalizer_silent_failure():
    """Reproduces the BloFin-silent-failure bug where state=filled but filledSize=0."""
    raw = {
        "instId": "ORDI-USDT",
        "orderId": "blofin-5002",
        "side": "buy",
        "size": "20",
        "filledSize": "0",
        "averagePrice": "0",
        "filledQuoteSize": "0",
        "fee": "0",
        "updateTime": "1700000000000",
        "state": "filled",
    }
    r = normalize_blofin_order(raw, requested_size_usd=24.68)
    # The exchange claimed success, but nothing actually filled.
    # Normalizer must surface this as success=False so reconciler catches it.
    assert r.success is False
    assert r.filled_size_usd == 0.0


# ---------------------------------------------------------------------------
# Tests for the real_trader.py call-site translation shapes
# (Approach B fix: futures/fill-dict fields translated before normalizer call)
# ---------------------------------------------------------------------------

def test_mexc_normalizer_accepts_futures_translated_shape():
    """Verify the translated dict that real_trader.py builds from MEXC futures
    _wait_for_fill (dealVol/dealAvgPrice/state:int/side:int) passes the normalizer."""
    # Simulate what real_trader.py constructs before calling normalize_mexc_order:
    # side=1 (open long) -> "BUY", state=3 (filled)
    deal_avg = 1.234
    deal_vol = 20.0
    translated = {
        "orderId": "mexc-futures-001",
        "symbol": "ORDIUSDT",
        "side": "BUY",
        "executedQty": str(deal_vol),
        "cummulativeQuoteQty": str(deal_vol * deal_avg),
        "price": str(deal_avg),
        "fees": "0.0247",
        "transactTime": 1700000000000,
        "status": "FILLED",
    }
    r = normalize_mexc_order(translated, requested_size_usd=24.68)
    assert r.exchange == "MEXC"
    assert r.success is True
    assert r.side == "buy"
    assert r.filled_size_usd == pytest.approx(deal_vol * deal_avg)
    assert r.fill_price == pytest.approx(deal_avg)


def test_mexc_normalizer_accepts_futures_translated_shape_sell():
    """MEXC futures side=3 (open short) -> translates to SELL."""
    deal_avg = 2.5
    deal_vol = 10.0
    translated = {
        "orderId": "mexc-futures-002",
        "symbol": "ORDIUSDT",
        "side": "SELL",
        "executedQty": str(deal_vol),
        "cummulativeQuoteQty": str(deal_vol * deal_avg),
        "price": str(deal_avg),
        "fees": "0.01",
        "transactTime": 1700000001000,
        "status": "FILLED",
    }
    r = normalize_mexc_order(translated, requested_size_usd=25.0)
    assert r.success is True
    assert r.side == "sell"


def test_blofin_normalizer_accepts_fillsz_avgpx_translated_shape():
    """Verify the translated dict that real_trader.py builds from BloFin
    _wait_for_fill (fillSz/avgPx) passes the normalizer via setdefault mapping."""
    # Simulate what real_trader.py constructs: copy fill dict, add aliased keys
    fill = {
        "instId": "ORDI-USDT",
        "orderId": "blofin-fill-001",
        "side": "buy",
        "fillSz": "24.68",
        "avgPx": "1.234",
        "fee": "-0.0247",
        "updateTime": "1700000000000",
        "state": "filled",
    }
    translated = dict(fill)
    translated.setdefault("filledQuoteSize", fill.get("fillSz", "0"))
    translated.setdefault("averagePrice", fill.get("avgPx", "0"))
    r = normalize_blofin_order(translated, requested_size_usd=24.68)
    assert r.exchange == "BLOFIN"
    assert r.success is True
    assert r.side == "buy"
    assert r.filled_size_usd == pytest.approx(24.68)
    assert r.fill_price == pytest.approx(1.234)
    assert r.fees_usd == pytest.approx(0.0247)
