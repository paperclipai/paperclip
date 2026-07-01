"""Pydantic schemas for order management endpoints."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Order Line Item
# ---------------------------------------------------------------------------


class OrderLineItemResponse(BaseModel):
    id: str
    order_id: str
    quote_item_id: str | None
    room: str | None
    trade_category: str | None
    description: str | None
    sage_sku: str | None
    quantity: int
    unit_cost: Decimal | None
    labor_cost: Decimal | None
    markup_pct: Decimal | None
    subtotal: Decimal | None
    sage_line_id: str | None
    unit_of_measure: str | None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Order Status History
# ---------------------------------------------------------------------------


class OrderStatusHistoryResponse(BaseModel):
    id: str
    order_id: str
    from_status: str | None
    to_status: str
    changed_by: str | None
    note: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Order
# ---------------------------------------------------------------------------


class SubmitOrderRequest(BaseModel):
    """Request to convert an approved quote into a Sage order."""

    submission_method: str | None = Field(
        None,
        pattern=r"^(api|playwright)$",
        description="Force submission method; auto-detected if omitted",
    )


class OrderResponse(BaseModel):
    id: str
    quote_id: str
    tenant_id: str
    property_id: str | None
    sage_order_id: str | None
    sage_confirmation: str | None
    d365_opportunity_id: str | None
    d365_opportunity_url: str | None
    status: str
    submission_method: str | None
    error_message: str | None
    retry_count: int
    total_amount: Decimal | None
    submitted_at: datetime | None
    confirmed_at: datetime | None
    shipped_at: datetime | None
    delivered_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OrderDetailResponse(OrderResponse):
    line_items: list[OrderLineItemResponse] = []
    status_history: list[OrderStatusHistoryResponse] = []


class OrderListResponse(BaseModel):
    items: list[OrderResponse]
    total: int


class D365OpportunityResponse(BaseModel):
    order_id: str
    d365_opportunity_id: str | None
    d365_opportunity_url: str | None
    status: str
    message: str
