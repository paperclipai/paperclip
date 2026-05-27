"""Webflow Designer canvas + Bridge App launch helpers.

The Designer is the cluster agent's actual target: a React canvas served
from webflow.com/design/<slug> (or its <slug>.design.webflow.com legacy
redirect). The "Webflow MCP Bridge App" is an iframe that mounts inside
the Designer chrome; it's the live MCP target our control plane indirectly
drives via use_figma-style page.evaluate calls.

The functions here are written specifically against the DOM
shape verified 2026-05-07/08 on lisa-blockcast.design.webflow.com.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from . import state
from .config import SITE_URL

if TYPE_CHECKING:
    # Playwright imported only for type hints — keeps designer importable
    # in unit-test CI that skips the Docker layer.
    from playwright.sync_api import Page


def is_on_designer(page: Page) -> bool:
    """Are we on the Designer canvas right now?

    Designer canvas is reachable via two URL forms:
      - https://webflow.com/design/<slug>?...  (modern, used by SITE_URL)
      - https://<slug>.design.webflow.com/?... (legacy; what /design/<slug> redirects to)
    Either form, with the left-sidebar Pages button present in the DOM,
    means we're inside the Designer chrome (not the dashboard, not a
    CAPTCHA, not the live preview).
    """
    try:
        url = page.url or ""
        on_designer_url = ("/design/" in url) or (".design.webflow.com" in url)
        if not on_designer_url:
            return False
        return bool(page.evaluate(
            "(() => !!document.querySelector('[data-automation-id=\"left-sidebar-pages-button\"]'))()"
        ))
    except Exception:
        return False


def has_bridge_app(page: Page) -> bool:
    """Is the Bridge App iframe mounted?

    The Bridge App lives in an iframe served from a webflow-ext.com
    subdomain. Its presence in the DOM is a sufficient signal that
    mcp__webflow__de_page_tool will reach a live MCP target.
    """
    try:
        return bool(page.evaluate(
            "(() => !!document.querySelector('iframe[src*=\"webflow-ext\"]'))()"
        ))
    except Exception:
        return False


def open_designer(page: Page) -> None:
    """Navigate to the Designer canvas (idempotent).

    If we're already on Designer with Bridge alive, skip the navigation.
    Re-issuing `page.goto` closes the Bridge App popup, drops the canvas
    focus, and on Camoufox can land on a press-and-hold anti-bot CAPTCHA
    that requires manual intervention to clear (verified 2026-05-08,
    BLO-3979 thread).
    """
    if is_on_designer(page):
        if has_bridge_app(page):
            state.log("designer + bridge already alive — skipping nav (url=" + (page.url or "") + ")")
            return
        state.log("on designer but bridge missing — re-launching bridge without nav")
        try_launch_bridge_app(page)
        return
    state.log("opening designer at " + SITE_URL)
    try:
        page.goto(SITE_URL, wait_until="domcontentloaded", timeout=90_000)
    except Exception as e:
        # Camoufox sometimes returns NS_BINDING_ABORTED on Webflow's
        # /design/<slug> → <slug>.design.webflow.com redirect chain.
        # If the navigation aborted but we ended up on Designer anyway,
        # treat as success — the Designer canvas DOM is what matters,
        # not whether goto returned cleanly.
        state.log(
            "designer goto raised " + type(e).__name__
            + " (" + str(e)[:80] + "); checking final state"
        )
    # Wait for Designer chrome to finish booting. The React app mounts
    # left-sidebar-pages-button shortly after domcontentloaded, but the
    # timing varies (3-15s observed). Polling the selector beats a fixed
    # wait_for_timeout.
    try:
        page.wait_for_selector(
            '[data-automation-id="left-sidebar-pages-button"]',
            timeout=20_000,
            state="attached",
        )
    except Exception as e:
        state.log("designer chrome did not mount within 20s: " + type(e).__name__)
    page.wait_for_timeout(1_000)
    state.log("designer url=" + page.url + " title=" + (page.title() or ""))


def try_launch_bridge_app(page: Page) -> None:
    """Open the Webflow MCP Bridge App from the Apps panel.

    Five-step sequence verified 2026-05-08:
      1. Focus the canvas — Webflow's keyboard shortcuts only register
         when the canvas iframe (not the body) has focus.
      2. Press 'E' — Apps panel hotkey (aria-label is "Apps (E)").
      3. Click the Bridge App row at the center of its container (NOT the
         leaf text SPAN — that has no click handler). JS walks up the DOM
         to find the row container ≥150px wide and clicks at its centroid.
      4. Wait for any visible button matching ^Launch( App)?$ and JS-click
         it. The button text varies by Apps-panel state.
      5. Poll for the webflow-ext iframe to mount.

    Two failure modes that this addresses:
      (a) Playwright's :text-matches() selector misses the button
          intermittently when Webflow's virtualized list mounts the row
          late — JS .find() against a fresh DOM snapshot avoids the
          selector-engine timing issue.
      (b) Clicking the leaf text span does nothing (no bubbling click
          handler) — walking up to the row container is what actually
          opens the detail panel.
    """
    try:
        if not is_on_designer(page):
            state.log("bridge launch skipped: not on Designer (url=" + (page.url or "") + ")")
            return
        if has_bridge_app(page):
            state.log("bridge launch skipped: webflow-ext iframe already mounted")
            return
        # 1. canvas focus
        page.mouse.click(700, 400)
        page.wait_for_timeout(400)
        # 2. open Apps panel via the 'E' shortcut.
        page.keyboard.press("e")
        page.wait_for_timeout(800)
        # 3. Find the Bridge App row in the Apps panel and click on its
        #    center coords (NOT the text span — that has no click handler).
        try:
            row_info = page.evaluate(
                """
                () => {
                  const span = Array.from(document.querySelectorAll("span"))
                    .find(s => (s.textContent || "").trim() === "Webflow MCP Bridge App"
                               && s.children.length === 0);
                  if (!span) return null;
                  let row = span;
                  for (let i = 0; i < 6 && row.parentElement; i++) {
                    const p = row.parentElement;
                    const r = p.getBoundingClientRect();
                    if (r.width >= 150) { row = p; break; }
                    row = p;
                  }
                  const r = row.getBoundingClientRect();
                  return {
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2),
                    width: r.width, height: r.height,
                  };
                }
                """
            )
        except Exception as e:
            state.log("bridge launch row-locate err: " + str(e)[:140])
            row_info = None
        if not row_info:
            state.log("bridge launch failed: Bridge App row not found in Apps panel")
            return
        state.log(
            "bridge launch: clicking row at ("
            + str(row_info["x"]) + "," + str(row_info["y"]) + ")"
        )
        page.mouse.click(row_info["x"], row_info["y"])
        page.wait_for_timeout(800)
        # 4. Detail panel mounts with the "Launch App" button. Poll via JS
        #    for any visible button matching ^Launch( App)?$.
        launch_clicked = False
        for _ in range(40):  # up to ~20s
            try:
                found = page.evaluate(
                    """
                    () => {
                      const b = Array.from(document.querySelectorAll("button"))
                        .find(b => /^Launch( App)?$/.test((b.textContent || "").trim())
                                   && b.offsetParent !== null);
                      if (!b) return null;
                      b.click();
                      return { text: b.textContent.trim() };
                    }
                    """
                )
            except Exception as e:
                state.log("bridge launch eval err: " + str(e)[:120])
                found = None
            if found:
                state.log("bridge launch: clicked '" + str(found.get("text", "")) + "'")
                launch_clicked = True
                break
            page.wait_for_timeout(500)
        if not launch_clicked:
            state.log("bridge launch failed: 'Launch' button never appeared after row click")
            return
        # 5. iframe handshakes with the Bridge App's external host
        #    (webflow-ext.com). Poll for mount; 10s is usually enough but
        #    slow runs occasionally need 15s.
        for _ in range(30):  # ~15s budget
            page.wait_for_timeout(500)
            if has_bridge_app(page):
                state.log("bridge launched: webflow-ext iframe mounted")
                return
        state.log(
            "bridge launch click sent but iframe not mounted within 15s; "
            "possibly slow load or App not enabled in workspace"
        )
    except Exception as e:
        state.log("bridge launch raised " + type(e).__name__ + ": " + str(e)[:160])
