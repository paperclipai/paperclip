import pytest
from reconciler import ExchangeFetcher, FakeExchange


def test_fake_exchange_satisfies_protocol():
    fake = FakeExchange()
    fake.set_open_positions("MEXC", [
        {"symbol": "ORDIUSDT", "side": "buy", "size_usd": 25.0}
    ])
    fake.set_balance("MEXC", available_usd=49.5, locked_usd=0.5)
    fake.set_recent_fills("MEXC", [
        {"order_id": "m-1", "symbol": "ORDIUSDT", "side": "buy",
         "size_usd": 25.0, "fill_price": 1.234, "fees_usd": 0.01,
         "filled_at_ms": 1700000000500},
    ])

    # Protocol-style structural typing — FakeExchange is_a ExchangeFetcher
    fetcher: ExchangeFetcher = fake

    pos = fetcher.get_open_positions("MEXC")
    assert len(pos) == 1
    assert pos[0]["symbol"] == "ORDIUSDT"

    bal = fetcher.get_balance("MEXC")
    assert bal["available_usd"] == 49.5

    fills = fetcher.get_recent_fills("MEXC", since_ms=0)
    assert len(fills) == 1


def test_fake_exchange_unreachable():
    fake = FakeExchange()
    fake.set_unreachable("BLOFIN", error="connection refused")
    fetcher: ExchangeFetcher = fake
    with pytest.raises(ConnectionError):
        fetcher.get_open_positions("BLOFIN")
    with pytest.raises(ConnectionError):
        fetcher.get_balance("BLOFIN")
    with pytest.raises(ConnectionError):
        fetcher.get_recent_fills("BLOFIN", since_ms=0)


def test_fake_exchange_get_recent_fills_filters_by_since():
    fake = FakeExchange()
    fake.set_recent_fills("MEXC", [
        {"order_id": "o1", "filled_at_ms": 100},
        {"order_id": "o2", "filled_at_ms": 200},
        {"order_id": "o3", "filled_at_ms": 300},
    ])
    fetcher: ExchangeFetcher = fake
    fills = fetcher.get_recent_fills("MEXC", since_ms=150)
    assert {f["order_id"] for f in fills} == {"o2", "o3"}
