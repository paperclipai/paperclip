"""Regression gates for is_logged_in's session probe.

As of 2026-05-31 Figma's /api/user/profile returns HTTP 400 to a bare
same-origin fetch ("'user_id' must be a valid number, received type String")
regardless of session validity. The old probe treated any non-200/401 as
logged-out, so the periodic refresh_status() heartbeat flipped logged_in->False
~30s after every successful login and the bot was stuck at ready:false for
hours despite a live session.

is_logged_in now trusts Figma's auth routing (on a www.figma.com app page and
not /login => logged in), using the API only as a positive corroboration when
off a recognizable Figma page.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from figma_bot.login import is_logged_in


def _page(url: str, status: int | None = None) -> MagicMock:
    page = MagicMock()
    page.url = url
    if status is None:
        # Calling the API probe in this state is a bug — make it explode so a
        # regression that re-introduces the API dependency on workspace/login
        # pages is caught loudly.
        page.evaluate.side_effect = AssertionError("API probe must not run when URL is conclusive")
    else:
        page.evaluate.return_value = {"status": status}
    return page


def test_workspace_url_is_logged_in_even_when_api_would_400():
    # The exact stuck-bot condition: on the logged-in workspace, API probe 400s.
    page = _page("https://www.figma.com/files/team/1304003749274250619/recents-and-sharing?fuid=999")
    assert is_logged_in(page) == (True, "")
    page.evaluate.assert_not_called()  # URL was conclusive; no broken API call


def test_design_file_url_is_logged_in():
    page = _page("https://www.figma.com/design/abc123/Some-File?node-id=1-2")
    assert is_logged_in(page) == (True, "")


def test_login_page_is_logged_out():
    page = _page("https://www.figma.com/login")
    assert is_logged_in(page) == (False, "on_login_page")


def test_off_figma_falls_back_to_api_200():
    page = _page("about:blank", status=200)
    assert is_logged_in(page) == (True, "")


def test_off_figma_api_401_is_missing_auth():
    page = _page("about:blank", status=401)
    assert is_logged_in(page) == (False, "missing_authentication")


def test_off_figma_api_400_is_not_logged_in():
    page = _page("about:blank", status=400)
    assert is_logged_in(page) == (False, "off_figma_http_400")


def test_page_url_access_failure_is_probe_error():
    page = MagicMock()
    type(page).url = property(lambda self: (_ for _ in ()).throw(RuntimeError("page closed")))
    li, reason = is_logged_in(page)
    assert li is False
    assert reason.startswith("probe_error:")
