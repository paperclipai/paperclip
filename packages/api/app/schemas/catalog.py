"""Pydantic schemas for catalog endpoints."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums / constants
# ---------------------------------------------------------------------------

AVAILABILITY_VALUES = {"in_stock", "out_of_stock", "limited", "discontinued"}
PRICE_SOURCE_VALUES = {"sage_scrape", "sage_api", "manual"}


# ---------------------------------------------------------------------------
# Product Category
# ---------------------------------------------------------------------------


class ProductCategoryBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    parent_id: str | None = None
    sage_category_id: str | None = None


class ProductCategoryCreate(ProductCategoryBase):
    pass


class ProductCategoryResponse(ProductCategoryBase):
    id: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CategoryTreeResponse(ProductCategoryResponse):
    children: list[CategoryTreeResponse] = []


# ---------------------------------------------------------------------------
# Product Price
# ---------------------------------------------------------------------------


class ProductPriceCreate(BaseModel):
    price_cents: int = Field(..., ge=0)
    currency: str = Field("USD", max_length=3)
    effective_date: date
    source: str = Field(..., max_length=50)


class ProductPriceResponse(ProductPriceCreate):
    id: str
    product_id: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Product
# ---------------------------------------------------------------------------


class ProductBase(BaseModel):
    sku: str = Field(..., min_length=1, max_length=100)
    name: str = Field(..., min_length=1, max_length=500)
    description: str | None = None
    brand: str | None = None
    unit_of_measure: str | None = None
    dimensions: dict[str, Any] | None = None
    image_url: str | None = None
    availability_status: str = Field("in_stock")
    category_id: str | None = None
    sage_product_id: str | None = None


class ProductCreate(ProductBase):
    tenant_id: str


class ProductResponse(ProductBase):
    id: str
    tenant_id: str
    last_synced_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ProductDetailResponse(ProductResponse):
    prices: list[ProductPriceResponse] = []
    category: ProductCategoryResponse | None = None


# ---------------------------------------------------------------------------
# Search / Pagination
# ---------------------------------------------------------------------------


class CatalogSearchRequest(BaseModel):
    query: str | None = None
    category: str | None = None
    brand: str | None = None
    price_min: int | None = Field(None, ge=0, description="Min price in cents")
    price_max: int | None = Field(None, ge=0, description="Max price in cents")
    limit: int = Field(20, ge=1, le=100)
    offset: int = Field(0, ge=0)


class CatalogSearchResponse(BaseModel):
    items: list[ProductResponse]
    total: int
    limit: int
    offset: int
