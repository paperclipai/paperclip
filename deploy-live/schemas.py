"""Pydantic v2 models for every value crossing a layer boundary."""
from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field


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
