"""Sage portal headless automation via Playwright.

30-day interim bridge until Sage grants direct API access.
Designed for easy replacement — all portal interaction is isolated here.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

from playwright.async_api import Browser, BrowserContext, Page, async_playwright

# ---------------------------------------------------------------------------
# Configuration (env vars)
# ---------------------------------------------------------------------------

SAGE_PORTAL_URL = os.getenv("SAGE_PORTAL_URL", "https://sage.example.com")
SAGE_USERNAME = os.getenv("SAGE_USERNAME", "")
SAGE_PASSWORD = os.getenv("SAGE_PASSWORD", "")

# ---------------------------------------------------------------------------
# CSS Selectors — update these when the Sage portal changes
# TODO: Replace with real selectors once portal access is confirmed
# ---------------------------------------------------------------------------

SEL_LOGIN_USERNAME = 'input[name="username"]'
SEL_LOGIN_PASSWORD = 'input[name="password"]'
SEL_LOGIN_SUBMIT = 'button[type="submit"]'
SEL_LOGIN_SUCCESS = ".dashboard, .user-menu"

SEL_SEARCH_INPUT = 'input[name="q"], input[type="search"]'
SEL_SEARCH_SUBMIT = 'button[type="submit"]'
SEL_SEARCH_RESULTS = ".product-list .product-item"

SEL_PRODUCT_NAME = ".product-name, h1.product-title"
SEL_PRODUCT_SKU = ".product-sku, [data-field='sku']"
SEL_PRODUCT_PRICE = ".product-price, [data-field='price']"
SEL_PRODUCT_DESCRIPTION = ".product-description, [data-field='description']"
SEL_PRODUCT_AVAILABILITY = ".product-availability, [data-field='availability']"
SEL_PRODUCT_CATEGORY = ".product-category, [data-field='category']"
SEL_PRODUCT_BRAND = ".product-brand, [data-field='brand']"
SEL_PRODUCT_DIMENSIONS = ".product-dimensions, [data-field='dimensions']"
SEL_PRODUCT_IMAGE = ".product-image img, [data-field='image'] img"

SEL_CATEGORY_NAV = ".category-nav a, .category-list a"
SEL_PAGINATION_NEXT = "a.next, button.next-page"

# ---------------------------------------------------------------------------
# Custom Exceptions
# ---------------------------------------------------------------------------


class SageAuthError(Exception):
    """Raised when login to Sage portal fails."""


class SageTimeoutError(Exception):
    """Raised when a Sage portal request times out."""


class SageParsingError(Exception):
    """Raised when a CSS selector fails to match expected elements."""

    def __init__(self, selector: str, message: str = ""):
        self.selector = selector
        super().__init__(f"Selector '{selector}' failed to match: {message}" if message else f"Selector '{selector}' failed to match")


class SageUnavailableError(Exception):
    """Raised when the circuit breaker is open."""


# ---------------------------------------------------------------------------
# Rate Limiter
# ---------------------------------------------------------------------------


class RateLimiter:
    """Token-bucket rate limiter: max 1 request per `interval` seconds."""

    def __init__(self, interval: float = 2.0) -> None:
        self._interval = interval
        self._last_request: float = 0.0

    async def acquire(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_request
        if elapsed < self._interval:
            await asyncio.sleep(self._interval - elapsed)
        self._last_request = time.monotonic()


# ---------------------------------------------------------------------------
# Circuit Breaker
# ---------------------------------------------------------------------------


class CircuitBreaker:
    """Three-state circuit breaker: closed → open → half-open → closed."""

    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 60.0) -> None:
        self._failure_threshold = failure_threshold
        self._recovery_timeout = recovery_timeout
        self._consecutive_failures = 0
        self._opened_at: float | None = None
        self._half_open = False

    @property
    def is_open(self) -> bool:
        if self._opened_at is None:
            return False
        elapsed = time.monotonic() - self._opened_at
        if elapsed >= self._recovery_timeout:
            self._half_open = True
            return False
        return True

    @property
    def is_half_open(self) -> bool:
        return self._half_open

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._opened_at = None
        self._half_open = False

    def record_failure(self) -> None:
        self._consecutive_failures += 1
        self._half_open = False
        if self._consecutive_failures >= self._failure_threshold:
            self._opened_at = time.monotonic()


# ---------------------------------------------------------------------------
# Sage Playwright Bridge
# ---------------------------------------------------------------------------


class SagePlaywrightBridge:
    """Headless Playwright automation against the Sage web portal."""

    def __init__(
        self,
        portal_url: str | None = None,
        username: str | None = None,
        password: str | None = None,
        rate_limit_interval: float = 2.0,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
    ) -> None:
        self._portal_url = portal_url or SAGE_PORTAL_URL
        self._username = username or SAGE_USERNAME
        self._password = password or SAGE_PASSWORD
        self._rate_limiter = RateLimiter(interval=rate_limit_interval)
        self._circuit_breaker = CircuitBreaker(
            failure_threshold=failure_threshold,
            recovery_timeout=recovery_timeout,
        )
        self._playwright: Any = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._logged_in = False

    # -- lifecycle -----------------------------------------------------------

    async def _ensure_browser(self) -> BrowserContext:
        """Lazy browser launch — reuse across requests."""
        if self._context is not None:
            return self._context
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=True)
        self._context = await self._browser.new_context()
        return self._context

    async def _login(self, page: Page) -> None:
        """Authenticate with the Sage portal."""
        await page.goto(f"{self._portal_url}/login", timeout=30000)
        await page.fill(SEL_LOGIN_USERNAME, self._username)
        await page.fill(SEL_LOGIN_PASSWORD, self._password)
        await page.click(SEL_LOGIN_SUBMIT)
        try:
            await page.wait_for_selector(SEL_LOGIN_SUCCESS, timeout=15000)
        except Exception as exc:
            raise SageAuthError(f"Login failed for user '{self._username}'") from exc
        self._logged_in = True

    async def _get_page(self) -> Page:
        """Get a logged-in page, creating one if needed."""
        ctx = await self._ensure_browser()
        page = await ctx.new_page()
        if not self._logged_in:
            await self._login(page)
        return page

    async def close(self) -> None:
        """Shut down browser resources."""
        if self._context:
            await self._context.close()
            self._context = None
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None
        self._logged_in = False

    # -- guard ---------------------------------------------------------------

    async def _guarded_call(self, coro_factory):
        """Rate-limit + circuit-breaker wrapper."""
        if self._circuit_breaker.is_open:
            raise SageUnavailableError("Circuit breaker is open — Sage portal appears down")

        await self._rate_limiter.acquire()
        try:
            result = await coro_factory()
            self._circuit_breaker.record_success()
            return result
        except (SageAuthError, SageParsingError):
            self._circuit_breaker.record_failure()
            raise
        except Exception as exc:
            self._circuit_breaker.record_failure()
            raise SageTimeoutError(str(exc)) from exc

    # -- helpers -------------------------------------------------------------

    @staticmethod
    async def _safe_text(page: Page, selector: str) -> str | None:
        """Extract text from a selector, return None if not found."""
        el = await page.query_selector(selector)
        if el is None:
            return None
        return (await el.text_content() or "").strip()

    @staticmethod
    async def _safe_attr(page: Page, selector: str, attr: str) -> str | None:
        """Extract an attribute from a selector, return None if not found."""
        el = await page.query_selector(selector)
        if el is None:
            return None
        return await el.get_attribute(attr)

    async def _parse_product_from_page(self, page: Page) -> dict[str, Any]:
        """Extract structured product data from a product detail page."""
        name = await self._safe_text(page, SEL_PRODUCT_NAME)
        if name is None:
            raise SageParsingError(SEL_PRODUCT_NAME, "Could not find product name on detail page")

        price_text = await self._safe_text(page, SEL_PRODUCT_PRICE)
        price_cents: int | None = None
        if price_text:
            cleaned = price_text.replace("$", "").replace(",", "").strip()
            try:
                price_cents = int(round(float(cleaned) * 100))
            except ValueError:
                price_cents = None

        dimensions_text = await self._safe_text(page, SEL_PRODUCT_DIMENSIONS)
        dimensions: dict[str, Any] | None = None
        if dimensions_text:
            dimensions = {"raw": dimensions_text}

        return {
            "name": name,
            "sku": await self._safe_text(page, SEL_PRODUCT_SKU),
            "price_cents": price_cents,
            "description": await self._safe_text(page, SEL_PRODUCT_DESCRIPTION),
            "availability": await self._safe_text(page, SEL_PRODUCT_AVAILABILITY),
            "category": await self._safe_text(page, SEL_PRODUCT_CATEGORY),
            "brand": await self._safe_text(page, SEL_PRODUCT_BRAND),
            "dimensions": dimensions,
            "image_url": await self._safe_attr(page, SEL_PRODUCT_IMAGE, "src"),
        }

    async def _parse_product_card(self, card) -> dict[str, Any]:
        """Extract summary data from a search result card element."""
        name_el = await card.query_selector(SEL_PRODUCT_NAME)
        name = (await name_el.text_content() or "").strip() if name_el else "Unknown"

        sku_el = await card.query_selector(SEL_PRODUCT_SKU)
        sku = (await sku_el.text_content() or "").strip() if sku_el else None

        price_el = await card.query_selector(SEL_PRODUCT_PRICE)
        price_text = (await price_el.text_content() or "").strip() if price_el else None
        price_cents: int | None = None
        if price_text:
            cleaned = price_text.replace("$", "").replace(",", "").strip()
            try:
                price_cents = int(round(float(cleaned) * 100))
            except ValueError:
                price_cents = None

        link_el = await card.query_selector("a")
        product_id = None
        if link_el:
            href = await link_el.get_attribute("href")
            if href:
                product_id = href.rstrip("/").split("/")[-1]

        return {
            "name": name,
            "sku": sku,
            "price_cents": price_cents,
            "product_id": product_id,
        }

    # -- public API ----------------------------------------------------------

    async def search_products(
        self, query: str, category: str | None = None, page: int = 1
    ) -> list[dict[str, Any]]:
        """Search the Sage catalog and return structured product data."""

        async def _do_search() -> list[dict[str, Any]]:
            p = await self._get_page()
            try:
                url = f"{self._portal_url}/products/search?q={query}&page={page}"
                if category:
                    url += f"&category={category}"
                await p.goto(url, timeout=30000)

                await p.wait_for_selector(SEL_SEARCH_RESULTS, timeout=15000)
                cards = await p.query_selector_all(SEL_SEARCH_RESULTS)
                results = []
                for card in cards:
                    results.append(await self._parse_product_card(card))
                return results
            finally:
                await p.close()

        return await self._guarded_call(_do_search)

    async def get_product_detail(self, product_id: str) -> dict[str, Any]:
        """Fetch full detail for a single product."""

        async def _do_detail() -> dict[str, Any]:
            p = await self._get_page()
            try:
                await p.goto(
                    f"{self._portal_url}/products/{product_id}", timeout=30000
                )
                await p.wait_for_selector(SEL_PRODUCT_NAME, timeout=15000)
                return await self._parse_product_from_page(p)
            finally:
                await p.close()

        return await self._guarded_call(_do_detail)

    async def browse_category(
        self, category_id: str, page: int = 1
    ) -> list[dict[str, Any]]:
        """Browse products within a specific category."""

        async def _do_browse() -> list[dict[str, Any]]:
            p = await self._get_page()
            try:
                await p.goto(
                    f"{self._portal_url}/categories/{category_id}?page={page}",
                    timeout=30000,
                )
                await p.wait_for_selector(SEL_SEARCH_RESULTS, timeout=15000)
                cards = await p.query_selector_all(SEL_SEARCH_RESULTS)
                results = []
                for card in cards:
                    results.append(await self._parse_product_card(card))
                return results
            finally:
                await p.close()

        return await self._guarded_call(_do_browse)
