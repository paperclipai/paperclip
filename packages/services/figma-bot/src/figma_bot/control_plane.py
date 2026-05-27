"""HTTP control plane on port 7000.

Threading HTTPServer dispatches each request on a worker thread; Page
operations route through `job_queue` to land on the main thread.
"""

from __future__ import annotations

import base64
import http.server
import json
import os
import socketserver
from typing import Any

from . import job_queue, lease, state
from .config import CONTROL_PORT, CONTROL_TOKEN, DEFAULT_LEASE_TTL, EMAIL, PROFILES_ROOT
from .identity_registry import (
    get_identity_state,
    identity_in_backoff,
    record_login_failure,
    slug_for,
)


def render_identities_map() -> dict:
    """Build the /health.identities map.

    Active identity reads live state; inactive identities derive from
    on-disk cookie size + in-process IdentityState.
    """
    out: dict = {}
    with state.status_lock:
        active = state.status.get("active_identity")
    if state.identities is None:
        return out
    for email in state.identities.known():
        s = get_identity_state(email)
        slug = slug_for(email)
        cookie_path = os.path.join(PROFILES_ROOT, slug, "playwright-profile", "cookies.sqlite")
        try:
            cookie_size = os.path.getsize(cookie_path) if os.path.exists(cookie_path) else 0
        except OSError:
            cookie_size = 0
        out[email] = {
            "logged_in": bool(state.status.get("logged_in", False)) if email == active else False,
            "cookie_size_bytes": cookie_size,
            "last_check_at": state.status.get("last_check_at") if email == active else None,
            "last_login_at": s.last_login_at,
            "last_failure": s.last_failure,
            "backoff_until": s.backoff_until,
        }
    return out


class ControlHandler(http.server.BaseHTTPRequestHandler):
    server_version = "figma-bot/0.2.0"

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _auth_ok(self) -> bool:
        if self.path in ("/health", "/lease/status"):
            return True
        return self.headers.get("X-Control-Token", "") == CONTROL_TOKEN

    def _lease_ok(self) -> bool:
        lid = self.headers.get("X-Lease-Id", "")
        if not lid:
            return False
        return lease.check_lease(lid)

    def _send_json(self, code: int, body: Any) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self) -> None:
        if not self._auth_ok():
            return self._send_json(401, {"error": "unauthorized"})
        if self.path == "/health":
            with state.status_lock:
                snap = dict(state.status)
            return self._send_json(200, {
                "ok": True,
                "ready": snap.get("ready", False),
                "phase": snap.get("phase"),
                "logged_in": snap.get("logged_in", False),
                "url": snap.get("url"),
                "active_identity": snap.get("active_identity"),
                "email": snap.get("active_identity") or EMAIL,
                "session_restored_at": snap.get("session_restored_at"),
                "cookie_count": snap.get("cookie_count"),
                "last_check_at": snap.get("last_check_at"),
                "last_probe_reason": snap.get("last_probe_reason", ""),
                "version": "figma-bot/0.3.0",
                "lease": lease.lease_snapshot(),
                "identities": render_identities_map(),
            })
        if self.path == "/lease/status":
            return self._send_json(200, lease.lease_snapshot())
        if self.path == "/identities":
            return self._send_json(200, {
                "identities": render_identities_map(),
                "default_identity": (
                    state.identities.default_identity() if state.identities else None
                ),
            })
        return self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._auth_ok():
            return self._send_json(401, {"error": "unauthorized"})

        if self.path == "/lease/acquire":
            body = self._read_json()
            client_id = str(body.get("client_id", "")).strip()
            if not client_id:
                return self._send_json(400, {"error": "client_id required"})
            ttl = int(body.get("ttl", DEFAULT_LEASE_TTL))
            ttl = max(10, min(ttl, 3600))
            force_refresh = bool(body.get("force_refresh", False))

            assert state.identities is not None
            state.identities.maybe_reload()
            requested = body.get("identity")
            if requested is None:
                identity = state.identities.default_identity()
                if identity is None:
                    return self._send_json(400, {"error": "no_default_identity"})
            else:
                identity = str(requested).strip()
                if state.identities.get(identity) is None:
                    return self._send_json(400, {
                        "error": "unknown_identity",
                        "known_identities": state.identities.known(),
                    })

            remain = identity_in_backoff(identity)
            if remain is not None:
                return self._send_json(503, {
                    "error": "identity_in_backoff",
                    "retry_after_seconds": int(remain) + 1,
                })

            lid, err = lease.acquire_lease(client_id, ttl)
            if err:
                return self._send_json(409, {
                    "error": err, "lease": lease.lease_snapshot(),
                })

            try:
                switched, login_performed = job_queue.submit_switch_job(identity, force_refresh)
            except job_queue.SwitchJobError as e:
                lease.release_lease(lid)
                # Most failure reasons (login_error, launch_error,
                # rfb_unreachable) were already recorded by the main loop
                # body before it called signal_switch_done. But
                # switch_timeout means the main loop never reached the
                # failure handler — record it here so backoff escalates.
                if e.reason == "switch_timeout":
                    record_login_failure(identity, "switch_timeout")
                ra = identity_in_backoff(identity) or 60
                return self._send_json(503, {
                    "error": "identity_login_failed",
                    "reason": e.reason,
                    "retry_after_seconds": int(ra) + 1,
                })

            return self._send_json(200, {
                "lease_id": lid,
                "identity": identity,
                "ttl_seconds": ttl,
                "switched": switched,
                "login_performed": login_performed,
            })

        if self.path == "/lease/release":
            lid = self.headers.get("X-Lease-Id", "")
            if not lid:
                return self._send_json(400, {"error": "X-Lease-Id required"})
            return self._send_json(200, {"released": lease.release_lease(lid)})

        if self.path == "/lease/heartbeat":
            lid = self.headers.get("X-Lease-Id", "")
            if not lid:
                return self._send_json(400, {"error": "X-Lease-Id required"})
            if not lease.heartbeat_lease(lid):
                return self._send_json(409, {"error": "lease_not_owned_or_expired"})
            return self._send_json(200, {"ok": True})

        if not self._lease_ok():
            return self._send_json(409, {"error": "lease_required"})

        if self.path == "/screenshot":
            try:
                png = job_queue.submit_job(lambda p: p.screenshot(type="png"))
                return self._send_json(200, {
                    "image_base64": base64.b64encode(png).decode("ascii"),
                    "format": "png",
                })
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:200]})

        if self.path == "/eval":
            body = self._read_json()
            expr = body.get("expression")
            if not isinstance(expr, str) or not expr:
                return self._send_json(400, {"error": "expression required"})
            try:
                result = job_queue.submit_job(lambda p: p.evaluate(expr))
                try:
                    json.dumps(result)
                    payload = result
                except (TypeError, ValueError):
                    payload = repr(result)
                return self._send_json(200, {"result": payload})
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:400]})

        if self.path == "/key":
            body = self._read_json()
            key = body.get("key")
            if not isinstance(key, str) or not key:
                return self._send_json(400, {"error": "key required"})
            try:
                job_queue.submit_job(lambda p: p.keyboard.press(key))
                return self._send_json(200, {"ok": True})
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:200]})

        if self.path == "/click":
            body = self._read_json()
            x = body.get("x")
            y = body.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                return self._send_json(400, {"error": "x and y required (numbers)"})
            try:
                job_queue.submit_job(lambda p: p.mouse.click(x, y))
                return self._send_json(200, {"ok": True})
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:200]})

        if self.path == "/selectorClick":
            body = self._read_json()
            sel = body.get("selector")
            if not isinstance(sel, str) or not sel:
                return self._send_json(400, {"error": "selector required"})
            try:
                job_queue.submit_job(lambda p: p.locator(sel).click(timeout=10_000))
                return self._send_json(200, {"ok": True})
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:200]})

        if self.path == "/use_figma":
            # Bridge App proxy lands in M3. Endpoint exists so callers can
            # wire against the API surface; always fails closed until then.
            return self._send_json(503, {
                "error": "bridge_not_connected",
                "detail": "Bridge App proxy not yet implemented; see BLO-6355 M3.",
            })

        return self._send_json(404, {"error": "not found"})


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run_control_server() -> None:
    srv = ThreadingHTTPServer(("0.0.0.0", CONTROL_PORT), ControlHandler)
    state.log("control plane listening on :" + str(CONTROL_PORT) + " (threading)")
    srv.serve_forever()
