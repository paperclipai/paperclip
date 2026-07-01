"""Catalog browser service — sits between API layer and Sage Playwright bridge.

Provides Redis caching and DB sync for catalog data.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, date, datetime
from typing import Any

import redis.asyncio as aioredis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Product, ProductCategory, ProductPrice
from app.services.sage_playwright import SagePlaywrightBridge

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cache TTLs (seconds)
# ---------------------------------------------------------------------------

TTL_SEARCH = 15 * 60       # 15 minutes
TTL_PRODUCT = 60 * 60      # 1 hour
TTL_CATEGORIES = 24 * 3600  # 24 hours


def _cache_key_search(params: dict) -> str:
    h = hashlib.md5(json.dumps(params, sort_keys=True).encode()).hexdigest()
    return f"sage:search:{h}"


def _cache_key_product(product_id: str) -> str:
    return f"sage:product:{product_id}"


CACHE_KEY_CATEGORIES = "sage:categories"


class CatalogService:
    """Catalog browser with Redis caching and DB persistence."""

    def __init__(
        self,
        bridge: SagePlaywrightBridge,
        redis_client: aioredis.Redis | None = None,
    ) -> None:
        self._bridge = bridge
        self._redis = redis_client

    # -- cache helpers -------------------------------------------------------

    async def _cache_get(self, key: str) -> Any | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(key)
            return json.loads(raw) if raw else None
        except Exception:
            logger.warning("Redis read failed for key=%s", key, exc_info=True)
            return None

    async def _cache_set(self, key: str, value: Any, ttl: int) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.setex(key, ttl, json.dumps(value, default=str))
        except Exception:
            logger.warning("Redis write failed for key=%s", key, exc_info=True)

    # -- DB sync helpers -----------------------------------------------------

    @staticmethod
    async def _upsert_product(
        db: AsyncSession,
        tenant_id: str,
        data: dict[str, Any],
    ) -> Product:
        """Upsert a product from Sage bridge data into the DB."""
        sage_id = data.get("product_id") or data.get("sku")
        stmt = select(Product).where(
            Product.tenant_id == tenant_id,
            Product.sage_product_id == sage_id,
        )
        result = await db.execute(stmt)
        product = result.scalar_one_or_none()

        now = datetime.now(UTC)
        if product is None:
            product = Product(
                tenant_id=tenant_id,
                sage_product_id=sage_id,
                sku=data.get("sku") or sage_id or "UNKNOWN",
                name=data.get("name") or "Unknown Product",
                description=data.get("description"),
                brand=data.get("brand"),
                dimensions=data.get("dimensions"),
                image_url=data.get("image_url"),
                availability_status=data.get("availability") or "in_stock",
                last_synced_at=now,
            )
            db.add(product)
        else:
            product.name = data.get("name") or product.name
            product.description = data.get("description") or product.description
            product.brand = data.get("brand") or product.brand
            product.dimensions = data.get("dimensions") or product.dimensions
            product.image_url = data.get("image_url") or product.image_url
            if data.get("availability"):
                product.availability_status = data["availability"]
            product.last_synced_at = now

        await db.flush()

        # Insert price if provided and changed
        if data.get("price_cents") is not None:
            last_price_stmt = (
                select(ProductPrice)
                .where(ProductPrice.product_id == product.id)
                .order_by(ProductPrice.effective_date.desc())
                .limit(1)
            )
            last_price_result = await db.execute(last_price_stmt)
            last_price = last_price_result.scalar_one_or_none()

            if last_price is None or last_price.price_cents != data["price_cents"]:
                new_price = ProductPrice(
                    product_id=product.id,
                    price_cents=data["price_cents"],
                    currency="USD",
                    effective_date=date.today(),
                    source="sage_scrape",
                )
                db.add(new_price)

        return product

    # -- public API ----------------------------------------------------------

    async def search_products(
        self,
        db: AsyncSession,
        tenant_id: str,
        query: str | None = None,
        category: str | None = None,
        brand: str | None = None,
        price_min: int | None = None,
        price_max: int | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        """Search products — cache-first, then Sage bridge, with DB sync."""
        params = {
            "query": query, "category": category, "brand": brand,
            "price_min": price_min, "price_max": price_max,
            "limit": limit, "offset": offset,
        }
        cache_key = _cache_key_search(params)
        cached = await self._cache_get(cache_key)
        if cached is not None:
            return cached

        # DB-first: try to serve from local products table
        stmt = select(Product).where(Product.tenant_id == tenant_id)
        if query:
            stmt = stmt.where(Product.name.ilike(f"%{query}%"))
        if category:
            stmt = stmt.where(Product.category_id == category)
        if brand:
            stmt = stmt.where(Product.brand.ilike(f"%{brand}%"))

        # Price filter requires a subquery on latest price
        if price_min is not None or price_max is not None:
            latest_price = (
                select(
                    ProductPrice.product_id,
                    func.max(ProductPrice.effective_date).label("max_date"),
                )
                .group_by(ProductPrice.product_id)
                .subquery()
            )
            price_sq = (
                select(ProductPrice.product_id, ProductPrice.price_cents)
                .join(
                    latest_price,
                    (ProductPrice.product_id == latest_price.c.product_id)
                    & (ProductPrice.effective_date == latest_price.c.max_date),
                )
                .subquery()
            )
            stmt = stmt.join(price_sq, Product.id == price_sq.c.product_id)
            if price_min is not None:
                stmt = stmt.where(price_sq.c.price_cents >= price_min)
            if price_max is not None:
                stmt = stmt.where(price_sq.c.price_cents <= price_max)

        count_result = await db.execute(
            select(func.count()).select_from(stmt.subquery())
        )
        total = count_result.scalar() or 0

        result = await db.execute(stmt.offset(offset).limit(limit))
        products = result.scalars().all()

        # If DB has results, serve them and cache
        if products:
            items = [
                {
                    "id": p.id,
                    "sku": p.sku,
                    "name": p.name,
                    "description": p.description,
                    "brand": p.brand,
                    "unit_of_measure": p.unit_of_measure,
                    "dimensions": p.dimensions,
                    "image_url": p.image_url,
                    "availability_status": p.availability_status,
                    "category_id": p.category_id,
                    "sage_product_id": p.sage_product_id,
                    "tenant_id": p.tenant_id,
                    "last_synced_at": str(p.last_synced_at) if p.last_synced_at else None,
                    "created_at": str(p.created_at),
                    "updated_at": str(p.updated_at),
                }
                for p in products
            ]
            response = {"items": items, "total": total, "limit": limit, "offset": offset}
            await self._cache_set(cache_key, response, TTL_SEARCH)
            return response

        # Cache miss + no DB results — fetch from Sage bridge
        try:
            bridge_results = await self._bridge.search_products(
                query=query or "", category=category, page=(offset // limit) + 1
            )
        except Exception:
            logger.warning("Sage bridge search failed", exc_info=True)
            bridge_results = []

        # Sync to DB
        items = []
        for data in bridge_results:
            product = await self._upsert_product(db, tenant_id, data)
            items.append({
                "id": product.id,
                "sku": product.sku,
                "name": product.name,
                "description": product.description,
                "brand": product.brand,
                "unit_of_measure": product.unit_of_measure,
                "dimensions": product.dimensions,
                "image_url": product.image_url,
                "availability_status": product.availability_status,
                "category_id": product.category_id,
                "sage_product_id": product.sage_product_id,
                "tenant_id": product.tenant_id,
                "last_synced_at": str(product.last_synced_at) if product.last_synced_at else None,
                "created_at": str(product.created_at),
                "updated_at": str(product.updated_at),
            })

        response = {"items": items, "total": len(items), "limit": limit, "offset": offset}
        await self._cache_set(cache_key, response, TTL_SEARCH)
        return response

    async def get_product_detail(
        self,
        db: AsyncSession,
        tenant_id: str,
        product_id: str,
    ) -> dict[str, Any] | None:
        """Get a single product with prices — cache-first."""
        cache_key = _cache_key_product(product_id)
        cached = await self._cache_get(cache_key)
        if cached is not None:
            return cached

        # Try DB first
        stmt = (
            select(Product)
            .where(Product.id == product_id, Product.tenant_id == tenant_id)
        )
        result = await db.execute(stmt)
        product = result.scalar_one_or_none()

        if product is None:
            # Try fetching from Sage bridge by sage_product_id
            try:
                data = await self._bridge.get_product_detail(product_id)
                product = await self._upsert_product(db, tenant_id, data)
            except Exception:
                logger.warning("Sage bridge detail failed for %s", product_id, exc_info=True)
                return None

        # Fetch prices
        prices_stmt = (
            select(ProductPrice)
            .where(ProductPrice.product_id == product.id)
            .order_by(ProductPrice.effective_date.desc())
        )
        prices_result = await db.execute(prices_stmt)
        prices = prices_result.scalars().all()

        # Fetch category
        category_data = None
        if product.category_id:
            cat_stmt = select(ProductCategory).where(
                ProductCategory.id == product.category_id
            )
            cat_result = await db.execute(cat_stmt)
            cat = cat_result.scalar_one_or_none()
            if cat:
                category_data = {
                    "id": cat.id,
                    "name": cat.name,
                    "parent_id": cat.parent_id,
                    "sage_category_id": cat.sage_category_id,
                    "created_at": str(cat.created_at),
                    "updated_at": str(cat.updated_at),
                }

        response = {
            "id": product.id,
            "sku": product.sku,
            "name": product.name,
            "description": product.description,
            "brand": product.brand,
            "unit_of_measure": product.unit_of_measure,
            "dimensions": product.dimensions,
            "image_url": product.image_url,
            "availability_status": product.availability_status,
            "category_id": product.category_id,
            "sage_product_id": product.sage_product_id,
            "tenant_id": product.tenant_id,
            "last_synced_at": str(product.last_synced_at) if product.last_synced_at else None,
            "created_at": str(product.created_at),
            "updated_at": str(product.updated_at),
            "prices": [
                {
                    "id": p.id,
                    "product_id": p.product_id,
                    "price_cents": p.price_cents,
                    "currency": p.currency,
                    "effective_date": str(p.effective_date),
                    "source": p.source,
                    "created_at": str(p.created_at),
                }
                for p in prices
            ],
            "category": category_data,
        }
        await self._cache_set(cache_key, response, TTL_PRODUCT)
        return response

    async def get_categories(
        self,
        db: AsyncSession,
    ) -> list[dict[str, Any]]:
        """Get category tree — cache-first."""
        cached = await self._cache_get(CACHE_KEY_CATEGORIES)
        if cached is not None:
            return cached

        stmt = select(ProductCategory).order_by(ProductCategory.name)
        result = await db.execute(stmt)
        categories = result.scalars().all()

        # Build flat list (tree building left to caller or frontend)
        cat_list = [
            {
                "id": c.id,
                "name": c.name,
                "parent_id": c.parent_id,
                "sage_category_id": c.sage_category_id,
                "created_at": str(c.created_at),
                "updated_at": str(c.updated_at),
            }
            for c in categories
        ]
        await self._cache_set(CACHE_KEY_CATEGORIES, cat_list, TTL_CATEGORIES)
        return cat_list

    async def get_category_products(
        self,
        db: AsyncSession,
        tenant_id: str,
        category_id: str,
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        """Browse products by category — cache-first."""
        cache_key = f"sage:cat_products:{category_id}:{limit}:{offset}"
        cached = await self._cache_get(cache_key)
        if cached is not None:
            return cached

        stmt = select(Product).where(
            Product.tenant_id == tenant_id,
            Product.category_id == category_id,
        )
        count_result = await db.execute(
            select(func.count()).select_from(stmt.subquery())
        )
        total = count_result.scalar() or 0

        result = await db.execute(stmt.offset(offset).limit(limit))
        products = result.scalars().all()

        # If no DB results, try Sage bridge
        if not products:
            try:
                bridge_results = await self._bridge.browse_category(
                    category_id, page=(offset // limit) + 1
                )
                for data in bridge_results:
                    await self._upsert_product(db, tenant_id, data)
                # Re-query after sync
                result = await db.execute(stmt.offset(offset).limit(limit))
                products = result.scalars().all()
                count_result = await db.execute(
                    select(func.count()).select_from(stmt.subquery())
                )
                total = count_result.scalar() or 0
            except Exception:
                logger.warning("Sage bridge category browse failed", exc_info=True)

        items = [
            {
                "id": p.id,
                "sku": p.sku,
                "name": p.name,
                "description": p.description,
                "brand": p.brand,
                "unit_of_measure": p.unit_of_measure,
                "dimensions": p.dimensions,
                "image_url": p.image_url,
                "availability_status": p.availability_status,
                "category_id": p.category_id,
                "sage_product_id": p.sage_product_id,
                "tenant_id": p.tenant_id,
                "last_synced_at": str(p.last_synced_at) if p.last_synced_at else None,
                "created_at": str(p.created_at),
                "updated_at": str(p.updated_at),
            }
            for p in products
        ]
        response = {"items": items, "total": total, "limit": limit, "offset": offset}
        await self._cache_set(cache_key, response, TTL_SEARCH)
        return response
