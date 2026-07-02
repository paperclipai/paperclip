"""Unit tests for login.py recovery helpers."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from webflow_bot import login


def test_goto_login_retries_with_commit_after_timeout(monkeypatch: pytest.MonkeyPatch):
    page = MagicMock()
    timeout = RuntimeError("navigation timed out")
    page.goto.side_effect = [timeout, None]
    monkeypatch.setattr(login, "_is_playwright_timeout", lambda exc: exc is timeout)

    login._goto_login_page(page)

    assert page.goto.call_args_list[0].kwargs == {
        "wait_until": "domcontentloaded",
        "timeout": 60_000,
    }
    assert page.goto.call_args_list[1].kwargs == {
        "wait_until": "commit",
        "timeout": 30_000,
    }
    page.wait_for_timeout.assert_called_once_with(3_000)


def test_goto_login_reraises_non_timeout():
    page = MagicMock()
    page.goto.side_effect = RuntimeError("network failed")

    with pytest.raises(RuntimeError, match="network failed"):
        login._goto_login_page(page)


def test_click_locator_uses_dom_click_before_enter():
    page = MagicMock()
    locator = MagicMock()
    locator.click.side_effect = RuntimeError("click intercepted")

    login._click_locator_with_fallback(page, locator, "submit")

    locator.evaluate.assert_called_once_with("el => el.click()", timeout=10_000)
    page.keyboard.press.assert_not_called()


def test_click_locator_falls_back_to_enter_after_click_failures():
    page = MagicMock()
    locator = MagicMock()
    locator.click.side_effect = RuntimeError("click intercepted")
    locator.evaluate.side_effect = RuntimeError("detached")

    login._click_locator_with_fallback(page, locator, "submit")

    page.keyboard.press.assert_called_once_with("Enter")
