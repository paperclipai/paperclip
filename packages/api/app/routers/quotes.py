"""Quote builder endpoints — create, read, update quotes + PDF SOW generation."""

from __future__ import annotations

import logging
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import CurrentUser, ensure_tenant_exists, get_current_user
from app.database import get_db
from app.models import (
    Deal,
    PhotoLabel,
    Property,
    PropertyPhotoAnalysis,
    Quote,
    QuoteItem,
)
from app.schemas.quote import (
    GenerateSOWResponse,
    QuoteCreate,
    QuoteDetailResponse,
    QuoteListResponse,
    QuoteResponse,
    QuoteUpdate,
)
from app.services.quote_service import (
    calculate_item_subtotal,
    calculate_quote_totals,
    download_sow_from_s3,
    generate_ai_line_items,
    generate_sow_pdf,
    upload_sow_to_s3,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["quotes"])


def _ensure_tenant(user: CurrentUser) -> str:
    return user.effective_tenant_id


# ---------------------------------------------------------------------------
# POST /properties/{property_id}/quotes
# ---------------------------------------------------------------------------


@router.post(
    "/properties/{property_id}/quotes",
    response_model=QuoteDetailResponse,
    status_code=201,
)
async def create_quote(
    property_id: str,
    body: QuoteCreate,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Quote:
    """Create a quote for a property — manual or AI-populated."""
    tenant_id = await ensure_tenant_exists(db, user)

    # Verify property
    prop_result = await db.execute(
        select(Property).where(
            Property.id == property_id, Property.tenant_id == tenant_id
        )
    )
    prop = prop_result.scalar_one_or_none()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    # Resolve deal — use provided deal_id or find/create one for this property
    deal_id = body.deal_id
    if not deal_id:
        deal_result = await db.execute(
            select(Deal).where(
                Deal.property_id == property_id, Deal.tenant_id == tenant_id
            ).limit(1)
        )
        deal = deal_result.scalar_one_or_none()
        if not deal:
            deal = Deal(tenant_id=tenant_id, property_id=property_id, status="prospect")
            db.add(deal)
            await db.flush()
        deal_id = deal.id
    else:
        deal_result = await db.execute(
            select(Deal).where(Deal.id == deal_id, Deal.tenant_id == tenant_id)
        )
        if not deal_result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Deal not found")

    # Create quote
    quote = Quote(
        deal_id=deal_id,
        tenant_id=tenant_id,
        property_id=property_id,
        status="draft",
        version=1,
        notes=body.notes,
        platform_fee_pct=body.platform_fee_pct,
    )

    # AI mode: generate line items from photo analysis
    if body.mode == "ai":
        if not body.photo_analysis_id:
            raise HTTPException(
                status_code=400,
                detail="photo_analysis_id is required for AI mode",
            )

        analysis_result = await db.execute(
            select(PropertyPhotoAnalysis)
            .where(
                PropertyPhotoAnalysis.id == body.photo_analysis_id,
                PropertyPhotoAnalysis.property_id == property_id,
                PropertyPhotoAnalysis.status == "completed",
            )
            .options(selectinload(PropertyPhotoAnalysis.labels))
        )
        analysis = analysis_result.scalar_one_or_none()
        if not analysis:
            raise HTTPException(
                status_code=404,
                detail="Completed photo analysis not found for this property",
            )

        quote.photo_analysis_id = analysis.id

        # Convert labels to dicts for the AI generator
        label_dicts = [
            {
                "room_type": lbl.room_type,
                "condition": lbl.condition,
                "damage_issues": lbl.damage_issues,
                "renovation_needed": lbl.renovation_needed,
                "confidence": lbl.confidence,
            }
            for lbl in analysis.labels
        ]
        ai_items = generate_ai_line_items(label_dicts)

        db.add(quote)
        await db.flush()

        for item_data in ai_items:
            subtotal = calculate_item_subtotal(
                item_data["quantity"],
                item_data["unit_cost"],
                item_data["labor_cost"],
                item_data.get("markup_pct"),
            )
            qi = QuoteItem(
                quote_id=quote.id,
                room=item_data["room"],
                trade_category=item_data["trade_category"],
                description=item_data["description"],
                sage_sku=item_data.get("sage_sku"),
                quantity=item_data["quantity"],
                unit_cost=item_data["unit_cost"],
                labor_cost=item_data["labor_cost"],
                markup_pct=item_data.get("markup_pct"),
                subtotal=subtotal,
                ai_confidence=item_data.get("ai_confidence"),
                is_ai_generated=True,
                unit_of_measure=item_data.get("unit_of_measure"),
            )
            db.add(qi)

    else:
        # Manual mode
        db.add(quote)
        await db.flush()

        for item_data in body.items:
            subtotal = calculate_item_subtotal(
                item_data.quantity,
                item_data.unit_cost,
                item_data.labor_cost,
                item_data.markup_pct,
            )
            qi = QuoteItem(
                quote_id=quote.id,
                room=item_data.room,
                trade_category=item_data.trade_category,
                description=item_data.description,
                sage_sku=item_data.sage_sku,
                quantity=item_data.quantity,
                unit_cost=item_data.unit_cost,
                labor_cost=item_data.labor_cost,
                markup_pct=item_data.markup_pct,
                subtotal=subtotal,
                is_ai_generated=False,
                unit_of_measure=item_data.unit_of_measure,
            )
            db.add(qi)

    await db.flush()

    # Recalculate totals
    await _recalculate_totals(db, quote)

    # Reload with items
    result = await db.execute(
        select(Quote)
        .where(Quote.id == quote.id)
        .options(selectinload(Quote.items))
    )
    return result.scalar_one()


# ---------------------------------------------------------------------------
# GET /properties/{property_id}/quotes
# ---------------------------------------------------------------------------


@router.get(
    "/properties/{property_id}/quotes",
    response_model=QuoteListResponse,
)
async def list_quotes(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    status: str | None = Query(None, pattern=r"^(draft|submitted|approved|rejected)$"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> QuoteListResponse:
    """List quotes for a property."""
    tenant_id = await ensure_tenant_exists(db, user)

    # Verify property
    prop_result = await db.execute(
        select(Property).where(
            Property.id == property_id, Property.tenant_id == tenant_id
        )
    )
    if not prop_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Property not found")

    base = select(Quote).where(
        Quote.property_id == property_id, Quote.tenant_id == tenant_id
    )
    if status:
        base = base.where(Quote.status == status)

    # Count
    count_q = select(func.count()).select_from(base.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    # Fetch
    q = base.order_by(Quote.created_at.desc()).offset(offset).limit(limit)
    rows = (await db.execute(q)).scalars().all()

    return QuoteListResponse(items=list(rows), total=total)


# ---------------------------------------------------------------------------
# GET /quotes/{quote_id}
# ---------------------------------------------------------------------------


@router.get(
    "/quotes/{quote_id}",
    response_model=QuoteDetailResponse,
)
async def get_quote(
    quote_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Quote:
    """Get a single quote with line items."""
    tenant_id = await ensure_tenant_exists(db, user)

    result = await db.execute(
        select(Quote)
        .where(Quote.id == quote_id, Quote.tenant_id == tenant_id)
        .options(selectinload(Quote.items))
    )
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote


# ---------------------------------------------------------------------------
# PATCH /quotes/{quote_id}
# ---------------------------------------------------------------------------


@router.patch(
    "/quotes/{quote_id}",
    response_model=QuoteDetailResponse,
)
async def update_quote(
    quote_id: str,
    body: QuoteUpdate,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Quote:
    """Update quote status, notes, or line items."""
    tenant_id = await ensure_tenant_exists(db, user)

    result = await db.execute(
        select(Quote)
        .where(Quote.id == quote_id, Quote.tenant_id == tenant_id)
        .options(selectinload(Quote.items))
    )
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    # Status change
    if body.status is not None:
        quote.status = body.status

    if body.notes is not None:
        quote.notes = body.notes

    if body.platform_fee_pct is not None:
        quote.platform_fee_pct = body.platform_fee_pct

    # Remove items
    if body.remove_item_ids:
        existing_ids = {item.id for item in quote.items}
        for item_id in body.remove_item_ids:
            if item_id not in existing_ids:
                raise HTTPException(
                    status_code=404, detail=f"Item {item_id} not found on this quote"
                )
        quote.items = [i for i in quote.items if i.id not in set(body.remove_item_ids)]

    # Update items
    if body.update_items:
        item_map = {item.id: item for item in quote.items}
        for item_id, updates in body.update_items.items():
            qi = item_map.get(item_id)
            if not qi:
                raise HTTPException(
                    status_code=404, detail=f"Item {item_id} not found on this quote"
                )
            update_data = updates.model_dump(exclude_none=True)
            for field, value in update_data.items():
                setattr(qi, field, value)
            qi.subtotal = calculate_item_subtotal(
                qi.quantity or 1,
                Decimal(str(qi.unit_cost or 0)),
                Decimal(str(qi.labor_cost or 0)),
                Decimal(str(qi.markup_pct)) if qi.markup_pct else None,
            )

    # Add items
    for item_data in body.add_items:
        subtotal = calculate_item_subtotal(
            item_data.quantity,
            item_data.unit_cost,
            item_data.labor_cost,
            item_data.markup_pct,
        )
        qi = QuoteItem(
            quote_id=quote.id,
            room=item_data.room,
            trade_category=item_data.trade_category,
            description=item_data.description,
            sage_sku=item_data.sage_sku,
            quantity=item_data.quantity,
            unit_cost=item_data.unit_cost,
            labor_cost=item_data.labor_cost,
            markup_pct=item_data.markup_pct,
            subtotal=subtotal,
            is_ai_generated=False,
            unit_of_measure=item_data.unit_of_measure,
        )
        db.add(qi)

    # Bump version on any item changes
    if body.add_items or body.update_items or body.remove_item_ids:
        quote.version += 1

    await db.flush()
    await _recalculate_totals(db, quote)

    # Expire cached relationships so reload picks up new items
    await db.refresh(quote)

    # Reload with items
    result = await db.execute(
        select(Quote)
        .where(Quote.id == quote.id)
        .options(selectinload(Quote.items))
    )
    return result.scalar_one()


# ---------------------------------------------------------------------------
# POST /quotes/{quote_id}/generate-sow
# ---------------------------------------------------------------------------


@router.post(
    "/quotes/{quote_id}/generate-sow",
    response_model=GenerateSOWResponse,
)
async def generate_sow(
    quote_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GenerateSOWResponse:
    """Generate a PDF Scope of Work for a quote and upload to S3."""
    tenant_id = await ensure_tenant_exists(db, user)

    result = await db.execute(
        select(Quote)
        .where(Quote.id == quote_id, Quote.tenant_id == tenant_id)
        .options(selectinload(Quote.items))
    )
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    # Get property info for the PDF
    property_info = None
    if quote.property_id:
        prop_result = await db.execute(
            select(Property).where(Property.id == quote.property_id)
        )
        prop = prop_result.scalar_one_or_none()
        if prop:
            property_info = {
                "address": prop.address,
                "city": prop.city,
                "state": prop.state,
                "zip": prop.zip,
                "property_type": prop.property_type,
                "sqft": prop.sqft,
                "beds": prop.beds,
                "baths": prop.baths,
            }

    quote_dict = {
        "id": quote.id,
        "status": quote.status,
        "created_at": quote.created_at,
        "notes": quote.notes,
        "total_material": quote.total_material,
        "total_labor": quote.total_labor,
        "platform_fee": quote.platform_fee,
        "platform_fee_pct": quote.platform_fee_pct,
        "grand_total": quote.grand_total,
    }
    items_dicts = [
        {
            "room": item.room,
            "trade_category": item.trade_category,
            "description": item.description,
            "quantity": item.quantity,
            "unit_cost": item.unit_cost,
            "labor_cost": item.labor_cost,
            "markup_pct": item.markup_pct,
        }
        for item in quote.items
    ]

    pdf_bytes = generate_sow_pdf(quote_dict, items_dicts, property_info)
    s3_key = await upload_sow_to_s3(pdf_bytes, quote.id)

    quote.pdf_s3_key = s3_key
    await db.flush()

    return GenerateSOWResponse(
        quote_id=quote.id,
        pdf_s3_key=s3_key,
        message="SOW PDF generated and uploaded successfully",
    )


# ---------------------------------------------------------------------------
# GET /quotes/{quote_id}/sow
# ---------------------------------------------------------------------------


@router.get("/quotes/{quote_id}/sow")
async def download_sow(
    quote_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Download the generated SOW PDF for a quote."""
    tenant_id = await ensure_tenant_exists(db, user)

    result = await db.execute(
        select(Quote).where(Quote.id == quote_id, Quote.tenant_id == tenant_id)
    )
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    if not quote.pdf_s3_key:
        raise HTTPException(
            status_code=404, detail="No SOW has been generated for this quote"
        )

    pdf_bytes = await download_sow_from_s3(quote.pdf_s3_key)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="sow-{quote_id}.pdf"'
        },
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _recalculate_totals(db: AsyncSession, quote: Quote) -> None:
    """Recalculate and persist quote totals from current items."""
    items_result = await db.execute(
        select(QuoteItem).where(QuoteItem.quote_id == quote.id)
    )
    items = items_result.scalars().all()

    item_dicts = [
        {
            "quantity": i.quantity,
            "unit_cost": i.unit_cost,
            "labor_cost": i.labor_cost,
            "markup_pct": i.markup_pct,
        }
        for i in items
    ]

    totals = calculate_quote_totals(item_dicts, quote.platform_fee_pct)
    quote.total_material = totals["total_material"]
    quote.total_labor = totals["total_labor"]
    quote.platform_fee = totals["platform_fee"]
    quote.grand_total = totals["grand_total"]
