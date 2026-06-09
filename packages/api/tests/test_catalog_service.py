"""Tests for the CatalogService — Redis, DB, and Sage bridge interactions are mocked."""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.catalog_service import (
    CACHE_KEY_CATEGORIES,
    TTL_CATEGORIES,
    TTL_PRODUCT,
    TTL_SEARCH,
    CatalogService,
    _cache_key_product,
    _cache_key_search,
)

TENANT_ID = str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_product_mock(**overrides: Any) -> MagicMock:
    """Create a mock Product ORM object."""
    defaults = {
        "id": str(uuid.uuid4()),
        "tenant_id": TENANT_ID,
        "sage_product_id": "SAGE-001",
        "sku": "OAK-001",
        "name": "Oak Flooring",
        "description": "Premium oak hardwood",
        "brand": "HardwoodPro",
        "unit_of_measure": "sqft",
        "dimensions": {"width": 6, "length": 48},
        "image_url": "https://example.com/oak.jpg",
        "availability_status": "in_stock",
        "category_id": None,
        "last_synced_at": datetime(2026, 1, 1, 12, 0, 0),
        "created_at": datetime(2026, 1, 1, 0, 0, 0),
        "updated_at": datetime(2026, 1, 1, 0, 0, 0),
    }
    defaults.update(overrides)
    m = MagicMock()
    for k, v in defaults.items():
        setattr(m, k, v)
    return m


def _make_price_mock(**overrides: Any) -> MagicMock:
    """Create a mock ProductPrice ORM object."""
    defaults = {
        "id": str(uuid.uuid4()),
        "product_id": str(uuid.uuid4()),
        "price_cents": 499,
        "currency": "USD",
        "effective_date": date(2026, 1, 1),
        "source": "sage_scrape",
        "created_at": datetime(2026, 1, 1, 0, 0, 0),
    }
    defaults.update(overrides)
    m = MagicMock()
    for k, v in defaults.items():
        setattr(m, k, v)
    return m


def _make_category_mock(**overrides: Any) -> MagicMock:
    """Create a mock ProductCategory ORM object."""
    defaults = {
        "id": str(uuid.uuid4()),
        "name": "Flooring",
        "parent_id": None,
        "sage_category_id": "CAT-FLOOR",
        "created_at": datetime(2026, 1, 1, 0, 0, 0),
        "updated_at": datetime(2026, 1, 1, 0, 0, 0),
    }
    defaults.update(overrides)
    m = MagicMock()
    for k, v in defaults.items():
        setattr(m, k, v)
    return m


def _make_redis(cache: dict[str, Any] | None = None) -> AsyncMock:
    """Create a mock Redis client with optional pre-seeded cache."""
    redis = AsyncMock()
    store = cache or {}

    async def _get(key: str) -> str | None:
        val = store.get(key)
        return json.dumps(val, default=str) if val is not None else None

    async def _setex(key: str, ttl: int, value: str) -> None:
        store[key] = json.loads(value)

    redis.get = AsyncMock(side_effect=_get)
    redis.setex = AsyncMock(side_effect=_setex)
    return redis


def _make_db_session() -> AsyncMock:
    """Create a mock AsyncSession."""
    db = AsyncMock()
    return db


def _make_bridge() -> AsyncMock:
    """Create a mock SagePlaywrightBridge."""
    bridge = AsyncMock()
    bridge.search_products = AsyncMock(return_value=[])
    bridge.get_product_detail = AsyncMock(return_value={})
    bridge.browse_category = AsyncMock(return_value=[])
    return bridge


def _setup_db_execute(db: AsyncMock, results: list[Any]) -> None:
    """Configure db.execute to return results from a sequence of calls.

    Each entry in *results* is the value returned by .scalar_one_or_none(),
    .scalar(), or .scalars().all() for the nth db.execute() call.
    """
    mock_results = []
    for r in results:
        result_mock = MagicMock()
        if isinstance(r, list):
            result_mock.scalars.return_value.all.return_value = r
        elif r is None:
            result_mock.scalar_one_or_none.return_value = None
            result_mock.scalar.return_value = 0
            result_mock.scalars.return_value.all.return_value = []
        elif isinstance(r, int):
            result_mock.scalar.return_value = r
        else:
            result_mock.scalar_one_or_none.return_value = r
            result_mock.scalars.return_value.all.return_value = [r]
        mock_results.append(result_mock)
    db.execute = AsyncMock(side_effect=mock_results)


# ---------------------------------------------------------------------------
# Test: search_products — cache hit
# ---------------------------------------------------------------------------


class TestSearchProductsCacheHit:
    @pytest.mark.asyncio
    async def test_returns_cached_data(self):
        """When Redis has a cached response, return it without touching DB or bridge."""
        cached_response = {
            "items": [{"id": "p1", "name": "Cached Product"}],
            "total": 1,
            "limit": 20,
            "offset": 0,
        }
        params = {
            "query": "oak", "category": None, "brand": None,
            "price_min": None, "price_max": None, "limit": 20, "offset": 0,
        }
        cache_key = _cache_key_search(params)
        redis = _make_redis(cache={cache_key: cached_response})
        bridge = _make_bridge()
        db = _make_db_session()

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.search_products(db, TENANT_ID, query="oak")

        assert result == cached_response
        db.execute.assert_not_called()
        bridge.search_products.assert_not_called()


# ---------------------------------------------------------------------------
# Test: search_products — DB results (no cache)
# ---------------------------------------------------------------------------


class TestSearchProductsDBResults:
    @pytest.mark.asyncio
    async def test_returns_db_products_and_caches(self):
        """When cache misses but DB has products, serve from DB and cache result."""
        product = _make_product_mock(name="DB Product", sku="DB-001")
        redis = _make_redis()
        bridge = _make_bridge()
        db = _make_db_session()

        # First execute: count query -> 1
        # Second execute: product query -> [product]
        count_result = MagicMock()
        count_result.scalar.return_value = 1
        products_result = MagicMock()
        products_result.scalars.return_value.all.return_value = [product]
        db.execute = AsyncMock(side_effect=[count_result, products_result])

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.search_products(db, TENANT_ID, query="DB")

        assert result["total"] == 1
        assert len(result["items"]) == 1
        assert result["items"][0]["name"] == "DB Product"
        assert result["items"][0]["sku"] == "DB-001"
        bridge.search_products.assert_not_called()
        # Verify cache was set
        redis.setex.assert_called_once()


# ---------------------------------------------------------------------------
# Test: search_products — Sage bridge fallback
# ---------------------------------------------------------------------------


class TestSearchProductsBridgeFallback:
    @pytest.mark.asyncio
    async def test_calls_bridge_when_no_cache_no_db(self):
        """When both cache and DB are empty, fall back to Sage bridge."""
        bridge_data = [
            {
                "product_id": "SAGE-101",
                "sku": "SAGE-101",
                "name": "Bridge Product",
                "description": "From Sage",
                "brand": "SageBrand",
                "price_cents": 1299,
            }
        ]
        redis = _make_redis()
        bridge = _make_bridge()
        bridge.search_products = AsyncMock(return_value=bridge_data)
        db = _make_db_session()

        # DB queries: count -> 0, products -> []
        count_result = MagicMock()
        count_result.scalar.return_value = 0
        products_result = MagicMock()
        products_result.scalars.return_value.all.return_value = []
        # _upsert_product does: select (not found) -> flush
        upsert_select_result = MagicMock()
        upsert_select_result.scalar_one_or_none.return_value = None
        # price select (no existing price)
        price_select_result = MagicMock()
        price_select_result.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(
            side_effect=[count_result, products_result, upsert_select_result, price_select_result]
        )
        db.flush = AsyncMock()
        db.add = MagicMock()

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.search_products(db, TENANT_ID, query="bridge")

        bridge.search_products.assert_called_once()
        assert result["total"] == 1
        assert len(result["items"]) == 1
        assert result["items"][0]["name"] == "Bridge Product"

    @pytest.mark.asyncio
    async def test_bridge_failure_returns_empty(self):
        """When the bridge raises an exception, return empty results gracefully."""
        redis = _make_redis()
        bridge = _make_bridge()
        bridge.search_products = AsyncMock(side_effect=Exception("Sage down"))
        db = _make_db_session()

        count_result = MagicMock()
        count_result.scalar.return_value = 0
        products_result = MagicMock()
        products_result.scalars.return_value.all.return_value = []
        db.execute = AsyncMock(side_effect=[count_result, products_result])

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.search_products(db, TENANT_ID, query="fail")

        assert result["items"] == []
        assert result["total"] == 0


# ---------------------------------------------------------------------------
# Test: get_product_detail — cache hit
# ---------------------------------------------------------------------------


class TestGetProductDetailCacheHit:
    @pytest.mark.asyncio
    async def test_returns_cached_detail(self):
        """When Redis has cached product detail, return it directly."""
        product_id = str(uuid.uuid4())
        cached = {
            "id": product_id,
            "name": "Cached Detail",
            "prices": [],
            "category": None,
        }
        cache_key = _cache_key_product(product_id)
        redis = _make_redis(cache={cache_key: cached})
        bridge = _make_bridge()
        db = _make_db_session()

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.get_product_detail(db, TENANT_ID, product_id)

        assert result == cached
        db.execute.assert_not_called()


# ---------------------------------------------------------------------------
# Test: get_product_detail — DB result
# ---------------------------------------------------------------------------


class TestGetProductDetailDB:
    @pytest.mark.asyncio
    async def test_returns_db_product_with_prices(self):
        """When DB has the product, return it with prices and cache."""
        product = _make_product_mock()
        price = _make_price_mock(product_id=product.id)
        redis = _make_redis()
        bridge = _make_bridge()
        db = _make_db_session()

        # execute calls: product select, prices select, category select (no category)
        product_result = MagicMock()
        product_result.scalar_one_or_none.return_value = product
        prices_result = MagicMock()
        prices_result.scalars.return_value.all.return_value = [price]
        db.execute = AsyncMock(side_effect=[product_result, prices_result])

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.get_product_detail(db, TENANT_ID, product.id)

        assert result["id"] == product.id
        assert result["name"] == "Oak Flooring"
        assert len(result["prices"]) == 1
        assert result["prices"][0]["price_cents"] == 499
        assert result["category"] is None
        redis.setex.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_db_product_with_category(self):
        """When product has a category_id, include category data."""
        cat = _make_category_mock()
        product = _make_product_mock(category_id=cat.id)
        redis = _make_redis()
        bridge = _make_bridge()
        db = _make_db_session()

        product_result = MagicMock()
        product_result.scalar_one_or_none.return_value = product
        prices_result = MagicMock()
        prices_result.scalars.return_value.all.return_value = []
        cat_result = MagicMock()
        cat_result.scalar_one_or_none.return_value = cat
        db.execute = AsyncMock(side_effect=[product_result, prices_result, cat_result])

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.get_product_detail(db, TENANT_ID, product.id)

        assert result["category"] is not None
        assert result["category"]["name"] == "Flooring"
        assert result["category"]["id"] == cat.id


# ---------------------------------------------------------------------------
# Test: get_product_detail — not found
# ---------------------------------------------------------------------------


class TestGetProductDetailNotFound:
    @pytest.mark.asyncio
    async def test_returns_none_when_not_in_db_and_bridge_fails(self):
        """When product is not in DB and bridge raises, return None."""
        redis = _make_redis()
        bridge = _make_bridge()
        bridge.get_product_detail = AsyncMock(side_effect=Exception("Not found"))
        db = _make_db_session()

        product_result = MagicMock()
        product_result.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(side_effect=[product_result])

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.get_product_detail(db, TENANT_ID, "nonexistent-id")

        assert result is None


# ---------------------------------------------------------------------------
# Test: get_categories — cache hit and DB fallback
# ---------------------------------------------------------------------------


class TestGetCategories:
    @pytest.mark.asyncio
    async def test_returns_cached_categories(self):
        """When Redis has cached categories, return them."""
        cached_cats = [{"id": "c1", "name": "Flooring"}]
        redis = _make_redis(cache={CACHE_KEY_CATEGORIES: cached_cats})
        bridge = _make_bridge()
        db = _make_db_session()

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.get_categories(db)

        assert result == cached_cats
        db.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_returns_db_categories_and_caches(self):
        """When cache misses, serve categories from DB and cache."""
        cat1 = _make_category_mock(name="Electrical")
        cat2 = _make_category_mock(name="Plumbing")
        redis = _make_redis()
        bridge = _make_bridge()
        db = _make_db_session()

        cats_result = MagicMock()
        cats_result.scalars.return_value.all.return_value = [cat1, cat2]
        db.execute = AsyncMock(return_value=cats_result)

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.get_categories(db)

        assert len(result) == 2
        assert result[0]["name"] == "Electrical"
        assert result[1]["name"] == "Plumbing"
        redis.setex.assert_called_once()


# ---------------------------------------------------------------------------
# Test: get_category_products
# ---------------------------------------------------------------------------


class TestGetCategoryProducts:
    @pytest.mark.asyncio
    async def test_returns_products_for_category(self):
        """Return products from DB for a given category_id."""
        cat_id = str(uuid.uuid4())
        product = _make_product_mock(category_id=cat_id)
        redis = _make_redis()
        bridge = _make_bridge()
        db = _make_db_session()

        count_result = MagicMock()
        count_result.scalar.return_value = 1
        products_result = MagicMock()
        products_result.scalars.return_value.all.return_value = [product]
        db.execute = AsyncMock(side_effect=[count_result, products_result])

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.get_category_products(db, TENANT_ID, cat_id)

        assert result["total"] == 1
        assert len(result["items"]) == 1
        assert result["items"][0]["category_id"] == cat_id

    @pytest.mark.asyncio
    async def test_falls_back_to_bridge_when_db_empty(self):
        """When DB has no products for category, fetch from bridge."""
        cat_id = str(uuid.uuid4())
        bridge_data = [
            {"product_id": "B1", "sku": "B1", "name": "Bridge Cat Product", "price_cents": 500}
        ]
        redis = _make_redis()
        bridge = _make_bridge()
        bridge.browse_category = AsyncMock(return_value=bridge_data)
        db = _make_db_session()

        product = _make_product_mock(category_id=cat_id, name="Bridge Cat Product")

        # First round: count=0, products=[]
        count_result_0 = MagicMock()
        count_result_0.scalar.return_value = 0
        products_result_0 = MagicMock()
        products_result_0.scalars.return_value.all.return_value = []
        # _upsert_product: select (not found), price select (not found)
        upsert_select = MagicMock()
        upsert_select.scalar_one_or_none.return_value = None
        price_select = MagicMock()
        price_select.scalar_one_or_none.return_value = None
        # Re-query after sync: products, count
        products_result_1 = MagicMock()
        products_result_1.scalars.return_value.all.return_value = [product]
        count_result_1 = MagicMock()
        count_result_1.scalar.return_value = 1

        db.execute = AsyncMock(side_effect=[
            count_result_0, products_result_0,
            upsert_select, price_select,
            products_result_1, count_result_1,
        ])
        db.flush = AsyncMock()
        db.add = MagicMock()

        svc = CatalogService(bridge=bridge, redis_client=redis)
        result = await svc.get_category_products(db, TENANT_ID, cat_id)

        bridge.browse_category.assert_called_once_with(cat_id, page=1)
        assert result["total"] == 1
        assert len(result["items"]) == 1


# ---------------------------------------------------------------------------
# Test: Redis fallback — service works when Redis is None
# ---------------------------------------------------------------------------


class TestRedisNone:
    @pytest.mark.asyncio
    async def test_search_works_without_redis(self):
        """When redis_client is None, skip caching and serve from DB."""
        product = _make_product_mock(name="No-Redis Product")
        bridge = _make_bridge()
        db = _make_db_session()

        count_result = MagicMock()
        count_result.scalar.return_value = 1
        products_result = MagicMock()
        products_result.scalars.return_value.all.return_value = [product]
        db.execute = AsyncMock(side_effect=[count_result, products_result])

        svc = CatalogService(bridge=bridge, redis_client=None)
        result = await svc.search_products(db, TENANT_ID, query="no-redis")

        assert len(result["items"]) == 1
        assert result["items"][0]["name"] == "No-Redis Product"

    @pytest.mark.asyncio
    async def test_cache_get_returns_none_when_redis_is_none(self):
        """_cache_get returns None when Redis client is None."""
        svc = CatalogService(bridge=_make_bridge(), redis_client=None)
        result = await svc._cache_get("any-key")
        assert result is None

    @pytest.mark.asyncio
    async def test_cache_set_is_noop_when_redis_is_none(self):
        """_cache_set does nothing when Redis client is None."""
        svc = CatalogService(bridge=_make_bridge(), redis_client=None)
        # Should not raise
        await svc._cache_set("any-key", {"data": 1}, 300)

    @pytest.mark.asyncio
    async def test_cache_get_handles_redis_exception(self):
        """_cache_get returns None on Redis failure."""
        redis = AsyncMock()
        redis.get = AsyncMock(side_effect=ConnectionError("Redis down"))
        svc = CatalogService(bridge=_make_bridge(), redis_client=redis)
        result = await svc._cache_get("some-key")
        assert result is None

    @pytest.mark.asyncio
    async def test_cache_set_handles_redis_exception(self):
        """_cache_set swallows Redis failure silently."""
        redis = AsyncMock()
        redis.setex = AsyncMock(side_effect=ConnectionError("Redis down"))
        svc = CatalogService(bridge=_make_bridge(), redis_client=redis)
        # Should not raise
        await svc._cache_set("some-key", {"data": 1}, 300)


# ---------------------------------------------------------------------------
# Test: _upsert_product — insert, update, price handling
# ---------------------------------------------------------------------------


class TestUpsertProduct:
    @pytest.mark.asyncio
    async def test_inserts_new_product(self):
        """When product does not exist in DB, insert a new one."""
        db = _make_db_session()
        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = None
        # No existing price
        price_result = MagicMock()
        price_result.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(side_effect=[select_result, price_result])
        db.flush = AsyncMock()
        db.add = MagicMock()

        data = {
            "product_id": "NEW-001",
            "sku": "NEW-001",
            "name": "New Product",
            "description": "Brand new",
            "brand": "NewBrand",
            "price_cents": 999,
        }

        product = await CatalogService._upsert_product(db, TENANT_ID, data)

        assert product.sku == "NEW-001"
        assert product.name == "New Product"
        assert product.brand == "NewBrand"
        assert product.tenant_id == TENANT_ID
        # db.add should be called for the product and the price
        assert db.add.call_count == 2
        db.flush.assert_called_once()

    @pytest.mark.asyncio
    async def test_updates_existing_product(self):
        """When product already exists, update its fields."""
        existing = _make_product_mock(name="Old Name", brand="OldBrand")
        db = _make_db_session()
        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = existing
        db.execute = AsyncMock(side_effect=[select_result])
        db.flush = AsyncMock()

        data = {
            "product_id": existing.sage_product_id,
            "name": "Updated Name",
            "brand": "NewBrand",
        }

        product = await CatalogService._upsert_product(db, TENANT_ID, data)

        assert product.name == "Updated Name"
        assert product.brand == "NewBrand"
        db.flush.assert_called_once()
        # No db.add for the product itself (it already exists)

    @pytest.mark.asyncio
    async def test_inserts_price_when_changed(self):
        """When price_cents differs from last price, insert new price row."""
        existing = _make_product_mock()
        old_price = _make_price_mock(product_id=existing.id, price_cents=400)
        db = _make_db_session()
        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = existing
        price_result = MagicMock()
        price_result.scalar_one_or_none.return_value = old_price
        db.execute = AsyncMock(side_effect=[select_result, price_result])
        db.flush = AsyncMock()
        db.add = MagicMock()

        data = {
            "product_id": existing.sage_product_id,
            "name": existing.name,
            "price_cents": 599,  # different from 400
        }

        await CatalogService._upsert_product(db, TENANT_ID, data)

        # db.add called once for the new price
        db.add.assert_called_once()

    @pytest.mark.asyncio
    async def test_skips_price_insert_when_unchanged(self):
        """When price_cents matches the last price, do not insert."""
        existing = _make_product_mock()
        old_price = _make_price_mock(product_id=existing.id, price_cents=499)
        db = _make_db_session()
        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = existing
        price_result = MagicMock()
        price_result.scalar_one_or_none.return_value = old_price
        db.execute = AsyncMock(side_effect=[select_result, price_result])
        db.flush = AsyncMock()
        db.add = MagicMock()

        data = {
            "product_id": existing.sage_product_id,
            "name": existing.name,
            "price_cents": 499,  # same as existing
        }

        await CatalogService._upsert_product(db, TENANT_ID, data)

        db.add.assert_not_called()

    @pytest.mark.asyncio
    async def test_inserts_price_when_no_previous_price(self):
        """When there is no previous price at all, insert the new price."""
        existing = _make_product_mock()
        db = _make_db_session()
        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = existing
        price_result = MagicMock()
        price_result.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(side_effect=[select_result, price_result])
        db.flush = AsyncMock()
        db.add = MagicMock()

        data = {
            "product_id": existing.sage_product_id,
            "name": existing.name,
            "price_cents": 750,
        }

        await CatalogService._upsert_product(db, TENANT_ID, data)

        db.add.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_price_query_when_price_not_provided(self):
        """When data has no price_cents, skip price logic entirely."""
        existing = _make_product_mock()
        db = _make_db_session()
        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = existing
        db.execute = AsyncMock(side_effect=[select_result])
        db.flush = AsyncMock()
        db.add = MagicMock()

        data = {
            "product_id": existing.sage_product_id,
            "name": existing.name,
            # no price_cents
        }

        await CatalogService._upsert_product(db, TENANT_ID, data)

        # Only one db.execute call (the product select), no price query
        assert db.execute.call_count == 1
        db.add.assert_not_called()
