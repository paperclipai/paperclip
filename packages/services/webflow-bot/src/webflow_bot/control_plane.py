"""HTTP control plane on port 7000.

`ControlHandler` is the BaseHTTPRequestHandler subclass that the
in-cluster paperclip agents POST to. `ControlServer` is the
single-threaded HTTPServer that hosts it — single-threaded because
Playwright sync_api binds its internal greenlet to the thread that
created the Page (the main thread), so cross-thread access raises
"Cannot switch to a different thread".

Health probes piggyback on `service_actions()` between requests rather
than on a background thread.
"""

from __future__ import annotations

import http.server
import json
import time
import traceback
from typing import Any

from . import designer, endpoints, login, state
from .config import CONTROL_TOKEN, REFRESH_SECONDS


class ControlHandler(http.server.BaseHTTPRequestHandler):
    server_version = "webflow-bot/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress BaseHTTPRequestHandler's default access log spam; the
        # bot's own log() lines are the access log we care about.
        pass

    def _auth_ok(self) -> bool:
        tok = self.headers.get("X-Control-Token", "")
        return bool(CONTROL_TOKEN) and tok == CONTROL_TOKEN

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _send_json(self, code: int, body: Any) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, code: int, content_type: str, data: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            return self._send_json(200, {
                "ok": True,
                "ready": state.status.get("ready", False),
                "phase": state.status.get("phase"),
                "url": (state.page.url if state.page else None),
            })
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._auth_ok():
            return self._send_json(401, {"error": "bad token"})
        try:
            body = self._read_json()
        except Exception as e:
            return self._send_json(400, {"error": "bad json: " + str(e)})
        try:
            with state.page_lock:
                if state.page is None:
                    return self._send_json(503, {"error": "page not ready"})
                handler = endpoints.ROUTES.get(self.path)
                if not handler:
                    return self._send_json(404, {"error": "not found"})
                result = handler(state.page, body)
            if isinstance(result, tuple) and len(result) == 2 and isinstance(result[0], (bytes, bytearray)):
                return self._send_bytes(200, result[1], bytes(result[0]))
            return self._send_json(200, result if isinstance(result, dict) else {"result": result})
        except Exception as e:
            state.log("control plane error on " + self.path + ":", e)
            traceback.print_exc()
            return self._send_json(500, {"error": str(e)})


class ControlServer(http.server.HTTPServer):
    """Single-threaded HTTP server. Calls service_actions() between
    requests; we use that for periodic health probes that need same-thread
    access to the Playwright page."""
    allow_reuse_address = True

    def service_actions(self) -> None:
        now = time.time()
        if now - state.last_health_at >= REFRESH_SECONDS and state.page is not None:
            state.set_last_health_at(now)
            try:
                with state.page_lock:
                    if state.status.get("manual_login_required"):
                        if login.is_logged_in(state.page):
                            state.log("manual login recovered; returning to designer")
                            login.clear_manual_login()
                            designer.open_designer(state.page)
                            designer.try_launch_bridge_app(state.page)
                            state.set_phase("serving")
                        else:
                            state.log("manual login still required")
                            state.set_phase("manual-login-required")
                        return
                    state.set_phase("health-probe")
                    # Fast path: if we're already on Designer with the Bridge
                    # App iframe mounted, skip both the session-cookie
                    # navigation AND the open_designer re-navigation. Both
                    # reset the Designer canvas state, drop Bridge App focus,
                    # and on Camoufox can land on a press-and-hold anti-bot
                    # CAPTCHA that requires manual VNC intervention.
                    if designer.is_on_designer(state.page) and designer.has_bridge_app(state.page):
                        state.log("health: designer + bridge alive; skipping refresh")
                    elif not login.is_logged_in(state.page):
                        state.log("SESSION EXPIRED in health loop")
                        if state.context is not None:
                            login.on_login_required(state.context)
                        designer.open_designer(state.page)
                        designer.try_launch_bridge_app(state.page)
                    else:
                        state.log("session OK; returning to designer")
                        designer.open_designer(state.page)
                        designer.try_launch_bridge_app(state.page)
                    state.set_phase("serving")
            except Exception as e:
                state.log("health loop error:", e)
                traceback.print_exc()
