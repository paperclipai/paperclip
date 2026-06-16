"""Order management endpoints — Sage order submission, status tracking, D365 integration."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import CurrentUser, ensure_tenant_exists, get_current_user
from app.database import get_db
from app.models import (
    Order,
    OrderLineItem,
    OrderStatusHistory,
    PlatformFee,
    Property,
    Quote,
    QuoteItem,
)
from app.schemas.order import (
    D365OpportunityResponse,
    OrderDetailResponse,
    OrderListResponse,
    OrderResponse,
    SubmitOrderRequest,
)
from app.services.order_service import (
    MAX_RETRY_COUNT,
    calculate_order_total,
    snapshot_quote_items,
    submit_order_to_sage,
    sync_order_status_from_sage,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["orders"])


def _ensure_tenant(user: CurrentUser) -> str:
    return user.effective_tenant_id


# ---------------------------------------------------------------------------
# POST /quotes/{quote_id}/submit-order
# ---------------------------------------------------------------------------


@router.post(
    "/quotes/{quote_id}/submit-order",
    response_model=OrderDetailResponse,
    status_code=201,
)
async def submit_order(
    quote_id: str,
    body: SubmitOrderRequest = SubmitOrderRequest(),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Order:
    """Convert an approved quote into a Sage purchase order."""
    tenant_id = await ensure_tenant_exists(db, user)

    # Load quote with items
    result = await db.execute(
        select(Quote)
        .where(Quote.id == quote_id, Quote.tenant_id == tenant_id)
        .options(selectinload(Quote.items))
    )
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if quote.status != "approved":
        raise HTTPException(
            status_code=400,
            detail=f"Quote must be approved before ordering (current: {quote.status})",
        )

    # Snapshot quote items into order line items
    item_snapshots = snapshot_quote_items(quote.items)
    total = calculate_order_total(item_snapshots)

    # Create order
    order = Order(
        quote_id=quote.id,
        tenant_id=tenant_id,
        property_id=quote.property_id,
        status="pending",
        total_amount=total,
    )
    db.add(order)
    await db.flush()

    # Create line items
    for snap in item_snapshots:
        li = OrderLineItem(order_id=order.id, **snap)
        db.add(li)

    # Record initial status
    db.add(OrderStatusHistory(
        order_id=order.id,
        from_status=None,
        to_status="pending",
        changed_by="system",
        note="Order created from approved quote",
    ))

    # Create platform fee record
    if quote.platform_fee:
        db.add(PlatformFee(
            order_id=order.id,
            amount=quote.platform_fee,
            fee_type="platform",
        ))

    await db.flush()

    # Attempt Sage submission
    try:
        sage_result = await submit_order_to_sage(
            item_snapshots, method=body.submission_method
        )
        order.sage_order_id = sage_result.get("sage_order_id")
        order.sage_confirmation = sage_result.get("sage_confirmation")
        order.submission_method = sage_result.get("method")
        order.status = "submitted"
        order.submitted_at = datetime.now(timezone.utc)
        order.error_message = None

        # Map Sage line IDs back if returned
        sage_line_ids = sage_result.get("line_ids", [])
        if sage_line_ids:
            line_items_result = await db.execute(
                select(OrderLineItem)
                .where(OrderLineItem.order_id == order.id)
                .order_by(OrderLineItem.id)
            )
            line_items = line_items_result.scalars().all()
            for li, sage_lid in zip(line_items, sage_line_ids):
                li.sage_line_id = str(sage_lid)

        db.add(OrderStatusHistory(
            order_id=order.id,
            from_status="pending",
            to_status="submitted",
            changed_by="system",
            note=f"Submitted to Sage via {order.submission_method}",
        ))

    except Exception as exc:
        logger.error("Sage submission failed for order %s: %s", order.id, exc)
        order.status = "failed"
        order.error_message = str(exc)[:500]
        order.retry_count += 1

        db.add(OrderStatusHistory(
            order_id=order.id,
            from_status="pending",
            to_status="failed",
            changed_by="system",
            note=f"Sage submission failed: {str(exc)[:200]}",
        ))

    await db.flush()

    # Reload with relationships
    result = await db.execute(
        select(Order)
        .where(Order.id == order.id)
        .options(
            selectinload(Order.line_items),
            selectinload(Order.status_history),
        )
    )
    return result.scalar_one()


# ---------------------------------------------------------------------------
# GET /orders
# ---------------------------------------------------------------------------


@router.get("/orders", response_model=OrderListResponse)
async def list_orders(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    status: str | None = Query(None),
    property_id: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> OrderListResponse:
    """List orders with optional filters."""
    tenant_id = await ensure_tenant_exists(db, user)

    base = select(Order).where(Order.tenant_id == tenant_id)
    if status:
        base = base.where(Order.status == status)
    if property_id:
        base = base.where(Order.property_id == property_id)

    count_q = select(func.count()).select_from(base.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    q = base.order_by(Order.created_at.desc()).offset(offset).limit(limit)
    rows = (await db.execute(q)).scalars().all()

    return OrderListResponse(items=list(rows), total=total)


# ---------------------------------------------------------------------------
# GET /orders/{order_id}
# ---------------------------------------------------------------------------


@router.get("/orders/{order_id}", response_model=OrderDetailResponse)
async def get_order(
    order_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Order:
    """Get order detail with line items and status history."""
    tenant_id = await ensure_tenant_exists(db, user)

    result = await db.execute(
        select(Order)
        .where(Order.id == order_id, Order.tenant_id == tenant_id)
        .options(
            selectinload(Order.line_items),
            selectinload(Order.status_history),
        )
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


# ---------------------------------------------------------------------------
# POST /orders/{order_id}/sync-status
# ---------------------------------------------------------------------------


@router.post("/orders/{order_id}/sync-status", response_model=OrderDetailResponse)
async def sync_status(
    order_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Order:
    """Refresh order status from Sage."""
    tenant_id = await ensure_tenant_exists(db, user)

    result = await db.execute(
        select(Order)
        .where(Order.id == order_id, Order.tenant_id == tenant_id)
        .options(
            selectinload(Order.line_items),
            selectinload(Order.status_history),
        )
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if not order.sage_order_id:
        raise HTTPException(
            status_code=400, detail="Order has no Sage order ID to sync"
        )

    try:
        sage_status = await sync_order_status_from_sage(order.sage_order_id)
        new_status = sage_status["status"]

        if new_status != order.status:
            old_status = order.status
            order.status = new_status

            # Update lifecycle timestamps
            now = datetime.now(timezone.utc)
            if new_status == "confirmed" and not order.confirmed_at:
                order.confirmed_at = now
            elif new_status == "shipped" and not order.shipped_at:
                order.shipped_at = now
            elif new_status == "delivered" and not order.delivered_at:
                order.delivered_at = now

            if sage_status.get("sage_confirmation"):
                order.sage_confirmation = sage_status["sage_confirmation"]

            db.add(OrderStatusHistory(
                order_id=order.id,
                from_status=old_status,
                to_status=new_status,
                changed_by="sage_sync",
                note=f"Status synced from Sage",
            ))

        order.error_message = None
        await db.flush()

    except Exception as exc:
        logger.error("Sage status sync failed for order %s: %s", order.id, exc)
        order.error_message = f"Sync failed: {str(exc)[:300]}"
        await db.flush()

    # Reload
    result = await db.execute(
        select(Order)
        .where(Order.id == order.id)
        .options(
            selectinload(Order.line_items),
            selectinload(Order.status_history),
        )
    )
    return result.scalar_one()


# ---------------------------------------------------------------------------
# POST /orders/{order_id}/create-opportunity
# ---------------------------------------------------------------------------


@router.post(
    "/orders/{order_id}/create-opportunity",
    response_model=D365OpportunityResponse,
)
async def create_opportunity(
    order_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> D365OpportunityResponse:
    """Create a D365 opportunity from an order."""
    from app.services.d365_service import create_d365_opportunity

    tenant_id = await ensure_tenant_exists(db, user)

    result = await db.execute(
        select(Order).where(Order.id == order_id, Order.tenant_id == tenant_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.d365_opportunity_id:
        return D365OpportunityResponse(
            order_id=order.id,
            d365_opportunity_id=order.d365_opportunity_id,
            d365_opportunity_url=order.d365_opportunity_url,
            status="already_exists",
            message="D365 opportunity already created for this order",
        )

    # Get property info for D365 mapping
    property_data = None
    if order.property_id:
        prop_result = await db.execute(
            select(Property).where(Property.id == order.property_id)
        )
        prop = prop_result.scalar_one_or_none()
        if prop:
            property_data = {
                "id": prop.id,
                "address": prop.address,
                "city": prop.city,
                "state": prop.state,
                "zip": prop.zip,
                "property_type": prop.property_type,
                "sqft": prop.sqft,
                "beds": prop.beds,
                "baths": prop.baths,
                "arv_estimate": prop.arv_estimate,
            }

    # Get quote info
    quote_data = None
    quote_result = await db.execute(
        select(Quote).where(Quote.id == order.quote_id)
    )
    quote = quote_result.scalar_one_or_none()
    if quote:
        quote_data = {
            "id": quote.id,
            "grand_total": quote.grand_total,
            "total_material": quote.total_material,
            "total_labor": quote.total_labor,
        }

    order_data = {
        "id": order.id,
        "quote_id": order.quote_id,
        "sage_order_id": order.sage_order_id,
        "total_amount": order.total_amount,
        "status": order.status,
    }

    try:
        d365_result = await create_d365_opportunity(
            order_data, property_data, quote_data
        )
        order.d365_opportunity_id = d365_result["opportunity_id"]
        order.d365_opportunity_url = d365_result.get("opportunity_url")
        await db.flush()

        return D365OpportunityResponse(
            order_id=order.id,
            d365_opportunity_id=order.d365_opportunity_id,
            d365_opportunity_url=order.d365_opportunity_url,
            status="created",
            message="D365 opportunity created successfully",
        )

    except Exception as exc:
        logger.error("D365 opportunity creation failed for order %s: %s", order.id, exc)
        raise HTTPException(
            status_code=502,
            detail=f"D365 opportunity creation failed: {str(exc)[:300]}",
        )


# ---------------------------------------------------------------------------
# GET /orders/{order_id}/opportunity
# ---------------------------------------------------------------------------


@router.get(
    "/orders/{order_id}/opportunity",
    response_model=D365OpportunityResponse,
)
async def get_opportunity_status(
    order_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> D365OpportunityResponse:
    """Get D365 opportunity status for an order."""
    from app.services.d365_service import get_d365_opportunity_status

    tenant_id = await ensure_tenant_exists(db, user)

    result = await db.execute(
        select(Order).where(Order.id == order_id, Order.tenant_id == tenant_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if not order.d365_opportunity_id:
        raise HTTPException(
            status_code=404,
            detail="No D365 opportunity exists for this order",
        )

    try:
        status = await get_d365_opportunity_status(order.d365_opportunity_id)
        return D365OpportunityResponse(
            order_id=order.id,
            d365_opportunity_id=order.d365_opportunity_id,
            d365_opportunity_url=order.d365_opportunity_url,
            status=status.get("state", "unknown"),
            message=f"Opportunity: {status.get('name', 'N/A')}",
        )

    except Exception as exc:
        logger.error("D365 status fetch failed for order %s: %s", order.id, exc)
        raise HTTPException(
            status_code=502,
            detail=f"D365 status fetch failed: {str(exc)[:300]}",
        )
