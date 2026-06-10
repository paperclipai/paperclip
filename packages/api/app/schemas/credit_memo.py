"""Pydantic schemas for credit memo endpoints."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field


class CauseCode(str, Enum):
    MEAS_FAB = "MEAS-FAB"
    MEAS_TEMPLATE = "MEAS-TEMPLATE"
    EDGE_CHIP = "EDGE-CHIP"
    POLISH = "POLISH"
    CUTOUT = "CUTOUT"
    INSTALL_DAMAGE = "INSTALL-DAMAGE"
    HIDDEN_DEFECT = "HIDDEN-DEFECT"
    CLIENT_DAMAGE = "CLIENT-DAMAGE"
    SLAB_DEFECT = "SLAB-DEFECT"
    DELIVERY_DAMAGE = "DELIVERY-DAMAGE"
    OTHER = "OTHER"


class QcStage(str, Enum):
    FAB = "fab"
    PRE_SHIP = "pre-ship"
    INSTALL = "install"
    POST_INSTALL = "post-install"


class CreditMemoCreate(BaseModel):
    cause_code: CauseCode
    job_key: str = Field(..., min_length=1)
    qc_stage: QcStage
    rsm_id: str | None = None
    territory_id: str | None = None
    product_tier: str | None = None
    amount: Decimal | None = None
    description: str | None = None


class CreditMemoResponse(BaseModel):
    id: str
    tenant_id: str
    cause_code: str
    job_key: str
    qc_stage: str
    rsm_id: str | None
    territory_id: str | None
    product_tier: str | None
    amount: Decimal | None
    description: str | None
    created_by: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CreditMemoListResponse(BaseModel):
    total: int
    items: list[CreditMemoResponse]


class JobLookupResponse(BaseModel):
    found: bool
    job_key: str | None
    product_tier: str | None
    rsm_id: str | None = None
    territory_id: str | None = None
