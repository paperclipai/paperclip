"""Pydantic schemas for credit-memo reporting view (SAG-2806)."""

from __future__ import annotations

from decimal import Decimal
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ReportGranularity(str, Enum):
    daily = "daily"
    weekly = "weekly"


class ReportSegment(str, Enum):
    cause_code = "cause_code"
    territory_id = "territory_id"
    rsm_id = "rsm_id"
    product_tier = "product_tier"
    qc_stage = "qc_stage"


class ReportRow(BaseModel):
    period: str  # ISO date "2024-01-15" (daily) or "2024-W03" (weekly)
    segment_value: str | None
    dim2_value: str | None = None  # populated only in cross-tab mode
    credit_amount_total: Decimal
    memo_count: int


class ReportResponse(BaseModel):
    granularity: ReportGranularity
    segment_by: ReportSegment
    dim2: ReportSegment | None = None
    start_date: str
    end_date: str
    rows: list[ReportRow]
    total_credit_amount: Decimal
    total_memo_count: int
