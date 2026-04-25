import pytest
from pydantic import ValidationError
from schemas import PositionRecord, FillRecord


def test_position_record_happy_path():
    p = PositionRecord(
        id=1, symbol="ORDIUSDT",
        exchange_a="MEXC", exchange_b="BLOFIN",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        status="open", opened_at_ms=1700000000000,
    )
    assert p.symbol == "ORDIUSDT"
    assert p.closed_at_ms is None


def test_position_record_rejects_zero_size():
    with pytest.raises(ValidationError):
        PositionRecord(
            id=1, symbol="X",
            exchange_a="A", exchange_b="B",
            side_a="buy", side_b="sell",
            size_usd_a=0, size_usd_b=25.0,
            status="open", opened_at_ms=1,
        )


def test_position_record_rejects_invalid_status():
    with pytest.raises(ValidationError):
        PositionRecord(
            id=1, symbol="X",
            exchange_a="A", exchange_b="B",
            side_a="buy", side_b="sell",
            size_usd_a=25.0, size_usd_b=25.0,
            status="bogus", opened_at_ms=1,
        )


def test_fill_record_happy_path():
    f = FillRecord(
        id=1, position_id=1, exchange="MEXC",
        leg="a", intent="entry", order_id="abc123",
        side="buy", size_usd=25.0, fill_price=1.234,
        fees_usd=0.01, filled_at_ms=1700000000000,
    )
    assert f.order_id == "abc123"


def test_fill_record_rejects_zero_fill_price():
    with pytest.raises(ValidationError):
        FillRecord(
            id=1, position_id=1, exchange="MEXC",
            leg="a", intent="entry", order_id="abc",
            side="buy", size_usd=25.0, fill_price=0,
            fees_usd=0.01, filled_at_ms=1,
        )


def test_fill_record_rejects_zero_size():
    with pytest.raises(ValidationError):
        FillRecord(
            id=1, position_id=1, exchange="MEXC",
            leg="a", intent="entry", order_id="abc",
            side="buy", size_usd=0, fill_price=1.0,
            fees_usd=0.01, filled_at_ms=1,
        )
