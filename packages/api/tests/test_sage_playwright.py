"""Tests for the Sage Playwright Bridge — all Playwright interactions are mocked."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.sage_playwright import (
    CircuitBreaker,
    RateLimiter,
    SageAuthError,
    SageParsingError,
    SagePlaywrightBridge,
    SageTimeoutError,
    SageUnavailableError,
)


# ---------------------------------------------------------------------------
# RateLimiter tests
# ---------------------------------------------------------------------------


class TestRateLimiter:
    @pytest.mark.asyncio
    async def test_first_request_passes_immediately(self):
        limiter = RateLimiter(interval=2.0)
        start = time.monotonic()
        await limiter.acquire()
        elapsed = time.monotonic() - start
        assert elapsed < 0.1

    @pytest.mark.asyncio
    async def test_second_request_is_delayed(self):
        limiter = RateLimiter(interval=0.2)
        await limiter.acquire()
        start = time.monotonic()
        await limiter.acquire()
        elapsed = time.monotonic() - start
        assert elapsed >= 0.15  # allow small tolerance

    @pytest.mark.asyncio
    async def test_request_after_interval_passes(self):
        limiter = RateLimiter(interval=0.1)
        await limiter.acquire()
        await asyncio.sleep(0.15)
        start = time.monotonic()
        await limiter.acquire()
        elapsed = time.monotonic() - start
        assert elapsed < 0.1


# ---------------------------------------------------------------------------
# CircuitBreaker tests
# ---------------------------------------------------------------------------


class TestCircuitBreaker:
    def test_starts_closed(self):
        cb = CircuitBreaker(failure_threshold=5, recovery_timeout=60.0)
        assert not cb.is_open
        assert not cb.is_half_open

    def test_opens_after_threshold_failures(self):
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=60.0)
        for _ in range(3):
            cb.record_failure()
        assert cb.is_open

    def test_stays_closed_below_threshold(self):
        cb = CircuitBreaker(failure_threshold=5, recovery_timeout=60.0)
        for _ in range(4):
            cb.record_failure()
        assert not cb.is_open

    def test_success_resets_counter(self):
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=60.0)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        cb.record_failure()
        cb.record_failure()
        assert not cb.is_open

    def test_half_open_after_recovery_timeout(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1)
        cb.record_failure()
        assert cb.is_open
        time.sleep(0.15)
        assert not cb.is_open
        assert cb.is_half_open

    def test_success_after_half_open_closes(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1)
        cb.record_failure()
        time.sleep(0.15)
        _ = cb.is_open  # triggers half-open
        cb.record_success()
        assert not cb.is_open
        assert not cb.is_half_open

    def test_failure_in_half_open_reopens(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1)
        cb.record_failure()
        time.sleep(0.15)
        _ = cb.is_open  # triggers half-open
        cb.record_failure()
        assert cb.is_open


# ---------------------------------------------------------------------------
# SagePlaywrightBridge tests (mocked Playwright)
# ---------------------------------------------------------------------------


def _make_mock_element(text: str | None = None, attr_map: dict | None = None):
    """Create a mock Playwright element handle."""
    el = AsyncMock()
    el.text_content = AsyncMock(return_value=text)
    el.get_attribute = AsyncMock(side_effect=lambda a: (attr_map or {}).get(a))
    return el


def _make_mock_page(
    search_cards: list[dict] | None = None,
    product_detail: dict | None = None,
    login_success: bool = True,
):
    """Build a fully-mocked Playwright Page."""
    page = AsyncMock()
    page.goto = AsyncMock()
    page.fill = AsyncMock()
    page.click = AsyncMock()
    page.close = AsyncMock()

    if login_success:
        page.wait_for_selector = AsyncMock()
    else:
        page.wait_for_selector = AsyncMock(side_effect=Exception("Login element not found"))

    if search_cards is not None:
        cards = []
        for card_data in search_cards:
            card = AsyncMock()

            async def _card_qs(sel, _d=card_data):
                if "name" in sel.lower():
                    return _make_mock_element(_d.get("name"))
                if "sku" in sel.lower():
                    return _make_mock_element(_d.get("sku"))
                if "price" in sel.lower():
                    return _make_mock_element(_d.get("price"))
                if sel == "a":
                    return _make_mock_element(attr_map={"href": _d.get("href", "/products/123")})
                return None

            card.query_selector = _card_qs
            cards.append(card)

        page.query_selector_all = AsyncMock(return_value=cards)

    if product_detail is not None:

        async def _detail_qs(sel):
            if "name" in sel.lower() or "title" in sel.lower():
                return _make_mock_element(product_detail.get("name"))
            if "sku" in sel.lower():
                return _make_mock_element(product_detail.get("sku"))
            if "price" in sel.lower():
                return _make_mock_element(product_detail.get("price"))
            if "description" in sel.lower():
                return _make_mock_element(product_detail.get("description"))
            if "availability" in sel.lower():
                return _make_mock_element(product_detail.get("availability"))
            if "category" in sel.lower():
                return _make_mock_element(product_detail.get("category"))
            if "brand" in sel.lower():
                return _make_mock_element(product_detail.get("brand"))
            if "dimensions" in sel.lower():
                return _make_mock_element(product_detail.get("dimensions"))
            if "image" in sel.lower():
                return _make_mock_element(attr_map={"src": product_detail.get("image_url")})
            return None

        page.query_selector = _detail_qs

    return page


def _make_bridge(**kwargs) -> SagePlaywrightBridge:
    """Create a bridge with short rate-limit for fast tests."""
    defaults = {
        "portal_url": "https://test-sage.example.com",
        "username": "testuser",
        "password": "testpass",
        "rate_limit_interval": 0.0,
        "failure_threshold": 5,
        "recovery_timeout": 60.0,
    }
    defaults.update(kwargs)
    return SagePlaywrightBridge(**defaults)


class TestSagePlaywrightBridge:
    @pytest.mark.asyncio
    async def test_search_products_returns_structured_data(self):
        bridge = _make_bridge()
        mock_page = _make_mock_page(
            search_cards=[
                {"name": "Oak Flooring", "sku": "OAK-001", "price": "$4.99", "href": "/products/p1"},
                {"name": "Maple Trim", "sku": "MPL-002", "price": "$2.50", "href": "/products/p2"},
            ]
        )
        bridge._get_page = AsyncMock(return_value=mock_page)

        results = await bridge.search_products("flooring")
        assert len(results) == 2
        assert results[0]["name"] == "Oak Flooring"
        assert results[0]["sku"] == "OAK-001"
        assert results[0]["price_cents"] == 499
        assert results[0]["product_id"] == "p1"
        assert results[1]["name"] == "Maple Trim"
        assert results[1]["price_cents"] == 250

    @pytest.mark.asyncio
    async def test_search_products_with_category_filter(self):
        bridge = _make_bridge()
        mock_page = _make_mock_page(search_cards=[{"name": "Item", "sku": "X", "price": "$1.00"}])
        bridge._get_page = AsyncMock(return_value=mock_page)

        results = await bridge.search_products("tile", category="flooring", page=2)
        assert len(results) == 1
        mock_page.goto.assert_called_once()
        call_url = mock_page.goto.call_args[0][0]
        assert "category=flooring" in call_url
        assert "page=2" in call_url

    @pytest.mark.asyncio
    async def test_get_product_detail(self):
        bridge = _make_bridge()
        mock_page = _make_mock_page(
            product_detail={
                "name": "Premium Oak Plank",
                "sku": "OAK-PREM-001",
                "price": "$8.99",
                "description": "6-inch wide premium oak hardwood plank",
                "availability": "In Stock",
                "category": "Flooring",
                "brand": "HardwoodPro",
                "dimensions": "6\" x 48\"",
                "image_url": "https://sage.example.com/img/oak.jpg",
            }
        )
        bridge._get_page = AsyncMock(return_value=mock_page)

        result = await bridge.get_product_detail("OAK-PREM-001")
        assert result["name"] == "Premium Oak Plank"
        assert result["sku"] == "OAK-PREM-001"
        assert result["price_cents"] == 899
        assert result["description"] == "6-inch wide premium oak hardwood plank"
        assert result["availability"] == "In Stock"
        assert result["brand"] == "HardwoodPro"
        assert result["image_url"] == "https://sage.example.com/img/oak.jpg"

    @pytest.mark.asyncio
    async def test_browse_category(self):
        bridge = _make_bridge()
        mock_page = _make_mock_page(
            search_cards=[{"name": "HVAC Unit", "sku": "HVAC-100", "price": "$1,299.00"}]
        )
        bridge._get_page = AsyncMock(return_value=mock_page)

        results = await bridge.browse_category("hvac", page=1)
        assert len(results) == 1
        assert results[0]["name"] == "HVAC Unit"
        assert results[0]["price_cents"] == 129900

    @pytest.mark.asyncio
    async def test_circuit_breaker_opens_after_failures(self):
        bridge = _make_bridge(failure_threshold=3, rate_limit_interval=0.0)
        mock_page = _make_mock_page(search_cards=[])
        mock_page.wait_for_selector = AsyncMock(side_effect=Exception("timeout"))
        bridge._get_page = AsyncMock(return_value=mock_page)

        for _ in range(3):
            with pytest.raises(SageTimeoutError):
                await bridge.search_products("test")

        with pytest.raises(SageUnavailableError):
            await bridge.search_products("test")

    @pytest.mark.asyncio
    async def test_circuit_breaker_success_resets(self):
        bridge = _make_bridge(failure_threshold=3, rate_limit_interval=0.0)

        # 2 failures
        fail_page = _make_mock_page(search_cards=[])
        fail_page.wait_for_selector = AsyncMock(side_effect=Exception("timeout"))
        bridge._get_page = AsyncMock(return_value=fail_page)
        for _ in range(2):
            with pytest.raises(SageTimeoutError):
                await bridge.search_products("test")

        # 1 success
        ok_page = _make_mock_page(search_cards=[{"name": "A", "sku": "B", "price": "$1.00"}])
        bridge._get_page = AsyncMock(return_value=ok_page)
        results = await bridge.search_products("test")
        assert len(results) == 1

        # 2 more failures should not open circuit (counter was reset)
        bridge._get_page = AsyncMock(return_value=fail_page)
        for _ in range(2):
            with pytest.raises(SageTimeoutError):
                await bridge.search_products("test")

        # Should NOT be open (only 2 consecutive failures)
        ok_page2 = _make_mock_page(search_cards=[{"name": "C", "sku": "D", "price": "$2.00"}])
        bridge._get_page = AsyncMock(return_value=ok_page2)
        results = await bridge.search_products("test")
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_auth_error_on_login_failure(self):
        bridge = _make_bridge()
        mock_page = _make_mock_page(login_success=False)
        # Need to simulate login failure in _get_page
        bridge._context = None
        bridge._logged_in = False

        mock_ctx = AsyncMock()
        mock_ctx.new_page = AsyncMock(return_value=mock_page)

        with patch.object(bridge, "_ensure_browser", return_value=mock_ctx):
            with pytest.raises(SageAuthError):
                await bridge.search_products("test")

    @pytest.mark.asyncio
    async def test_parsing_error_on_missing_product_name(self):
        bridge = _make_bridge()
        mock_page = AsyncMock()
        mock_page.goto = AsyncMock()
        mock_page.close = AsyncMock()
        mock_page.wait_for_selector = AsyncMock()
        mock_page.query_selector = AsyncMock(return_value=None)
        bridge._get_page = AsyncMock(return_value=mock_page)

        with pytest.raises(SageParsingError) as exc_info:
            await bridge.get_product_detail("some-id")
        assert "product-name" in exc_info.value.selector.lower() or "product-title" in exc_info.value.selector.lower()

    @pytest.mark.asyncio
    async def test_close_cleans_up_resources(self):
        bridge = _make_bridge()
        mock_ctx = AsyncMock()
        mock_browser = AsyncMock()
        mock_pw = AsyncMock()
        bridge._context = mock_ctx
        bridge._browser = mock_browser
        bridge._playwright = mock_pw
        bridge._logged_in = True

        await bridge.close()

        mock_ctx.close.assert_called_once()
        mock_browser.close.assert_called_once()
        mock_pw.stop.assert_called_once()
        assert bridge._context is None
        assert bridge._browser is None
        assert bridge._playwright is None
        assert not bridge._logged_in

    @pytest.mark.asyncio
    async def test_price_parsing_handles_comma_thousands(self):
        bridge = _make_bridge()
        mock_page = _make_mock_page(
            search_cards=[{"name": "Expensive Item", "sku": "EXP-1", "price": "$12,345.67"}]
        )
        bridge._get_page = AsyncMock(return_value=mock_page)

        results = await bridge.search_products("expensive")
        assert results[0]["price_cents"] == 1234567

    @pytest.mark.asyncio
    async def test_price_parsing_handles_no_price(self):
        bridge = _make_bridge()
        mock_page = _make_mock_page(
            search_cards=[{"name": "Free Item", "sku": "FREE-1", "price": None}]
        )
        bridge._get_page = AsyncMock(return_value=mock_page)

        results = await bridge.search_products("free")
        assert results[0]["price_cents"] is None

    @pytest.mark.asyncio
    async def test_pages_are_closed_after_use(self):
        bridge = _make_bridge()
        mock_page = _make_mock_page(
            search_cards=[{"name": "Item", "sku": "X", "price": "$1.00"}]
        )
        bridge._get_page = AsyncMock(return_value=mock_page)

        await bridge.search_products("test")
        mock_page.close.assert_called_once()
