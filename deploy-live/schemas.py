"""Pydantic v2 models for every value crossing a layer boundary."""
from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator


class PositionRecord(BaseModel):
    id: int
    symbol: str
    exchange_a: str
    exchange_b: str
    side_a: Literal["buy", "sell"]
    side_b: Literal["buy", "sell"]
    size_usd_a: float = Field(gt=0)
    size_usd_b: float = Field(gt=0)
    entry_spread_pct: float = 0.0
    exit_spread_pct: Optional[float] = None
    status: Literal["opening", "open", "closing", "closed", "degraded", "failed"]
    opened_at_ms: int
    closed_at_ms: Optional[int] = None
    realized_pnl_usd: Optional[float] = None


class FillRecord(BaseModel):
    id: int
    position_id: int
    exchange: str
    leg: Literal["a", "b"]
    intent: Literal["entry", "exit"]
    order_id: str = Field(min_length=1)
    side: Literal["buy", "sell"]
    size_usd: float = Field(gt=0)
    fill_price: float = Field(gt=0)
    fees_usd: float = Field(ge=0)
    filled_at_ms: int


class AuditEntry(BaseModel):
    id: Optional[int] = None
    timestamp_ms: int
    event_type: str
    severity: Literal["info", "warn", "error", "critical"]
    position_id: Optional[int] = None
    exchange: Optional[str] = None
    symbol: Optional[str] = None
    message: str
    details: Optional[dict] = None


class BalanceSnapshot(BaseModel):
    exchange: str
    asset: str = "USDT"
    available_usd: float = Field(ge=0)
    locked_usd: float = Field(ge=0)
    snapshot_at_ms: int


class ExchangeHealthRecord(BaseModel):
    exchange: str
    status: Literal["ok", "degraded", "down"]
    last_ok_at_ms: Optional[int] = None
    last_error_at_ms: Optional[int] = None
    last_error_msg: Optional[str] = None
    consecutive_errors: int = Field(ge=0, default=0)


class ReconciliationEvent(BaseModel):
    id: Optional[int] = None
    timestamp_ms: int
    source: Literal["reconciler", "invariants"]
    category: str
    severity: Literal["info", "warn", "error", "critical"]
    exchange: Optional[str] = None
    symbol: Optional[str] = None
    position_id: Optional[int] = None
    expected: Optional[dict] = None
    actual: Optional[dict] = None
    notes: Optional[str] = None
    resolution: Literal["unresolved", "manual", "auto", "stale"] = "unresolved"


class ExchangeOrderResponse(BaseModel):
    exchange: Literal["OKX", "BYBIT", "MEXC", "BLOFIN"]
    success: bool
    order_id: str = Field(min_length=1)
    symbol: str
    side: Literal["buy", "sell"]
    requested_size_usd: float = Field(gt=0)
    filled_size_usd: float = Field(ge=0)
    fill_price: float = Field(ge=0)
    fees_usd: float = Field(ge=0)
    timestamp_ms: int
    raw: dict

    @field_validator("fill_price")
    @classmethod
    def price_required_when_filled(cls, v, info):
        if info.data.get("filled_size_usd", 0) > 0 and v <= 0:
            raise ValueError("fill_price must be > 0 when filled_size_usd > 0")
        return v
