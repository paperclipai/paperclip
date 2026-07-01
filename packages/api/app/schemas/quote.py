"""Pydantic schemas for quote builder endpoints."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Quote Item
# ---------------------------------------------------------------------------


class QuoteItemCreate(BaseModel):
    room: str | None = None
    trade_category: str | None = None
    description: str | None = None
    sage_sku: str | None = None
    quantity: int = Field(1, ge=1)
    unit_cost: Decimal = Field(..., ge=0)
    labor_cost: Decimal = Field(default=Decimal("0"), ge=0)
    markup_pct: Decimal | None = Field(None, ge=0, le=100)
    unit_of_measure: str | None = None


class QuoteItemUpdate(BaseModel):
    room: str | None = None
    trade_category: str | None = None
    description: str | None = None
    sage_sku: str | None = None
    quantity: int | None = Field(None, ge=1)
    unit_cost: Decimal | None = Field(None, ge=0)
    labor_cost: Decimal | None = Field(None, ge=0)
    markup_pct: Decimal | None = Field(None, ge=0, le=100)
    unit_of_measure: str | None = None


class QuoteItemResponse(BaseModel):
    id: str
    quote_id: str
    room: str | None
    trade_category: str | None
    description: str | None
    sage_sku: str | None
    quantity: int | None
    unit_cost: Decimal | None
    labor_cost: Decimal | None
    markup_pct: Decimal | None
    subtotal: Decimal | None
    ai_confidence: float | None
    is_ai_generated: bool
    unit_of_measure: str | None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Quote
# ---------------------------------------------------------------------------


class QuoteCreate(BaseModel):
    """Create a quote — set mode='ai' to auto-generate from photo analysis."""

    mode: str = Field(
        "manual",
        pattern=r"^(manual|ai)$",
        description="'manual' for blank quote, 'ai' to auto-populate from photo analysis",
    )
    deal_id: str | None = None
    photo_analysis_id: str | None = Field(
        None, description="Required when mode='ai'"
    )
    notes: str | None = None
    items: list[QuoteItemCreate] = Field(
        default_factory=list,
        description="Initial line items (manual mode only)",
    )
    platform_fee_pct: Decimal = Field(
        default=Decimal("0.05"),
        ge=0,
        le=1,
        description="Platform fee as a decimal (e.g. 0.05 = 5%)",
    )


class QuoteUpdate(BaseModel):
    status: str | None = Field(
        None, pattern=r"^(draft|submitted|approved|rejected)$"
    )
    notes: str | None = None
    platform_fee_pct: Decimal | None = Field(None, ge=0, le=1)
    add_items: list[QuoteItemCreate] = Field(default_factory=list)
    update_items: dict[str, QuoteItemUpdate] = Field(
        default_factory=dict,
        description="Map of item ID → fields to update",
    )
    remove_item_ids: list[str] = Field(default_factory=list)


class QuoteResponse(BaseModel):
    id: str
    property_id: str | None
    deal_id: str
    tenant_id: str
    status: str
    version: int
    total_material: Decimal | None
    total_labor: Decimal | None
    platform_fee: Decimal | None
    platform_fee_pct: Decimal | None
    tax_amount: Decimal | None
    grand_total: Decimal | None
    pdf_s3_key: str | None
    notes: str | None
    photo_analysis_id: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class QuoteDetailResponse(QuoteResponse):
    items: list[QuoteItemResponse] = []


class QuoteListResponse(BaseModel):
    items: list[QuoteResponse]
    total: int


class GenerateSOWResponse(BaseModel):
    quote_id: str
    pdf_s3_key: str
    message: str
