"""Risk flag system endpoints — evaluation, FEMA flood zone, lendability."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser, ensure_tenant_exists, get_current_user
from app.database import get_db
from app.models import ARVCalculation, Property, RiskFlag
from app.schemas.risk import (
    LendabilityBreakdown,
    LendabilityScoreResponse,
    RiskEvaluationResponse,
    RiskFlagListResponse,
    RiskFlagResponse,
)
from app.services import fema
from app.services.lendability import calculate_lendability
from app.services.risk_flags import evaluate_year_flags

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/risk", tags=["risk"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ensure_tenant(user: CurrentUser) -> str:
    return user.effective_tenant_id


async def _get_property(db: AsyncSession, property_id: str, tenant_id: str) -> Property:
    result = await db.execute(
        select(Property).where(Property.id == property_id, Property.tenant_id == tenant_id)
    )
    prop = result.scalar_one_or_none()
    if not prop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Property not found")
    return prop


# ---------------------------------------------------------------------------
# List risk flags
# ---------------------------------------------------------------------------


@router.get("/{property_id}/flags", response_model=RiskFlagListResponse)
async def list_risk_flags(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RiskFlagListResponse:
    """List all stored risk flags for a property."""
    tenant_id = await ensure_tenant_exists(db, user)
    await _get_property(db, property_id, tenant_id)

    result = await db.execute(
        select(RiskFlag).where(RiskFlag.property_id == property_id)
    )
    flags = result.scalars().all()

    return RiskFlagListResponse(
        property_id=property_id,
        flags=[RiskFlagResponse.model_validate(f) for f in flags],
        total=len(flags),
    )


# ---------------------------------------------------------------------------
# FEMA flood zone query
# ---------------------------------------------------------------------------


@router.post("/{property_id}/fema", response_model=RiskFlagListResponse)
async def query_fema_flood_zone(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RiskFlagListResponse:
    """Query FEMA flood zone for a property and store result as a risk flag."""
    tenant_id = await ensure_tenant_exists(db, user)
    prop = await _get_property(db, property_id, tenant_id)

    if prop.lat is None or prop.lng is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Property missing lat/lng coordinates for FEMA lookup",
        )

    flood_data = await fema.query_flood_zone(prop.lat, prop.lng)
    if flood_data is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="FEMA flood zone service temporarily unavailable",
        )

    # Remove existing FEMA flags for this property (replace with fresh data)
    await db.execute(
        delete(RiskFlag).where(
            RiskFlag.property_id == property_id, RiskFlag.source == "fema"
        )
    )

    if flood_data["is_high_risk"]:
        severity = "high"
        detail = (
            f"FEMA flood zone {flood_data['zone']} — high-risk area. "
            "Flood insurance required for federally backed mortgages. "
            "Expect significant insurance premium impact."
        )
    else:
        severity = "low"
        detail = (
            f"FEMA flood zone {flood_data['zone']} — minimal to moderate flood risk."
        )

    flag = RiskFlag(
        property_id=property_id,
        flag_type="flood_zone",
        severity=severity,
        detail=detail,
        source="fema",
    )
    db.add(flag)
    await db.flush()
    await db.refresh(flag)

    return RiskFlagListResponse(
        property_id=property_id,
        flags=[RiskFlagResponse.model_validate(flag)],
        total=1,
    )


# ---------------------------------------------------------------------------
# Full risk evaluation
# ---------------------------------------------------------------------------


@router.post("/{property_id}/evaluate", response_model=RiskEvaluationResponse)
async def evaluate_risk(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RiskEvaluationResponse:
    """Run full risk evaluation: year flags + FEMA + lendability score.

    Clears existing risk flags for this property and re-evaluates from scratch.
    """
    tenant_id = await ensure_tenant_exists(db, user)
    prop = await _get_property(db, property_id, tenant_id)

    # Clear existing flags
    await db.execute(
        delete(RiskFlag).where(RiskFlag.property_id == property_id)
    )

    # --- Year-based flags ---
    year_flag_dicts = evaluate_year_flags(prop.year_built)
    saved_flags: list[RiskFlag] = []

    for fd in year_flag_dicts:
        flag = RiskFlag(property_id=property_id, **fd)
        db.add(flag)
        saved_flags.append(flag)

    # --- FEMA flood zone ---
    if prop.lat is not None and prop.lng is not None:
        flood_data = await fema.query_flood_zone(prop.lat, prop.lng)
        if flood_data is not None:
            if flood_data["is_high_risk"]:
                severity = "high"
                detail = (
                    f"FEMA flood zone {flood_data['zone']} — high-risk area. "
                    "Flood insurance required for federally backed mortgages."
                )
            else:
                severity = "low"
                detail = (
                    f"FEMA flood zone {flood_data['zone']} — minimal to moderate flood risk."
                )

            fema_flag = RiskFlag(
                property_id=property_id,
                flag_type="flood_zone",
                severity=severity,
                detail=detail,
                source="fema",
            )
            db.add(fema_flag)
            saved_flags.append(fema_flag)

    await db.flush()
    for f in saved_flags:
        await db.refresh(f)

    # --- Lendability score ---
    flag_dicts = [
        {
            "flag_type": f.flag_type,
            "severity": f.severity,
            "source": f.source,
        }
        for f in saved_flags
    ]

    # Get ARV calculations
    arv_result = await db.execute(
        select(ARVCalculation)
        .where(ARVCalculation.property_id == property_id)
        .order_by(ARVCalculation.created_at.desc())
    )
    arv_rows = arv_result.scalars().all()
    arv_dicts = [
        {"arv_mid": float(a.arv_mid), "confidence": a.confidence}
        for a in arv_rows
    ]

    prop_data = {
        "year_built": prop.year_built,
        "listing_price": prop.listing_price,
    }
    lendability = calculate_lendability(prop_data, flag_dicts, arv_dicts)

    # Persist lendability on property
    prop.lendability_score = lendability["score"]
    prop.lendability_category = lendability["category"]
    await db.flush()

    return RiskEvaluationResponse(
        property_id=property_id,
        flags=[RiskFlagResponse.model_validate(f) for f in saved_flags],
        lendability=LendabilityScoreResponse(
            score=lendability["score"],
            category=lendability["category"],
            breakdown=LendabilityBreakdown(**lendability["breakdown"]),
        ),
    )


# ---------------------------------------------------------------------------
# Lendability score (read-only)
# ---------------------------------------------------------------------------


@router.get("/{property_id}/lendability", response_model=LendabilityScoreResponse)
async def get_lendability_score(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LendabilityScoreResponse:
    """Get the current lendability score for a property.

    Returns the last computed score. Run POST /evaluate to refresh.
    """
    tenant_id = await ensure_tenant_exists(db, user)
    prop = await _get_property(db, property_id, tenant_id)

    if prop.lendability_score is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No lendability score computed yet. Run POST /risk/{id}/evaluate first.",
        )

    # Recompute breakdown from current flags
    flags_result = await db.execute(
        select(RiskFlag).where(RiskFlag.property_id == property_id)
    )
    flags = flags_result.scalars().all()
    flag_dicts = [
        {"flag_type": f.flag_type, "severity": f.severity, "source": f.source}
        for f in flags
    ]

    arv_result = await db.execute(
        select(ARVCalculation)
        .where(ARVCalculation.property_id == property_id)
        .order_by(ARVCalculation.created_at.desc())
    )
    arv_rows = arv_result.scalars().all()
    arv_dicts = [
        {"arv_mid": float(a.arv_mid), "confidence": a.confidence}
        for a in arv_rows
    ]

    prop_data = {
        "year_built": prop.year_built,
        "listing_price": prop.listing_price,
    }
    lendability = calculate_lendability(prop_data, flag_dicts, arv_dicts)

    return LendabilityScoreResponse(
        score=lendability["score"],
        category=lendability["category"],
        breakdown=LendabilityBreakdown(**lendability["breakdown"]),
    )
