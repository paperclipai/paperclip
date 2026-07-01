"""Comps engine endpoints — sold comps, ARV calculation, rental comps."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser, ensure_tenant_exists, get_current_user
from app.database import get_db
from app.models import ARVCalculation, Comp, Property, RentalComp
from app.schemas.comps import (
    ARVRequest,
    ARVResponse,
    CompResponse,
    RentalCompResponse,
    RentalCompsResponse,
    RentalCompsSearch,
    SoldCompsResponse,
    SoldCompsSearch,
)
from app.services import rentcast, sold_comps
from app.services.arv_calculator import InsufficientCompsError, calculate_arv

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/comps", tags=["comps"])


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


def _property_as_dict(prop: Property) -> dict:
    return {
        "address": prop.address,
        "city": prop.city,
        "state": prop.state,
        "zip": prop.zip,
        "lat": prop.lat,
        "lng": prop.lng,
        "sqft": prop.sqft,
        "beds": prop.beds,
        "baths": prop.baths,
        "year_built": prop.year_built,
        "property_type": prop.property_type,
    }


# ---------------------------------------------------------------------------
# Sold Comps
# ---------------------------------------------------------------------------


@router.post("/sold", response_model=SoldCompsResponse)
async def search_sold_comps_endpoint(
    body: SoldCompsSearch,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SoldCompsResponse:
    """Search for sold comps around a subject property.

    Queries PropStream for comparable sold properties within the given radius
    and time window. Filters by property type, bed/bath, sqft, year built.
    Returns sorted by relevance (distance + recency + similarity).
    """
    tenant_id = await ensure_tenant_exists(db, user)
    prop = await _get_property(db, body.property_id, tenant_id)
    subject = _property_as_dict(prop)

    try:
        comp_dicts = await sold_comps.search_sold_comps(
            subject,
            radius_miles=body.radius_miles,
            months_back=body.months_back,
            property_type=body.property_type,
            min_beds=body.min_beds,
            max_beds=body.max_beds,
            min_baths=body.min_baths,
            max_baths=body.max_baths,
            min_sqft=body.min_sqft,
            max_sqft=body.max_sqft,
            min_year_built=body.min_year_built,
            max_year_built=body.max_year_built,
        )
    except RuntimeError as exc:
        logger.error("PropStream error during sold comp search: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Sold comps data source temporarily unavailable",
        )

    # Persist comps to database
    saved_comps: list[Comp] = []
    for cd in comp_dicts:
        comp = Comp(
            property_id=body.property_id,
            address=cd["address"],
            city=cd.get("city"),
            state=cd.get("state"),
            zip=cd.get("zip"),
            lat=cd.get("lat"),
            lng=cd.get("lng"),
            sale_price=cd.get("sale_price"),
            sale_date=cd.get("sale_date"),
            sqft=cd.get("sqft"),
            beds=cd.get("beds"),
            baths=cd.get("baths"),
            year_built=cd.get("year_built"),
            property_type=cd.get("property_type"),
            distance=cd.get("distance"),
            similarity=cd.get("similarity"),
            source=cd.get("source", "propstream"),
            mls_id=cd.get("mls_id"),
            propstream_id=cd.get("propstream_id"),
        )
        db.add(comp)
        saved_comps.append(comp)

    await db.flush()
    for c in saved_comps:
        await db.refresh(c)

    return SoldCompsResponse(
        property_id=body.property_id,
        comps=[CompResponse.model_validate(c) for c in saved_comps],
        total=len(saved_comps),
    )


@router.get("/{property_id}/sold", response_model=SoldCompsResponse)
async def list_sold_comps(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SoldCompsResponse:
    """List previously stored sold comps for a property."""
    tenant_id = await ensure_tenant_exists(db, user)
    await _get_property(db, property_id, tenant_id)

    result = await db.execute(
        select(Comp)
        .where(Comp.property_id == property_id)
        .order_by(Comp.similarity.desc().nulls_last())
    )
    comps = result.scalars().all()

    return SoldCompsResponse(
        property_id=property_id,
        comps=[CompResponse.model_validate(c) for c in comps],
        total=len(comps),
    )


# ---------------------------------------------------------------------------
# ARV Calculator
# ---------------------------------------------------------------------------


@router.post("/arv", response_model=ARVResponse)
async def calculate_arv_endpoint(
    body: ARVRequest,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ARVResponse:
    """Calculate After Repair Value from sold comps.

    Returns low / mid / high confidence band. Minimum 3 comps required.
    If no comps exist for this property, searches for them first.
    """
    tenant_id = await ensure_tenant_exists(db, user)
    prop = await _get_property(db, body.property_id, tenant_id)
    subject = _property_as_dict(prop)

    # Check if we have existing comps; if not, search for them
    existing = await db.execute(
        select(Comp).where(Comp.property_id == body.property_id)
    )
    comp_rows = existing.scalars().all()

    if len(comp_rows) < 3:
        # Search for fresh comps
        try:
            comp_dicts = await sold_comps.search_sold_comps(
                subject,
                radius_miles=body.radius_miles,
                months_back=body.months_back,
            )
        except RuntimeError as exc:
            logger.error("PropStream error during ARV comp search: %s", exc)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Sold comps data source temporarily unavailable",
            )
    else:
        # Use existing comps as dicts
        comp_dicts = []
        for c in comp_rows:
            comp_dicts.append({
                "address": c.address,
                "sale_price": float(c.sale_price) if c.sale_price else None,
                "sale_date": c.sale_date,
                "sqft": c.sqft,
                "beds": c.beds,
                "baths": c.baths,
                "year_built": c.year_built,
                "distance": c.distance,
                "similarity": c.similarity,
            })

    try:
        arv_result = calculate_arv(comp_dicts, subject)
    except InsufficientCompsError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Insufficient comps for ARV: {exc.available} found, 3 required",
        )

    # Persist ARV calculation
    arv_calc = ARVCalculation(
        property_id=body.property_id,
        arv_low=arv_result["arv_low"],
        arv_mid=arv_result["arv_mid"],
        arv_high=arv_result["arv_high"],
        confidence=arv_result["confidence"],
        comp_count=arv_result["comp_count"],
        methodology=arv_result["methodology"],
    )
    db.add(arv_calc)
    await db.flush()
    await db.refresh(arv_calc)

    # Also update the property's arv_estimate and confidence
    prop.arv_estimate = arv_result["arv_mid"]
    prop.arv_confidence = arv_result["confidence"]
    await db.flush()

    return ARVResponse.model_validate(arv_calc)


@router.get("/{property_id}/arv", response_model=list[ARVResponse])
async def list_arv_calculations(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ARVResponse]:
    """List all ARV calculations for a property (most recent first)."""
    tenant_id = await ensure_tenant_exists(db, user)
    await _get_property(db, property_id, tenant_id)

    result = await db.execute(
        select(ARVCalculation)
        .where(ARVCalculation.property_id == property_id)
        .order_by(ARVCalculation.created_at.desc())
    )
    calcs = result.scalars().all()
    return [ARVResponse.model_validate(c) for c in calcs]


# ---------------------------------------------------------------------------
# Rental Comps (Rentcast)
# ---------------------------------------------------------------------------


@router.post("/rental", response_model=RentalCompsResponse)
async def search_rental_comps_endpoint(
    body: RentalCompsSearch,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RentalCompsResponse:
    """Search rental comps via Rentcast for a property.

    Queries by address or coordinates. Returns rental estimate with
    confidence interval and comparable rental listings.
    """
    tenant_id = await ensure_tenant_exists(db, user)
    prop = await _get_property(db, body.property_id, tenant_id)

    # Determine search method
    try:
        if body.address:
            raw = await rentcast.get_rental_comps_by_address(body.address)
        elif body.lat is not None and body.lng is not None:
            raw = await rentcast.get_rental_comps_by_coordinates(body.lat, body.lng)
        elif prop.lat is not None and prop.lng is not None:
            raw = await rentcast.get_rental_comps_by_coordinates(prop.lat, prop.lng)
        else:
            address = f"{prop.address}, {prop.city}, {prop.state} {prop.zip}"
            raw = await rentcast.get_rental_comps_by_address(address)
    except RuntimeError as exc:
        logger.error("Rentcast error during rental comp search: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Rental comps data source temporarily unavailable",
        )

    normalized = rentcast.normalize_rental_comps(raw)

    # Persist rental comps
    saved_comps: list[RentalComp] = []
    for rc in normalized["comps"]:
        rental_comp = RentalComp(
            property_id=body.property_id,
            address=rc.get("address", ""),
            city=rc.get("city"),
            state=rc.get("state"),
            zip=rc.get("zip"),
            lat=rc.get("lat"),
            lng=rc.get("lng"),
            rent_price=rc.get("rent_price"),
            sqft=rc.get("sqft"),
            beds=rc.get("beds"),
            baths=rc.get("baths"),
            property_type=rc.get("property_type"),
            distance=rc.get("distance"),
            correlation=rc.get("correlation"),
            source="rentcast",
            last_seen_date=rc.get("last_seen_date"),
        )
        db.add(rental_comp)
        saved_comps.append(rental_comp)

    await db.flush()
    for c in saved_comps:
        await db.refresh(c)

    return RentalCompsResponse(
        property_id=body.property_id,
        rent_estimate_low=normalized.get("rent_estimate_low"),
        rent_estimate_mid=normalized.get("rent_estimate_mid"),
        rent_estimate_high=normalized.get("rent_estimate_high"),
        comps=[RentalCompResponse.model_validate(c) for c in saved_comps],
        total=len(saved_comps),
    )


@router.get("/{property_id}/rental", response_model=RentalCompsResponse)
async def list_rental_comps(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RentalCompsResponse:
    """List previously stored rental comps for a property."""
    tenant_id = await ensure_tenant_exists(db, user)
    await _get_property(db, property_id, tenant_id)

    result = await db.execute(
        select(RentalComp)
        .where(RentalComp.property_id == property_id)
        .order_by(RentalComp.correlation.desc().nulls_last())
    )
    comps = result.scalars().all()

    return RentalCompsResponse(
        property_id=property_id,
        comps=[RentalCompResponse.model_validate(c) for c in comps],
        total=len(comps),
    )
