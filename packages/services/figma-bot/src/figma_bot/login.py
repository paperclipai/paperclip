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


class TransientNetworkError(RuntimeError):
    """Raised when page.goto fails with a known transient network signature.

    These signal infrastructure flaps (tailscale exit-node offline, SOCKS5
    proxy down, DNS hiccup) rather than auth/credentials problems. Callers
    use this to differentiate "bot can't reach figma.com right now"
    (short cooldown, retry soon) from "wrong password / banned identity"
    (escalating 60s → 6h backoff).
    """


# Substrings on the Playwright Error message that mean "the request never
# reached figma's servers" — proxy CONNECTION_REFUSED, exit-node down,
# DNS failure, or socket-level timeout. Not exhaustive; conservative on
# what we classify as transient (false negatives just escalate backoff,
# false positives lock out the bot for less time than they should).
_TRANSIENT_NETWORK_SIGNATURES = (
    "NS_ERROR_CONNECTION_REFUSED",
    "NS_ERROR_PROXY_CONNECTION_REFUSED",
    "NS_ERROR_NET_TIMEOUT",
    "NS_ERROR_NET_RESET",
    "NS_ERROR_NET_INTERRUPT",
    "NS_ERROR_UNKNOWN_PROXY_HOST",
    "NS_ERROR_UNKNOWN_HOST",
    "NS_ERROR_PROXY_BAD_GATEWAY",
    "NS_ERROR_PROXY_GATEWAY_TIMEOUT",
)


def _is_transient_network_error(exc: BaseException) -> bool:
    """True if the Playwright Error message matches a known transient
    network signature (see _TRANSIENT_NETWORK_SIGNATURES)."""
    msg = str(exc)
    return any(sig in msg for sig in _TRANSIENT_NETWORK_SIGNATURES)


def _goto_with_network_retry(
    page: Page,
    url: str,
    *,
    attempts: int = 3,
    wait_between_s: float = 5.0,
    timeout_ms: int = 20_000,
) -> None:
    """page.goto with retry on transient network errors.

    The bot's egress goes through a SOCKS5 proxy (tailscale exit-node).
    When the exit-node briefly drops, the first goto fails immediately
    with NS_ERROR_(PROXY_)CONNECTION_REFUSED but the next attempt 5s
    later usually succeeds — operator's pve-home Tailscale connection
    cycles. Retrying here avoids burning the backoff schedule on a
    blink. After `attempts` exhausted, raises TransientNetworkError
    so the caller can apply a short cooldown instead of the 60→21600s
    auth-backoff schedule.
    """
    last_exc: BaseException | None = None
    for i in range(attempts):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            if i > 0:
                state.log(
                    f"_goto_with_network_retry: succeeded on attempt {i + 1}/{attempts}"
                )
            return
        except Exception as e:
            if not _is_transient_network_error(e):
                raise  # not a transient network error — surface as-is
            last_exc = e
            state.log(
                f"_goto_with_network_retry: attempt {i + 1}/{attempts} "
                f"got transient network error: {str(e)[:200]}"
            )
            if i < attempts - 1:
                time.sleep(wait_between_s)
    # All attempts exhausted; re-raise as TransientNetworkError so the
    # caller can apply a short cooldown instead of escalating backoff.
    raise TransientNetworkError(
        f"page.goto({url!r}) failed {attempts}x with transient network errors; "
        f"last={str(last_exc)[:200]}"
    )


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
        _goto_with_network_retry(page, "https://www.figma.com/login")

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

        # Two independent success signals — accept whichever fires first:
        #   (A) URL navigates away from /login — figma redirected us to
        #       the workspace, definitive proof of auth.
        #   (B) /api/user/profile returns 200 — the cookie's real-world
        #       authority.
        # Live observation 2026-05-25 03:46: (A) actually fires reliably
        # after a successful direct-/login submit (the redirect goes to
        # /files/team/<team_id>/recents-and-sharing?fuid=<user_id>).
        # (B) sometimes returns HTTP 400 transiently right after the
        # session is set — possibly a CSRF / Origin freshness issue —
        # so it's the slower-but-eventually-correct signal.
        deadline = time.time() + 45
        time.sleep(2)  # let figma's server set the cookie + start redirect
        last_reason = ""
        last_url = ""
        while time.time() < deadline:
            try:
                u = page.url
            except Exception as e:
                raise RuntimeError(
                    f"page closed mid-probe: {type(e).__name__}: {str(e)[:120]}"
                ) from e
            last_url = u
            if "://www.figma.com" in u and "/login" not in u:
                state.log(f"auto_login[{pm.identity}]: URL settled at {u}")
                return

            li, reason = is_logged_in(page)
            if li:
                state.log(f"auto_login[{pm.identity}]: probe ok at {u}")
                return
            last_reason = reason

            # Surface visible errors immediately so bad-password attempts
            # don't wait the full timeout.
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
            f"login timeout after 45s; last_probe={last_reason}; last_url={last_url}"
        )
    except RFBConnectFailed:
        raise
    except TransientNetworkError:
        # Already-classified network failure; preserve the type so the
        # main loop's except-chain can apply the short cooldown.
        raise
    except Exception as e:
        # Surface still-transient network errors that surfaced AFTER
        # the initial goto (e.g. on the form-submit redirect) as
        # TransientNetworkError instead of generic RuntimeError, so
        # they also get the short cooldown rather than escalating
        # auth backoff.
        if _is_transient_network_error(e):
            raise TransientNetworkError(
                f"{type(e).__name__}: {str(e)[:200]}",
            ) from e
        raise RuntimeError(f"{type(e).__name__}: {str(e)[:200]}") from e
