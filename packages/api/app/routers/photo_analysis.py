"""Photo analysis endpoints for listing photo pre-screening via Claude Vision."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import CurrentUser, ensure_tenant_exists, get_current_user
from app.database import get_db
from app.models import PhotoLabel, Property, PropertyPhotoAnalysis
from app.schemas.photo_analysis import (
    AnalyzePhotosRequest,
    PhotoLabelOverride,
    PhotoLabelResponse,
    PropertyPhotoAnalysisResponse,
    ReviewQueueItem,
    ReviewQueueResponse,
)
from app.services.claude_vision import ClaudeVisionService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["photo-analysis"])


def _ensure_tenant(user: CurrentUser) -> str:
    return user.effective_tenant_id


# ---------------------------------------------------------------------------
# POST /properties/{id}/analyze-photos
# ---------------------------------------------------------------------------


@router.post(
    "/properties/{property_id}/analyze-photos",
    response_model=PropertyPhotoAnalysisResponse,
)
async def analyze_photos(
    property_id: str,
    body: AnalyzePhotosRequest,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyPhotoAnalysisResponse:
    """Trigger Claude Vision analysis on listing photos for a property."""
    tenant_id = await ensure_tenant_exists(db, user)

    # Verify property exists and belongs to tenant
    prop = await db.execute(
        select(Property).where(
            Property.id == property_id, Property.tenant_id == tenant_id
        )
    )
    if not prop.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Property not found")

    vision = ClaudeVisionService()

    # Create analysis record
    analysis = PropertyPhotoAnalysis(
        property_id=property_id,
        status="processing",
        photo_count=len(body.photo_urls),
        model_id=vision._model,
    )
    db.add(analysis)
    await db.flush()

    try:
        summary = await vision.analyze_property_photos(body.photo_urls)

        # Persist labels
        for result in summary.labels:
            review_status = (
                "pending_review" if result.confidence_tier == "low" else "auto_accepted"
            )
            label = PhotoLabel(
                analysis_id=analysis.id,
                photo_url=result.photo_url,
                photo_index=result.photo_index,
                room_type=result.room_type,
                condition=result.condition,
                damage_issues=result.damage_issues,
                renovation_needed=result.renovation_needed,
                confidence=result.confidence,
                confidence_tier=result.confidence_tier,
                raw_response=result.raw_response,
                review_status=review_status,
            )
            db.add(label)

        # Update analysis with aggregated results
        analysis.status = "completed"
        analysis.renovation_signal = summary.renovation_signal
        analysis.renovation_confidence = summary.renovation_confidence
        analysis.total_cost_cents = (
            summary.total_input_tokens * 3 + summary.total_output_tokens * 15
        )  # approx cost tracking in hundredths of cents
        analysis.completed_at = datetime.now(timezone.utc)

    except Exception as exc:
        logger.exception("Photo analysis failed for property %s", property_id)
        analysis.status = "failed"
        analysis.error_message = str(exc)[:2000]

    await db.flush()

    # Reload with labels for response
    result = await db.execute(
        select(PropertyPhotoAnalysis)
        .where(PropertyPhotoAnalysis.id == analysis.id)
        .options(selectinload(PropertyPhotoAnalysis.labels))
    )
    return result.scalar_one()


# ---------------------------------------------------------------------------
# GET /properties/{id}/photo-analysis
# ---------------------------------------------------------------------------


@router.get(
    "/properties/{property_id}/photo-analysis",
    response_model=list[PropertyPhotoAnalysisResponse],
)
async def get_photo_analysis(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PropertyPhotoAnalysis]:
    """Get all photo analysis results for a property."""
    tenant_id = await ensure_tenant_exists(db, user)

    # Verify property belongs to tenant
    prop = await db.execute(
        select(Property).where(
            Property.id == property_id, Property.tenant_id == tenant_id
        )
    )
    if not prop.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Property not found")

    result = await db.execute(
        select(PropertyPhotoAnalysis)
        .where(PropertyPhotoAnalysis.property_id == property_id)
        .options(selectinload(PropertyPhotoAnalysis.labels))
        .order_by(PropertyPhotoAnalysis.created_at.desc())
    )
    return list(result.scalars().all())


# ---------------------------------------------------------------------------
# GET /review-queue
# ---------------------------------------------------------------------------


@router.get(
    "/review-queue",
    response_model=ReviewQueueResponse,
    tags=["review-queue"],
)
async def get_review_queue(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
) -> ReviewQueueResponse:
    """List low-confidence photo labels pending human review."""
    tenant_id = await ensure_tenant_exists(db, user)

    # Count total
    count_q = (
        select(func.count(PhotoLabel.id))
        .join(
            PropertyPhotoAnalysis,
            PhotoLabel.analysis_id == PropertyPhotoAnalysis.id,
        )
        .join(Property, PropertyPhotoAnalysis.property_id == Property.id)
        .where(
            Property.tenant_id == tenant_id,
            PhotoLabel.review_status == "pending_review",
        )
    )
    total = (await db.execute(count_q)).scalar() or 0

    # Fetch page
    offset = (page - 1) * page_size
    q = (
        select(PhotoLabel, Property.id, Property.address)
        .join(
            PropertyPhotoAnalysis,
            PhotoLabel.analysis_id == PropertyPhotoAnalysis.id,
        )
        .join(Property, PropertyPhotoAnalysis.property_id == Property.id)
        .where(
            Property.tenant_id == tenant_id,
            PhotoLabel.review_status == "pending_review",
        )
        .order_by(PhotoLabel.confidence.asc())
        .offset(offset)
        .limit(page_size)
    )
    rows = (await db.execute(q)).all()

    items = [
        ReviewQueueItem(
            label=PhotoLabelResponse.model_validate(row[0]),
            property_id=row[1],
            property_address=row[2],
            analysis_id=row[0].analysis_id,
        )
        for row in rows
    ]

    return ReviewQueueResponse(
        items=items, total=total, page=page, page_size=page_size
    )


# ---------------------------------------------------------------------------
# PATCH /photo-labels/{id}
# ---------------------------------------------------------------------------


@router.patch(
    "/photo-labels/{label_id}",
    response_model=PhotoLabelResponse,
    tags=["review-queue"],
)
async def override_photo_label(
    label_id: str,
    body: PhotoLabelOverride,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PhotoLabel:
    """Human override for a photo label (approve/reject/correct)."""
    tenant_id = await ensure_tenant_exists(db, user)

    # Fetch label and verify tenant ownership
    q = (
        select(PhotoLabel)
        .join(
            PropertyPhotoAnalysis,
            PhotoLabel.analysis_id == PropertyPhotoAnalysis.id,
        )
        .join(Property, PropertyPhotoAnalysis.property_id == Property.id)
        .where(PhotoLabel.id == label_id, Property.tenant_id == tenant_id)
    )
    result = await db.execute(q)
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Photo label not found")

    override_data = body.model_dump(exclude_none=True)
    if override_data:
        label.reviewer_override = override_data
        # Apply overrides to the label fields
        if body.room_type is not None:
            label.room_type = body.room_type
        if body.condition is not None:
            label.condition = body.condition
        if body.damage_issues is not None:
            label.damage_issues = body.damage_issues
        if body.renovation_needed is not None:
            label.renovation_needed = body.renovation_needed

    label.review_status = "reviewed"
    return label
