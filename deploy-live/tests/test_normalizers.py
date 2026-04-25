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


def test_mexc_normalizer_filled_with_zero_price_raises():
    """Cross-field validator on ExchangeOrderResponse must reject this."""
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
    with pytest.raises(ValidationError):
        normalize_mexc_order(raw, requested_size_usd=24.68)
