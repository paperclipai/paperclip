"""Figma session probing + Google-SSO auto-login.

`is_logged_in` is the cheap probe (in-page fetch to
/api/user/profile). `auto_login` drives the full SSO flow when the probe
returns 401, using `rfb.rfb_click` to bypass Camoufox's
isTrusted=false trap on React-protected buttons.
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
    """Drive Google SSO for pm.identity using stored credentials.

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
    page = pm.page

    def _refetch_page_after_target_closed():
        nonlocal page
        try:
            pages = pm._context.pages
            page = pages[0] if pages else pm._context.new_page()
            pm.page = page
            state.log(
                f"auto_login[{pm.identity}]: re-acquired page after TargetClosedError"
            )
        except Exception as e:
            raise RuntimeError(f"page re-acquire failed: {type(e).__name__}: {e}") from e

    state.log(f"auto_login[{pm.identity}]: starting")
    try:
        page.goto("https://www.figma.com/login", wait_until="domcontentloaded", timeout=20_000)

        loc = page.locator('button:has-text("Continue with Google")')
        loc.wait_for(state="visible", timeout=10_000)
        bbox = loc.bounding_box()
        if not bbox:
            raise RuntimeError("Continue with Google button has no bbox")
        # Empirical default: 1:1 mapping at offset (0,0) within Xvfb.
        cx = int(round(bbox["x"] + bbox["width"] / 2))
        cy = int(round(bbox["y"] + bbox["height"] / 2))
        state.log(f"auto_login[{pm.identity}]: RFB-click at xvfb=({cx},{cy})")
        rfb_click(cx, cy)

        page.wait_for_load_state("domcontentloaded", timeout=20_000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible", timeout=20_000)
        except PWTimeout:
            raise RuntimeError("email input did not appear within 20s") from None
        page.evaluate(
            "(email)=>{const em=document.querySelector('input[type=\"email\"]');"
            "const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
            "s.call(em,email);"
            "em.dispatchEvent(new Event('input',{bubbles:true}));"
            "em.dispatchEvent(new Event('change',{bubbles:true}));}",
            pm.identity,
        )
        page.evaluate("document.getElementById('identifierNext').click()")

        try:
            page.wait_for_selector('input[type="password"]', state="visible", timeout=30_000)
        except PWTimeout:
            raise RuntimeError(
                "password input did not appear within 30s (google challenge?)"
            ) from None
        page.evaluate(
            "(pw)=>{const pe=document.querySelector('input[type=\"password\"]');"
            "const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
            "s.call(pe,pw);"
            "pe.dispatchEvent(new Event('input',{bubbles:true}));"
            "pe.dispatchEvent(new Event('change',{bubbles:true}));}",
            password,
        )
        page.evaluate("document.getElementById('passwordNext').click()")

        deadline = time.time() + 30
        last_url = None
        while time.time() < deadline:
            try:
                u = page.url
            except Exception:
                _refetch_page_after_target_closed()
                continue
            last_url = u
            if "://www.figma.com" in u and "/login" not in u:
                break
            time.sleep(0.5)
        else:
            if last_url and "challenge" in last_url:
                raise RuntimeError(f"google_challenge_in_url:{last_url[:120]}")
            raise RuntimeError(f"login redirect timeout; last_url={last_url}")
        state.log(f"auto_login[{pm.identity}]: redirect settled at {page.url}")
    except RFBConnectFailed:
        raise
    except Exception as e:
        raise RuntimeError(f"{type(e).__name__}: {str(e)[:200]}") from e
