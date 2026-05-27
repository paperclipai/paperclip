"""Low-level Playwright Page helpers used by HTTP endpoints.

These don't reference module-level globals — they take a `page` and
return. Pure enough that they could in principle be unit-tested with a
mocked Page, though Camoufox/Playwright stubs are non-trivial.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # Playwright imported only for type hints — keeps page_ops importable
    # in unit-test CI that skips the Docker layer.
    from playwright.sync_api import Page


def run_in_page(page: Page, code: str) -> Any:
    """Wrap arbitrary JS in the async IIFE pattern Playwright sync_api expects.

    Bare arrow functions and synchronous IIFEs both have edge cases that
    return None even when the function body executed correctly. Always use
    this wrapper for in-page evaluations.
    """
    return page.evaluate("(async () => { " + code + " })()")


def click_aid_by_coords(page: Page, aid: str, settle_ms: int = 600) -> dict:
    """Click a `data-automation-id`-keyed element and return its bounding rect.

    Uses `locator.click(force=True)` which skips actionability preflight
    (visibility, stability, receives-events) — Webflow's transparent overlays
    fail those checks even when the click would succeed. Routes through
    Playwright's full pointer-event sequence, which is what React-DnD and
    Webflow's React handlers actually listen for. Verified 2026-05-07:
    external /click HTTP requests open the panel, but bare `mouse.click()`
    from inside the same handler does not.
    """
    sel = "[data-automation-id=" + json.dumps(aid) + "]"
    loc = page.locator(sel).first
    try:
        loc.click(force=True, timeout=8000)
    except Exception as e:
        raise RuntimeError("click failed for " + aid + ": " + str(e)[:200])
    page.wait_for_timeout(settle_ms)
    rect = run_in_page(
        page,
        "const b = document.querySelector(" + json.dumps(sel) + ");"
        " if (!b) return null;"
        " const r = b.getBoundingClientRect();"
        " return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: r.width, h: r.height };",
    )
    return rect or {"x": 0, "y": 0, "w": 0, "h": 0}


def fill_locator(page: Page, selector: str, value: str) -> None:
    """Focus a Locator and overwrite its value.

    Same locator(force=True) pattern as click_aid_by_coords. After focus,
    select-all + type to overwrite Webflow's pre-filled value (e.g.
    "Untitled"). Sequential keypresses (vs. .value=) so React's onChange +
    form-state validators fire properly.
    """
    loc = page.locator(selector).first
    try:
        loc.click(force=True, timeout=8000)
    except Exception as e:
        raise RuntimeError("focus failed for " + selector + ": " + str(e)[:200])
    page.keyboard.press("Control+A")
    page.keyboard.press("Delete")
    page.keyboard.type(value, delay=15)


def fill_aid(page: Page, aid: str, value: str) -> None:
    """Convenience wrapper for fields keyed by full data-automation-id.

    When the id is unstable (Webflow re-slugs the page name into form-field
    ids on every keypress), use fill_locator with a suffix-match selector
    instead.
    """
    fill_locator(page, "[data-automation-id=" + json.dumps(aid) + "]", value)
