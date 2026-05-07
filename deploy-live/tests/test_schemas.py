import pytest
from pydantic import ValidationError
from schemas import (
    PositionRecord, FillRecord,
    AuditEntry, BalanceSnapshot, ExchangeHealthRecord,
    ReconciliationEvent, ExchangeOrderResponse,
)


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


def test_audit_entry_happy_path():
    a = AuditEntry(
        timestamp_ms=1, event_type="entry_attempt",
        severity="info", message="ok",
    )
    assert a.severity == "info"
    assert a.position_id is None
    assert a.id is None


def test_audit_entry_rejects_invalid_severity():
    with pytest.raises(ValidationError):
        AuditEntry(timestamp_ms=1, event_type="x", severity="oops", message="m")


def test_balance_snapshot_rejects_negative():
    with pytest.raises(ValidationError):
        BalanceSnapshot(
            exchange="MEXC", asset="USDT",
            available_usd=-1.0, locked_usd=0.0, snapshot_at_ms=1,
        )


def test_exchange_health_record_happy_path():
    h = ExchangeHealthRecord(
        exchange="MEXC", status="ok", consecutive_errors=0,
    )
    assert h.last_ok_at_ms is None


def test_reconciliation_event_happy_path():
    e = ReconciliationEvent(
        timestamp_ms=1, source="reconciler",
        category="orphan_leg", severity="error",
    )
    assert e.expected is None
    assert e.id is None


def test_exchange_order_response_requires_price_when_filled():
    with pytest.raises(ValidationError):
        ExchangeOrderResponse(
            exchange="MEXC", success=True, order_id="x",
            symbol="ORDIUSDT", side="buy",
            requested_size_usd=25.0, filled_size_usd=25.0,
            fill_price=0.0, fees_usd=0.01,
            timestamp_ms=1, raw={},
        )


def test_exchange_order_response_zero_price_ok_when_unfilled():
    r = ExchangeOrderResponse(
        exchange="MEXC", success=False, order_id="x",
        symbol="ORDIUSDT", side="buy",
        requested_size_usd=25.0, filled_size_usd=0.0,
        fill_price=0.0, fees_usd=0.0,
        timestamp_ms=1, raw={"err": "rejected"},
    )
    assert r.success is False
