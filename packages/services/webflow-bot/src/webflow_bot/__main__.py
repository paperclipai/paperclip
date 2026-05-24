#!/usr/bin/env python3
"""
Webflow Designer bot — long-lived Camoufox session that holds an
authenticated Webflow Designer with the "Webflow MCP Bridge App"
launched, exposing an HTTP control plane on port 7000 for cluster agents
to drive Designer ops.

Replaces the previous Node+Chromium implementation. Chromium got
PX-challenged on every navigation of webflow.com / *.design.webflow.com
routes even with valid session cookies. Camoufox's binary-level
fingerprint randomization passes PX both on initial login and on sustained
browsing — verified 2026-05-07: 3+ minute idle on the Designer URL
without a challenge or redirect.

HTTP endpoints (auth: X-Control-Token header)
    GET  /health                      liveness + current page url
    POST /screenshot { fullPage? }    returns image/png
    POST /eval { code }               page.evaluate wrap; returns JSON
    POST /key { key }                 page.keyboard.press(key)
    POST /click { x, y }              page.mouse.click(x, y)
    POST /selectorClick { selector }  page.locator(selector).first.click()
    POST /setHtmlEmbed { elementId,   open Edit Code modal, replace via
                         html,         CodeMirror v6 EditorView.dispatch,
                         publish? }    save, optional publish
    POST /createPage { name, slug }   drive Pages-panel + new-page modal
"""

from __future__ import annotations

import os
import sys
import time
import traceback

from camoufox.sync_api import Camoufox

from . import designer, login, state
from .config import (
    CONTROL_PORT,
    PROFILE_DIR,
    PROXY_URL,
    STATE_FILE,
    assert_credentials_present,
)
from .control_plane import ControlHandler, ControlServer


def main() -> int:
    """Boot the bot: launch Camoufox, restore session, open Designer, serve."""
    assert_credentials_present()
    os.makedirs(PROFILE_DIR, exist_ok=True)

    state.set_phase("launching-camoufox")
    # headless=False routes the browser to the existing Xvfb on
    # DISPLAY=:99 (where x11vnc is watching for VNC sessions). Camoufox's
    # "virtual" mode spawns its OWN Xvfb at :103 with a 1x1 screen — fine
    # for stealth automation, but invisible over VNC. Setting CAMOUFOX_VNC=1
    # in env opts in to the vnc-friendly path; default stays "virtual" for
    # production.
    cm_kwargs: dict = {
        "headless": False if os.environ.get("CAMOUFOX_VNC") == "1" else "virtual"
    }
    if PROXY_URL:
        cm_kwargs["proxy"] = {"server": PROXY_URL}
        state.log("camoufox routing via proxy " + PROXY_URL)
    if os.path.exists(STATE_FILE):
        state.log("camoufox -> reusing storage_state from " + STATE_FILE)

    with Camoufox(**cm_kwargs) as browser:
        ctx_kwargs: dict = {}
        if os.path.exists(STATE_FILE):
            ctx_kwargs["storage_state"] = STATE_FILE
        ctx = browser.new_context(**ctx_kwargs)
        page = ctx.new_page()
        state.set_context(ctx)
        state.set_page(page)

        state.set_phase("session-probe")
        if not login.is_logged_in(page):
            state.log("SESSION EXPIRED on cold start — running login")
            try:
                login.on_login_required(ctx)
            except Exception as e:
                state.log("automatic login failed:", e)
                traceback.print_exc()
                login.park_for_manual_login(page, e)

        if not state.status.get("manual_login_required"):
            state.set_phase("opening-designer")
            designer.open_designer(page)
            designer.try_launch_bridge_app(page)

        state.set_last_health_at(time.time())
        state.status["ready"] = True
        if not state.status.get("manual_login_required"):
            state.set_phase("serving")

        server = ControlServer(("0.0.0.0", CONTROL_PORT), ControlHandler)
        state.log("control plane listening on :" + str(CONTROL_PORT))
        # poll_interval=5 so service_actions (health probe) gets called
        # at least every 5s even when no requests are arriving.
        server.serve_forever(poll_interval=5.0)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
