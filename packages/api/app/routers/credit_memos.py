"""Credit memo endpoints — required cause-code + job-key capture (SAG-2805).

Enums for cause_code and qc_stage are validated by Pydantic at the request layer.
job_key is stored as-is; the /job-lookup endpoint lets callers confirm a job#
against existing Orders and pre-fill product_tier from the first line item.

Auto-population mapping:
  job_key      → Order.sage_order_id (the GCP-formatted job number)
  product_tier → first OrderLineItem.trade_category for that order (or None)
  rsm_id       → no source today; captured as manual entry
  territory_id → no source today; captured as manual entry
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import CurrentUser, ensure_tenant_exists, get_current_user
from app.database import get_db
from app.models import CreditMemo, Order
from app.schemas.credit_memo import (
    CreditMemoCreate,
    CreditMemoListResponse,
    CreditMemoResponse,
    JobLookupResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/credit-memos", tags=["credit-memos"])


# ---------------------------------------------------------------------------
# GET /credit-memos/job-lookup
# ---------------------------------------------------------------------------


@router.get("/job-lookup", response_model=JobLookupResponse)
async def job_lookup(
    job_number: str = Query(..., description="Sage order number to look up (e.g. GCP-001-20240425)"),
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> JobLookupResponse:
    """Look up a job# against existing Orders and return auto-population data."""
    tenant_id = current_user.effective_tenant_id

    result = await db.execute(
        select(Order)
        .where(Order.sage_order_id == job_number, Order.tenant_id == tenant_id)
        .options(selectinload(Order.line_items))
        .limit(1)
    )
    order = result.scalar_one_or_none()

    if order is None:
        return JobLookupResponse(found=False, job_key=None, product_tier=None)

    product_tier: str | None = None
    if order.line_items:
        product_tier = order.line_items[0].trade_category

    return JobLookupResponse(
        found=True,
        job_key=order.sage_order_id,
        product_tier=product_tier,
    )


# ---------------------------------------------------------------------------
# POST /credit-memos
# ---------------------------------------------------------------------------


@router.post("", response_model=CreditMemoResponse, status_code=201)
async def create_credit_memo(
    body: CreditMemoCreate,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CreditMemoResponse:
    """Create a credit memo. cause_code, job_key, and qc_stage are required."""
    tenant_id = await ensure_tenant_exists(db, current_user)

    memo = CreditMemo(
        tenant_id=tenant_id,
        cause_code=body.cause_code.value,
        job_key=body.job_key,
        qc_stage=body.qc_stage.value,
        rsm_id=body.rsm_id,
        territory_id=body.territory_id,
        product_tier=body.product_tier,
        amount=body.amount,
        description=body.description,
        created_by=current_user.user_id,
    )
    db.add(memo)
    await db.commit()
    await db.refresh(memo)
    return CreditMemoResponse.model_validate(memo)


# ---------------------------------------------------------------------------
# GET /credit-memos
# ---------------------------------------------------------------------------


@router.get("", response_model=CreditMemoListResponse)
async def list_credit_memos(
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CreditMemoListResponse:
    """List all credit memos for the current tenant."""
    tenant_id = current_user.effective_tenant_id

    count_result = await db.execute(
        select(func.count()).select_from(CreditMemo).where(CreditMemo.tenant_id == tenant_id)
    )
    total = count_result.scalar_one()

    items_result = await db.execute(
        select(CreditMemo)
        .where(CreditMemo.tenant_id == tenant_id)
        .order_by(CreditMemo.created_at.desc())
    )
    items = items_result.scalars().all()

    return CreditMemoListResponse(
        total=total,
        items=[CreditMemoResponse.model_validate(m) for m in items],
    )
