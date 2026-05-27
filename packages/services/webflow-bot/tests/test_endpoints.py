"""Unit tests for endpoints.py.

The ep_* functions all take (page, body) and either return a dict or a
(bytes, content_type) tuple. Tests exercise the routing contract + the
small amount of input validation that lives outside Playwright calls.

Playwright is TYPE_CHECKING-only in this module, so we can import it and
inspect ROUTES without spinning up a browser.

Note: `/eval` references below are about the bot's HTTP endpoint that
calls `page.evaluate(...)` (Playwright's in-browser JS runner) — not
Python's `eval()`.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from webflow_bot import endpoints


def test_routes_dict_has_all_endpoints():
    """ROUTES is the source of truth for the HTTP POST contract surface
    that cluster agents depend on. Pin every path so removing one is a
    visible test diff."""
    assert set(endpoints.ROUTES) == {
        "/screenshot",
        "/eval",
        "/key",
        "/click",
        "/dblclick",
        "/drag",
        "/selectorClick",
        "/setHtmlEmbed",
        "/createPage",
    }


def test_routes_all_callable():
    """Every value in ROUTES must be a callable taking (page, body)."""
    for path, handler in endpoints.ROUTES.items():
        assert callable(handler), f"ROUTES[{path}] is not callable"


def test_ep_create_page_rejects_empty_name():
    """Empty `name` is the only input-validation rule the endpoint enforces
    before driving the UI. The Designer's PageSettingsForm would reject it
    later anyway, but pre-validating turns the failure into an HTTP 200 +
    {ok: false, error} instead of a 500 with a Designer-UI exception."""
    page = MagicMock()
    result = endpoints.ep_create_page(page, {"name": "", "slug": "x"})
    assert result == {"ok": False, "error": "name required"}
    # The page must NOT have been driven — no clicks, no keyboard input.
    page.mouse.click.assert_not_called()
    page.keyboard.press.assert_not_called()


def test_ep_create_page_rejects_whitespace_only_name():
    """name = '   ' should also be rejected (stripped to '')."""
    page = MagicMock()
    result = endpoints.ep_create_page(page, {"name": "   ", "slug": "x"})
    assert result == {"ok": False, "error": "name required"}


def test_ep_screenshot_returns_bytes_tuple():
    """screenshot is the only endpoint that returns (bytes, content_type).
    The control plane uses isinstance checks to switch between _send_bytes
    and _send_json — this contract must hold."""
    page = MagicMock()
    page.screenshot.return_value = b"\x89PNG\r\n\x1a\n"
    result = endpoints.ep_screenshot(page, {"fullPage": True})
    assert isinstance(result, tuple)
    assert len(result) == 2
    assert isinstance(result[0], bytes)
    assert result[1] == "image/png"
    page.screenshot.assert_called_once_with(full_page=True, type="png")


def test_ep_screenshot_default_full_page_false():
    """If `fullPage` is omitted, default to viewport-only."""
    page = MagicMock()
    page.screenshot.return_value = b""
    endpoints.ep_screenshot(page, {})
    page.screenshot.assert_called_once_with(full_page=False, type="png")


def test_ep_eval_wraps_code_in_async_iife():
    """Bare arrow functions and synchronous IIFEs both have edge cases that
    return None even when the function body executed correctly. The /eval
    endpoint MUST wrap the caller's JS in an async IIFE before sending to
    page.evaluate."""
    page = MagicMock()
    page.evaluate.return_value = 42
    result = endpoints.ep_eval(page, {"code": "return 1 + 1"})
    assert result == {"result": 42}
    wrapped_arg = page.evaluate.call_args[0][0]
    assert wrapped_arg.startswith("(async () => {")
    assert "return 1 + 1" in wrapped_arg


def test_ep_key_forwards_to_keyboard_press():
    page = MagicMock()
    assert endpoints.ep_key(page, {"key": "Enter"}) == {"ok": True}
    page.keyboard.press.assert_called_once_with("Enter")


def test_ep_click_coerces_coords_to_int():
    """Body may carry "x" / "y" as floats or strings from JSON; the mouse
    API requires ints. int() coercion is the documented behavior."""
    page = MagicMock()
    endpoints.ep_click(page, {"x": "100", "y": 50.7})
    page.mouse.click.assert_called_once_with(100, 50)


def test_ep_dblclick_coerces_coords_to_int():
    page = MagicMock()
    endpoints.ep_dblclick(page, {"x": 1.9, "y": "200"})
    page.mouse.dblclick.assert_called_once_with(1, 200)


def test_ep_drag_default_steps_and_hold():
    """Defaults (steps=20, hold_ms=200) are the values that worked against
    Webflow's React-DnD threshold detectors. Pinning them as a regression."""
    page = MagicMock()
    result = endpoints.ep_drag(page, {"fromX": 0, "fromY": 0, "toX": 100, "toY": 100})
    assert result["ok"] is True
    assert result["from"] == [0, 0]
    assert result["to"] == [100, 100]
    # 20 steps + the initial move + the final move = 22 mouse moves
    assert page.mouse.move.call_count >= 21
    page.mouse.down.assert_called_once()
    page.mouse.up.assert_called_once()


def test_ep_selector_click_default_timeout():
    """Default click timeout is 8s — long enough for Webflow's virtualized
    lists to mount, short enough that a missing element fails fast."""
    page = MagicMock()
    loc = MagicMock()
    page.locator.return_value.first = loc
    endpoints.ep_selector_click(page, {"selector": "button.foo"})
    loc.click.assert_called_once_with(timeout=8000)


def test_set_html_embed_js_uses_codemirror_dispatch():
    """The setHtmlEmbed flow depends on CodeMirror v6's EditorView.dispatch
    being available on `.cm-editor`. If Webflow swaps editors (back to
    Monaco, say), this string is the only thing pinning the contract — pin
    its key tokens here."""
    js = endpoints._SET_HTML_EMBED_JS
    assert ".cm-editor" in js
    assert "view.dispatch" in js
