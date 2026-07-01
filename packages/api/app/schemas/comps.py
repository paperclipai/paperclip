"""Pydantic schemas for comps engine endpoints."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class SoldCompsSearch(BaseModel):
    """Search for sold comps around a subject property."""

    property_id: str = Field(..., description="Subject property UUID")
    radius_miles: float = Field(0.5, ge=0.1, le=25, description="Search radius in miles")
    months_back: int = Field(6, ge=1, le=24, description="Lookback window in months")
    # Optional filters to override subject property attributes
    property_type: str | None = None
    min_beds: int | None = Field(None, ge=0)
    max_beds: int | None = Field(None, ge=0)
    min_baths: float | None = Field(None, ge=0)
    max_baths: float | None = Field(None, ge=0)
    min_sqft: int | None = Field(None, ge=1)
    max_sqft: int | None = Field(None, ge=1)
    min_year_built: int | None = Field(None, ge=1600)
    max_year_built: int | None = Field(None, le=2100)


class ARVRequest(BaseModel):
    """Request ARV calculation for a property."""

    property_id: str = Field(..., description="Subject property UUID")
    radius_miles: float = Field(0.5, ge=0.1, le=25)
    months_back: int = Field(6, ge=1, le=24)


class RentalCompsSearch(BaseModel):
    """Search for rental comps via Rentcast."""

    property_id: str = Field(..., description="Subject property UUID")
    # Optionally override with explicit address/coords
    address: str | None = None
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class CompResponse(BaseModel):
    """Single sold comp."""

    id: str
    property_id: str
    address: str
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    lat: float | None = None
    lng: float | None = None
    sale_price: float | None = None
    sale_date: date | None = None
    sqft: int | None = None
    beds: int | None = None
    baths: float | None = None
    year_built: int | None = None
    property_type: str | None = None
    distance: float | None = None
    similarity: float | None = None
    source: str | None = None
    mls_id: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class SoldCompsResponse(BaseModel):
    """Sold comps search result."""

    property_id: str
    comps: list[CompResponse]
    total: int


class ARVResponse(BaseModel):
    """ARV calculation result with confidence band."""

    id: str
    property_id: str
    arv_low: float
    arv_mid: float
    arv_high: float
    confidence: float
    comp_count: int
    methodology: dict[str, Any] | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class RentalCompResponse(BaseModel):
    """Single rental comp."""

    id: str
    property_id: str
    address: str
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    lat: float | None = None
    lng: float | None = None
    rent_price: float | None = None
    sqft: int | None = None
    beds: int | None = None
    baths: float | None = None
    property_type: str | None = None
    distance: float | None = None
    correlation: float | None = None
    source: str = "rentcast"
    last_seen_date: date | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class RentalCompsResponse(BaseModel):
    """Rental comps search result with estimate."""

    property_id: str
    rent_estimate_low: float | None = None
    rent_estimate_mid: float | None = None
    rent_estimate_high: float | None = None
    comps: list[RentalCompResponse]
    total: int
