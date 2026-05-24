"""Google-SSO-based login to webflow.com.

`do_login` drives the email → continue → password → submit flow. The bot
goes through this only when `is_logged_in` says the session expired —
typically a 30-day cycle, occasionally faster if Webflow invalidates the
session server-side (which happened repeatedly with Google Workspace
SSO churn — see memory: figma_bot_ccrotate_workspace_sso_invalidation).
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from . import state
from .config import DASHBOARD_URL, EMAIL, PASSWORD, STATE_FILE

if TYPE_CHECKING:
    # Type-only imports keep login.py importable without playwright. The
    # `PWTimeout` exception class is used in an `except` block at runtime
    # below — that's lazy-imported inside `is_logged_in` so module-level
    # import still succeeds without playwright present.
    from playwright.sync_api import BrowserContext, Page


def do_login(context: BrowserContext) -> None:
    page = context.new_page()
    try:
        state.log("login -> goto webflow.com/login")
        page.goto("https://webflow.com/login", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(3_000)
        title_lc = (page.title() or "").lower()
        if "denied" in title_lc:
            raise RuntimeError("PX-blocked even on Camoufox login (title=" + title_lc + ")")
        email_input = page.locator('input[name="email"], input[type="email"]').first
        state.log("login -> filling email")
        email_input.press_sequentially(EMAIL, delay=30)
        pw_input = page.locator('input[name="password"], input[type="password"]').first
        if pw_input.count() == 0 or not pw_input.is_visible(timeout=1_000):
            state.log("login -> password field not visible, clicking Continue to advance")
            cont = page.get_by_role("button", name="Continue", exact=True).first
            if cont.count() == 0:
                cont = page.locator('button:has-text("Continue"):not(:has-text("SSO"))').first
            cont.click(timeout=5_000)
            page.wait_for_timeout(2_000)
            pw_input = page.locator('input[name="password"], input[type="password"]').first
            pw_input.wait_for(state="visible", timeout=15_000)
        state.log("login -> filling password")
        pw_input.press_sequentially(PASSWORD, delay=30)
        state.log("login -> submitting (click primary Continue)")
        submit = page.get_by_role("button", name="Continue", exact=True).first
        if submit.count() == 0:
            submit = page.locator('button[type="submit"]').first
        try:
            submit.click(timeout=5_000)
        except Exception as exc:
            state.log(f"login -> click submit failed ({exc}); falling back to Enter")
            page.keyboard.press("Enter")
        deadline = time.time() + 60
        while time.time() < deadline and "/login" in page.url:
            page.wait_for_timeout(500)
        if "/login" in page.url:
            body = page.evaluate(
                "(() => document.body ? document.body.innerText.slice(0, 600) : '')()"
            ) or ""
            raise RuntimeError("login form did not redirect — body=" + body[:400])
        state.log("login -> redirected to " + page.url)
    finally:
        page.close()


def on_login_required(context: BrowserContext) -> None:
    state.set_phase("login")
    do_login(context)
    try:
        context.storage_state(path=STATE_FILE)
        state.log("login -> storage_state saved to " + STATE_FILE)
    except Exception as e:
        state.log("login -> WARN: could not save storage_state:", e)


def park_for_manual_login(page: Page, reason: Exception | str) -> None:
    state.status["manual_login_required"] = True
    state.status["manual_login_reason"] = str(reason)[:500]
    state.set_phase("manual-login-required")
    state.log("manual login required; keeping VNC/control alive:", reason)
    try:
        if "/login" not in (page.url or ""):
            page.goto("https://webflow.com/login", wait_until="commit", timeout=5_000)
    except Exception as e:
        state.log("manual login: could not park browser on login page:", e)


def clear_manual_login() -> None:
    state.status.pop("manual_login_required", None)
    state.status.pop("manual_login_reason", None)


def is_logged_in(page: Page) -> bool:
    """Probe for a valid wfsession cookie + reachable /dashboard.

    URL-based checks alone are unreliable: Webflow's /dashboard doesn't
    bounce anonymous Camoufox requests to /login (Camoufox doesn't trip PX
    so doesn't get the auth-gate redirect either way).
    """
    try:
        cookies = page.context.cookies("https://webflow.com")
        wf = next((c for c in cookies if c.get("name") == "wfsession"), None)
        if wf is None:
            return False
        exp = wf.get("expires", -1)
        if isinstance(exp, (int, float)) and 0 < exp < time.time():
            # wfsession with a sub-now expiry = explicitly cleared by Webflow
            return False
    except Exception as e:
        state.log("session probe: cookie inspect failed:", e)
        # fall through to URL-based check
    # Lazy-import PWTimeout so login.py is importable without playwright
    # installed (unit-test CI gate).
    from playwright.sync_api import TimeoutError as PWTimeout  # noqa: PLC0415

    try:
        page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(2_500)
    except PWTimeout:
        state.log("session probe: page.goto timeout (treating as logged out)")
        return False
    url = page.url
    if "/login" in url or "/auth/" in url:
        return False
    title_lc = (page.title() or "").lower()
    if "denied" in title_lc:
        return False
    return True
