"""Figma session probing + direct email/password auto-login.

`is_logged_in` is the cheap probe (in-page fetch to
/api/user/profile). `auto_login` drives Figma's native email/password
form (NOT Google SSO) when the probe returns 401, using `rfb.rfb_click`
with a chrome offset to bypass Camoufox's isTrusted=false trap on the
React-protected "Log in" button.

Why not Google SSO: when the identity is in the ccrotate pool (e.g.
ally@blockcast.net), Codex device-auth churn keeps rotating Google's
session server-side, invalidating any figma.session we obtain via the
OAuth chain (see `figma_bot_ccrotate_workspace_sso_invalidation.md`).
Figma's native password login lives entirely server-side at figma.com
and is immune to Google session rotation. Identities.json must hold
a real figma password (not Google's) for this to work.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from . import state
from .rfb import RFBConnectFailed, rfb_click

if TYPE_CHECKING:
    from playwright.sync_api import Page

    from .profile_manager import ProfileManager


def figma_cookie_count(page: Page) -> int:
    try:
        return len(page.context.cookies("https://www.figma.com"))
    except Exception as e:
        state.log("cookie count probe failed: " + type(e).__name__ + ": " + str(e)[:120])
        return -1


def is_logged_in(page: Page) -> tuple[bool, str]:
    """Probe Figma session validity via in-page fetch to /api/user/profile.

    Returns (logged_in, reason). reason is '' on success; on failure one
    of: 'missing_authentication' (401), 'http_<status>', 'probe_error:<Exc>'.
    """
    try:
        result = page.evaluate(
            "(async()=>{const r=await fetch('https://www.figma.com/api/user/profile',"
            "{credentials:'include',headers:{accept:'application/json'}});"
            "return {status:r.status};})()"
        )
        status = int(result.get("status", 0))
        if status == 200:
            return True, ""
        if status == 401:
            return False, "missing_authentication"
        return False, f"http_{status}"
    except Exception as e:
        return False, f"probe_error:{type(e).__name__}"


def refresh_status(page: Page) -> bool:
    li, reason = is_logged_in(page)
    try:
        u = page.url
    except Exception:
        u = None
    with state.status_lock:
        state.status["logged_in"] = li
        state.status["url"] = u
        state.status["last_check_at"] = time.time()
        state.status["last_probe_reason"] = reason
    return li


def auto_login(pm: ProfileManager) -> None:
    """Drive Figma's native email/password form for pm.identity.

    Single attempt; raises on failure (caller catches + records reason).
    Lazy-imports PWTimeout so this module is importable without playwright.
    """
    from playwright.sync_api import TimeoutError as PWTimeout  # noqa: PLC0415

    if state.identities is None:
        raise RuntimeError("IdentityRegistry not initialized")
    entry = state.identities.get(pm.identity)
    if entry is None:
        raise RuntimeError(f"identity {pm.identity} not in registry")
    password = entry.get("password")
    if not password:
        raise RuntimeError(f"identity {pm.identity} has no password")
    if password.startswith("PLACEHOLDER"):
        raise RuntimeError(
            f"identity {pm.identity} password is still the placeholder; "
            f"update paperclip-figma-bot-identities Secret with the real figma password"
        )
    page = pm.page

    state.log(f"auto_login[{pm.identity}]: starting (figma email+password)")
    try:
        page.goto("https://www.figma.com/login", wait_until="domcontentloaded", timeout=20_000)

        # Wait for figma's own email + password form to be ready.
        try:
            page.wait_for_selector('input[type="email"]', state="visible", timeout=20_000)
        except PWTimeout:
            raise RuntimeError("email input did not appear within 20s") from None
        try:
            page.wait_for_selector('input[type="password"]', state="visible", timeout=5_000)
        except PWTimeout:
            raise RuntimeError("password input did not appear within 5s") from None

        # React-protected inputs: writing .value directly is silently
        # ignored. The HTMLInputElement.prototype .value setter + input
        # event is the standard React-bypass pattern.
        page.evaluate(
            "([email, pw]) => {"
            "  const setter = Object.getOwnPropertyDescriptor("
            "    window.HTMLInputElement.prototype, 'value').set;"
            "  const em = document.querySelector('input[type=\"email\"]');"
            "  const pe = document.querySelector('input[type=\"password\"]');"
            "  setter.call(em, email);"
            "  em.dispatchEvent(new Event('input', {bubbles: true}));"
            "  em.dispatchEvent(new Event('change', {bubbles: true}));"
            "  setter.call(pe, pw);"
            "  pe.dispatchEvent(new Event('input', {bubbles: true}));"
            "  pe.dispatchEvent(new Event('change', {bubbles: true}));"
            "}",
            [pm.identity, password],
        )

        # Click the "Log in" button via RFB pointer injection — same
        # isTrusted=false trap as the prior Google-SSO path. bbox is
        # viewport-relative CSS pixels; RFB pointer events are absolute
        # Xvfb screen coordinates. Camoufox renders with browser chrome
        # (~86 px URL+tab bar) on top, so we add mozInnerScreen{X,Y} to
        # translate. See memory `camoufox_istrusted_false_rfb_workaround.md`.
        login_btn = page.locator('button:has-text("Log in")')
        try:
            login_btn.wait_for(state="visible", timeout=5_000)
        except PWTimeout:
            raise RuntimeError("Log in button did not appear within 5s") from None
        bbox = login_btn.bounding_box()
        if not bbox:
            raise RuntimeError("Log in button has no bbox")
        screen_x = page.evaluate("() => window.mozInnerScreenX") or 0
        screen_y = page.evaluate("() => window.mozInnerScreenY") or 0
        cx = int(round(bbox["x"] + bbox["width"] / 2 + screen_x))
        cy = int(round(bbox["y"] + bbox["height"] / 2 + screen_y))
        state.log(
            f"auto_login[{pm.identity}]: RFB-click 'Log in' at xvfb=({cx},{cy}) "
            f"bbox=({bbox['x']:.0f},{bbox['y']:.0f}) "
            f"chrome_offset=({screen_x},{screen_y})"
        )
        rfb_click(cx, cy)

        # Probe figma.session validity directly instead of waiting for
        # a URL redirect. Live observation 2026-05-25 03:27 showed
        # figma sets the session cookie successfully (visible toast
        # "Authenticated as ...") but does NOT redirect when /login
        # is loaded directly (no deep-link to bounce back to). The
        # `is_logged_in` probe hits /api/user/profile which is the
        # cookie's real-world authority — if 200, we're in.
        deadline = time.time() + 45
        time.sleep(2)  # let figma's server set the cookie
        last_reason = ""
        while time.time() < deadline:
            li, reason = is_logged_in(page)
            if li:
                state.log(f"auto_login[{pm.identity}]: probe ok at {page.url}")
                return
            last_reason = reason
            # Also surface any visible error message that would tell us
            # this is a bad-password situation (no point waiting further).
            try:
                err = page.evaluate(
                    "() => { const e = document.querySelector('[class*=\"error\"]'); "
                    "return e ? (e.innerText || '').slice(0, 200) : ''; }"
                ) or ""
            except Exception:
                err = ""
            if err:
                raise RuntimeError(f"figma_login_error:{err[:200]}")
            time.sleep(2)
        raise RuntimeError(
            f"login probe timeout after 45s; last_probe={last_reason}; "
            f"last_url={page.url}"
        )
    except RFBConnectFailed:
        raise
    except Exception as e:
        raise RuntimeError(f"{type(e).__name__}: {str(e)[:200]}") from e
