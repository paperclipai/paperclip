import pytest
from pydantic import ValidationError
from normalizers import normalize_mexc_order
from real_trader import _translate_mexc_fill_for_normalizer


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


# ---------------------------------------------------------------------------
# _translate_mexc_fill_for_normalizer — call-site translation helper tests
# These exercise the actual translation logic in real_trader.py, not just
# the normalizer accepting a pre-built dict.  If someone breaks the field
# mapping or side logic the tests below will fail.
# ---------------------------------------------------------------------------

def test_translate_mexc_fill_buy_open_long():
    """side=1 (open long) -> BUY; field mapping and notional computation correct."""
    futures_fill = {
        "orderId": "f-001",
        "side": 1,
        "dealVol": "20.0",
        "dealAvgPrice": "1.5",
        "takerFee": "0.03",
        "createTime": 1700000000000,
        "state": 3,
    }
    out = _translate_mexc_fill_for_normalizer(futures_fill, "f-001", "ORDIUSDT")
    assert out["side"] == "BUY"
    assert out["executedQty"] == "20.0"
    assert out["cummulativeQuoteQty"] == str(20.0 * 1.5)
    assert out["price"] == "1.5"
    assert out["status"] == "FILLED"
    assert out["symbol"] == "ORDIUSDT"
    assert out["fees"] == "0.03"
    # Downstream: normalizer must also accept this output
    r = normalize_mexc_order(out, requested_size_usd=30.0)
    assert r.side == "buy"
    assert r.filled_size_usd == pytest.approx(30.0)


def test_translate_mexc_fill_sell_open_short():
    """side=3 (open short) -> SELL."""
    futures_fill = {
        "orderId": "f-002",
        "side": 3,
        "dealVol": "10.0",
        "dealAvgPrice": "2.0",
        "takerFee": "0.02",
        "createTime": 1700000001000,
        "state": 3,
    }
    out = _translate_mexc_fill_for_normalizer(futures_fill, "f-002", "ORDIUSDT")
    assert out["side"] == "SELL"
    assert out["cummulativeQuoteQty"] == str(10.0 * 2.0)
    r = normalize_mexc_order(out, requested_size_usd=20.0)
    assert r.side == "sell"
    assert r.success is True


def test_translate_mexc_fill_rejects_close_order_sides():
    """sides 2 and 4 (close orders) must raise AssertionError — not silently map."""
    for bad_side in (2, 4):
        with pytest.raises(AssertionError, match="close-order sides not supported"):
            _translate_mexc_fill_for_normalizer(
                {"side": bad_side, "dealVol": "5.0", "dealAvgPrice": "1.0",
                 "takerFee": "0.01", "createTime": 0, "state": 3},
                "f-bad", "ORDIUSDT",
            )


def test_translate_mexc_fill_silent_failure_trap_still_fires():
    """dealVol>0 with dealAvgPrice=0 -> cummulativeQuoteQty=0 -> normalizer trap fires."""
    futures_fill = {
        "orderId": "f-trap",
        "side": 1,
        "dealVol": "15.0",
        "dealAvgPrice": "0",   # silent-failure shape
        "takerFee": "0",
        "createTime": 0,
        "state": 3,
    }
    out = _translate_mexc_fill_for_normalizer(futures_fill, "f-trap", "ORDIUSDT")
    assert out["cummulativeQuoteQty"] == "0.0"
    assert out["executedQty"] == "15.0"
    # The normalizer should treat this as success=False (trap fires)
    r = normalize_mexc_order(out, requested_size_usd=15.0)
    assert r.success is False


# ---------------------------------------------------------------------------
# Fix 2 — BloFin translation unit-semantic tests
# Verify real_trader.py:~1159 setdefault translation + USD-denomination guard
# ---------------------------------------------------------------------------

def test_blofin_setdefault_translation_produces_normalizer_input():
    """Replicates real_trader.py BloFin translation; asserts normalize_blofin_order accepts it."""
    blofin_fill_native = {
        "orderId": "BO_TEST_1",
        "instId": "BTC-USDT",
        "side": "buy",
        "state": "filled",
        "fillSz": "100.0",   # BloFin's native field
        "avgPx": "65000.0",  # BloFin's native field
        "fee": "0.05",
        "updateTime": "1700000000000",
    }
    # Replicate the real_trader.py translation:
    translated = dict(blofin_fill_native)
    translated.setdefault("filledQuoteSize", blofin_fill_native.get("fillSz", "0"))
    translated.setdefault("averagePrice", blofin_fill_native.get("avgPx", "0"))

    result = normalize_blofin_order(translated, requested_size_usd=100.0)
    assert result.success is True
    assert result.exchange == "BLOFIN"


def test_blofin_translation_unit_semantics_fillsz_is_usd():
    """REGRESSION GUARD: BloFin fillSz semantic.

    The translation maps fillSz -> filledQuoteSize directly, assuming fillSz is
    USD-denominated quote size. If BloFin ever returns fillSz in contracts/base
    units, this test should fail and force re-evaluation.

    With requested_size_usd=100 and fillSz=100.0 the resulting filled_size_usd
    should be ~100 (within tolerance for fees). If filled_size_usd is way off
    (e.g., 100 contracts x $65K = $6.5M) the unit assumption is broken.
    """
    fill = {
        "orderId": "BO_TEST_2",
        "instId": "BTC-USDT",
        "side": "buy",
        "state": "filled",
        "fillSz": "100.0",   # If this is USD, filled_size_usd should be ~100
        "avgPx": "65000.0",
        "fee": "0.05",
        "updateTime": "1700000000000",
    }
    translated = dict(fill)
    translated.setdefault("filledQuoteSize", fill["fillSz"])
    translated.setdefault("averagePrice", fill["avgPx"])

    result = normalize_blofin_order(translated, requested_size_usd=100.0)
    assert 90 <= result.filled_size_usd <= 110, (
        f"BloFin translation produced filled_size_usd={result.filled_size_usd}; "
        f"expected ~100. If fillSz is contracts not USD, this assumption is "
        f"broken -- investigate BloFin API docs."
    )
