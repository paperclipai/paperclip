"""Pydantic schemas for property endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, HttpUrl, field_validator


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class PropertyCreate(BaseModel):
    """Manual property creation."""

    address: str = Field(..., min_length=1, max_length=500)
    city: str = Field(..., min_length=1, max_length=100)
    state: str = Field(..., min_length=2, max_length=50)
    zip: str = Field(..., min_length=5, max_length=20)
    county: str | None = None
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)
    year_built: int | None = Field(None, ge=1600, le=2100)
    sqft: int | None = Field(None, ge=1)
    lot_sqft: int | None = Field(None, ge=1)
    beds: int | None = Field(None, ge=0)
    baths: float | None = Field(None, ge=0)
    property_type: str | None = None
    listing_price: float | None = Field(None, ge=0)
    arv_estimate: float | None = Field(None, ge=0)
    arv_confidence: float | None = Field(None, ge=0, le=1)
    mls_id: str | None = None
    zillow_url: str | None = None
    tax_assessment: float | None = Field(None, ge=0)


class PropertyUpdate(BaseModel):
    """Partial property update."""

    address: str | None = Field(None, min_length=1, max_length=500)
    city: str | None = Field(None, min_length=1, max_length=100)
    state: str | None = Field(None, min_length=2, max_length=50)
    zip: str | None = Field(None, min_length=5, max_length=20)
    county: str | None = None
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)
    year_built: int | None = Field(None, ge=1600, le=2100)
    sqft: int | None = Field(None, ge=1)
    lot_sqft: int | None = Field(None, ge=1)
    beds: int | None = Field(None, ge=0)
    baths: float | None = Field(None, ge=0)
    property_type: str | None = None
    listing_price: float | None = Field(None, ge=0)
    arv_estimate: float | None = Field(None, ge=0)
    arv_confidence: float | None = Field(None, ge=0, le=1)
    mls_id: str | None = None
    tax_assessment: float | None = Field(None, ge=0)
    status: str | None = None


class ZillowUrlImport(BaseModel):
    """Import property from a Zillow listing URL."""

    url: str = Field(..., min_length=1)

    @field_validator("url")
    @classmethod
    def validate_zillow_url(cls, v: str) -> str:
        if "zillow.com" not in v.lower():
            raise ValueError("URL must be a Zillow listing URL")
        return v


class PropStreamSearch(BaseModel):
    """Search PropStream by address, MLS ID, or coordinates."""

    address: str | None = None
    mls_id: str | None = None
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)
    radius_miles: float | None = Field(None, ge=0.1, le=50)

    @field_validator("address")
    @classmethod
    def require_at_least_one(cls, v: str | None, info: Any) -> str | None:
        return v


class GooglePlacesAutocomplete(BaseModel):
    """Address autocomplete request."""

    input: str = Field(..., min_length=1, max_length=500)
    session_token: str | None = None


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class PropertyResponse(BaseModel):
    """Full property response."""

    id: str
    tenant_id: str
    address: str
    city: str
    state: str
    zip: str
    county: str | None = None
    lat: float | None = None
    lng: float | None = None
    year_built: int | None = None
    sqft: int | None = None
    lot_sqft: int | None = None
    beds: int | None = None
    baths: float | None = None
    property_type: str | None = None
    zillow_url: str | None = None
    propstream_id: str | None = None
    mls_id: str | None = None
    listing_price: float | None = None
    arv_estimate: float | None = None
    arv_confidence: float | None = None
    tax_assessment: float | None = None
    data_source: str | None = None
    ownership_history: list[dict[str, Any]] | None = None
    neighborhood: str | None = None
    zillow_estimate: float | None = None
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PropertyListResponse(BaseModel):
    """Paginated property list."""

    items: list[PropertyResponse]
    total: int
    page: int
    page_size: int
    pages: int


class PlacePrediction(BaseModel):
    """Google Places autocomplete prediction."""

    place_id: str
    description: str
    structured_formatting: dict[str, Any] | None = None


class PlacesAutocompleteResponse(BaseModel):
    """Google Places autocomplete response."""

    predictions: list[PlacePrediction]


class GeocodeResult(BaseModel):
    """Geocoding result."""

    lat: float
    lng: float
    formatted_address: str
