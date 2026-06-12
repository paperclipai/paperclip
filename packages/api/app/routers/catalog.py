"""Catalog browser endpoints — search, detail, categories."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser, ensure_tenant_exists, get_current_user
from app.database import get_db
from app.redis import get_redis
from app.schemas.catalog import (
    CatalogSearchResponse,
    CategoryTreeResponse,
    ProductDetailResponse,
    ProductResponse,
)
from app.services.catalog_service import CatalogService
from app.services.sage_playwright import SagePlaywrightBridge

router = APIRouter(prefix="/catalog", tags=["catalog"])

# ---------------------------------------------------------------------------
# Dependency: CatalogService
# ---------------------------------------------------------------------------

_bridge: SagePlaywrightBridge | None = None


def _get_bridge() -> SagePlaywrightBridge:
    global _bridge
    if _bridge is None:
        _bridge = SagePlaywrightBridge()
    return _bridge


async def _get_catalog_service() -> CatalogService:
    redis_client = await get_redis()
    return CatalogService(bridge=_get_bridge(), redis_client=redis_client)


def _ensure_tenant(user: CurrentUser) -> str:
    return user.effective_tenant_id


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/search", response_model=CatalogSearchResponse)
async def search_products(
    q: str | None = Query(None, description="Search query"),
    category: str | None = Query(None, description="Category ID filter"),
    brand: str | None = Query(None, description="Brand name filter"),
    price_min: int | None = Query(None, ge=0, description="Min price in cents"),
    price_max: int | None = Query(None, ge=0, description="Max price in cents"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    svc: CatalogService = Depends(_get_catalog_service),
) -> CatalogSearchResponse:
    tenant_id = await ensure_tenant_exists(db, user)
    result = await svc.search_products(
        db=db,
        tenant_id=tenant_id,
        query=q,
        category=category,
        brand=brand,
        price_min=price_min,
        price_max=price_max,
        limit=limit,
        offset=offset,
    )
    return CatalogSearchResponse(**result)


@router.get("/products/{product_id}", response_model=ProductDetailResponse)
async def get_product_detail(
    product_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    svc: CatalogService = Depends(_get_catalog_service),
) -> ProductDetailResponse:
    tenant_id = await ensure_tenant_exists(db, user)
    result = await svc.get_product_detail(db=db, tenant_id=tenant_id, product_id=product_id)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product {product_id} not found",
        )
    return ProductDetailResponse(**result)


@router.get("/categories", response_model=list[CategoryTreeResponse])
async def list_categories(
    db: AsyncSession = Depends(get_db),
    svc: CatalogService = Depends(_get_catalog_service),
    _user: CurrentUser = Depends(get_current_user),
) -> list[CategoryTreeResponse]:
    cats = await svc.get_categories(db=db)
    return [CategoryTreeResponse(**c) for c in cats]


@router.get(
    "/categories/{category_id}/products",
    response_model=CatalogSearchResponse,
)
async def list_category_products(
    category_id: str,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    svc: CatalogService = Depends(_get_catalog_service),
) -> CatalogSearchResponse:
    tenant_id = await ensure_tenant_exists(db, user)
    result = await svc.get_category_products(
        db=db,
        tenant_id=tenant_id,
        category_id=category_id,
        limit=limit,
        offset=offset,
    )
    return CatalogSearchResponse(**result)
