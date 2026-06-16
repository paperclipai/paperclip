"""Property endpoints — ingestion, listing feed, and integrations."""

from __future__ import annotations

import math
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser, ensure_tenant_exists, get_current_user
from app.database import get_db
from app.models import Property
from app.schemas.property import (
    GeocodeResult,
    GooglePlacesAutocomplete,
    PlacesAutocompleteResponse,
    PlacePrediction,
    PropertyCreate,
    PropertyListResponse,
    PropertyResponse,
    PropertyUpdate,
    PropStreamSearch,
    ZillowUrlImport,
)
from app.services import apillow, google_places, propstream, zillow_scraper

router = APIRouter(prefix="/properties", tags=["properties"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _property_to_response(prop: Property) -> PropertyResponse:
    return PropertyResponse.model_validate(prop)


def _ensure_tenant(user: CurrentUser) -> str:
    return user.effective_tenant_id


# ---------------------------------------------------------------------------
# Manual CRUD
# ---------------------------------------------------------------------------


@router.post("", response_model=PropertyResponse, status_code=status.HTTP_201_CREATED)
async def create_property(
    body: PropertyCreate,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyResponse:
    """Create a property via manual entry."""
    tenant_id = await ensure_tenant_exists(db, user)
    prop = Property(
        tenant_id=tenant_id,
        data_source="manual",
        **body.model_dump(exclude_none=True),
    )
    db.add(prop)
    await db.flush()
    await db.refresh(prop)
    return _property_to_response(prop)


@router.get("/{property_id}", response_model=PropertyResponse)
async def get_property(
    property_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyResponse:
    """Get a single property by ID."""
    tenant_id = _ensure_tenant(user)
    result = await db.execute(
        select(Property).where(Property.id == property_id, Property.tenant_id == tenant_id)
    )
    prop = result.scalar_one_or_none()
    if not prop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Property not found")
    return _property_to_response(prop)


@router.patch("/{property_id}", response_model=PropertyResponse)
async def update_property(
    property_id: str,
    body: PropertyUpdate,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyResponse:
    """Partially update a property."""
    tenant_id = _ensure_tenant(user)
    result = await db.execute(
        select(Property).where(Property.id == property_id, Property.tenant_id == tenant_id)
    )
    prop = result.scalar_one_or_none()
    if not prop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Property not found")

    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(prop, key, value)

    await db.flush()
    await db.refresh(prop)
    return _property_to_response(prop)


# ---------------------------------------------------------------------------
# Listing Feed — paginated, filterable, sortable
# ---------------------------------------------------------------------------


@router.get("", response_model=PropertyListResponse)
async def list_properties(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    # Filters
    property_status: str | None = Query(None, alias="status"),
    property_type: str | None = Query(None),
    min_price: float | None = Query(None, ge=0),
    max_price: float | None = Query(None, ge=0),
    city: str | None = Query(None),
    state: str | None = Query(None),
    zip_code: str | None = Query(None, alias="zip"),
    min_beds: int | None = Query(None, ge=0),
    min_baths: float | None = Query(None, ge=0),
    # Sort
    sort_by: str = Query("created_at", pattern="^(created_at|listing_price|arv_estimate|address)$"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
) -> PropertyListResponse:
    """List properties with pagination, filtering, and sorting."""
    tenant_id = _ensure_tenant(user)

    # Base query
    query = select(Property).where(Property.tenant_id == tenant_id)

    # Apply filters
    if property_status:
        query = query.where(Property.status == property_status)
    if property_type:
        query = query.where(Property.property_type == property_type)
    if min_price is not None:
        query = query.where(Property.listing_price >= min_price)
    if max_price is not None:
        query = query.where(Property.listing_price <= max_price)
    if city:
        query = query.where(func.lower(Property.city) == city.lower())
    if state:
        query = query.where(func.lower(Property.state) == state.lower())
    if zip_code:
        query = query.where(Property.zip == zip_code)
    if min_beds is not None:
        query = query.where(Property.beds >= min_beds)
    if min_baths is not None:
        query = query.where(Property.baths >= min_baths)

    # Count total
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Sort
    sort_column = getattr(Property, sort_by)
    if sort_order == "desc":
        query = query.order_by(sort_column.desc().nulls_last())
    else:
        query = query.order_by(sort_column.asc().nulls_last())

    # Paginate
    offset = (page - 1) * page_size
    query = query.offset(offset).limit(page_size)

    result = await db.execute(query)
    properties = result.scalars().all()

    return PropertyListResponse(
        items=[_property_to_response(p) for p in properties],
        total=total,
        page=page,
        page_size=page_size,
        pages=math.ceil(total / page_size) if total > 0 else 0,
    )


# ---------------------------------------------------------------------------
# PropStream integration
# ---------------------------------------------------------------------------


@router.post("/search/propstream", response_model=PropertyResponse, status_code=status.HTTP_201_CREATED)
async def import_from_propstream(
    body: PropStreamSearch,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyResponse:
    """Search PropStream and import a property."""
    tenant_id = await ensure_tenant_exists(db, user)

    if not body.address and not body.mls_id and not (body.lat and body.lng):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide at least one of: address, mls_id, or lat/lng coordinates",
        )

    # Search PropStream
    if body.address:
        raw = await propstream.search_by_address(body.address)
    elif body.mls_id:
        raw = await propstream.search_by_mls_id(body.mls_id)
    else:
        raw = await propstream.search_by_coordinates(
            body.lat, body.lng, body.radius_miles or 1.0  # type: ignore[arg-type]
        )

    normalized = propstream.normalize_propstream_data(raw)

    # Try APIllow enrichment
    if normalized.get("address"):
        apillow_raw = await apillow.fetch_property_data(normalized["address"])
        if apillow_raw:
            apillow_normalized = apillow.normalize_apillow_data(apillow_raw)
            normalized = apillow.merge_enrichment(normalized, apillow_normalized)

    # Remove empty strings before creating
    clean = {k: v for k, v in normalized.items() if v is not None and v != ""}

    prop = Property(tenant_id=tenant_id, **clean)
    db.add(prop)
    await db.flush()
    await db.refresh(prop)
    return _property_to_response(prop)


# ---------------------------------------------------------------------------
# Zillow URL paste
# ---------------------------------------------------------------------------


@router.post("/import/zillow", response_model=PropertyResponse, status_code=status.HTTP_201_CREATED)
async def import_from_zillow_url(
    body: ZillowUrlImport,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyResponse:
    """Create a property record from a Zillow listing URL."""
    tenant_id = await ensure_tenant_exists(db, user)

    try:
        data = await zillow_scraper.scrape_zillow_listing(body.url)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    if not data.get("address") or not data.get("city") or not data.get("state") or not data.get("zip"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not extract required address fields from Zillow listing",
        )

    # Try APIllow enrichment for the address
    apillow_raw = await apillow.fetch_property_data(data["address"])
    if apillow_raw:
        apillow_normalized = apillow.normalize_apillow_data(apillow_raw)
        data = apillow.merge_enrichment(data, apillow_normalized)

    clean = {k: v for k, v in data.items() if v is not None and v != ""}
    prop = Property(tenant_id=tenant_id, **clean)
    db.add(prop)
    await db.flush()
    await db.refresh(prop)
    return _property_to_response(prop)


# ---------------------------------------------------------------------------
# Google Places
# ---------------------------------------------------------------------------


@router.post("/places/autocomplete", response_model=PlacesAutocompleteResponse)
async def places_autocomplete(
    body: GooglePlacesAutocomplete,
    user: CurrentUser = Depends(get_current_user),
) -> PlacesAutocompleteResponse:
    """Return address autocomplete suggestions from Google Places."""
    _ensure_tenant(user)
    predictions = await google_places.autocomplete(body.input, body.session_token)
    return PlacesAutocompleteResponse(
        predictions=[PlacePrediction(**p) for p in predictions]
    )


@router.get("/places/geocode", response_model=GeocodeResult)
async def geocode_address(
    address: str = Query(..., min_length=1),
    user: CurrentUser = Depends(get_current_user),
) -> GeocodeResult:
    """Geocode an address to lat/lng."""
    _ensure_tenant(user)
    result = await google_places.geocode(address)
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Could not geocode address",
        )
    return GeocodeResult(**result)
