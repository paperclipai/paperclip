"""Unit tests for figma_bot.control_plane.

ControlHandler is the HTTP attack surface — every cluster agent's
interaction with the bot goes through this class. Test the auth gate,
JSON body parsing, /health response shape, and that endpoint /lease/*
paths don't require X-Control-Token before they look at the body
(matching the do_GET _auth_ok exception list).
"""

from __future__ import annotations

import io
import json
from unittest import mock
from unittest.mock import MagicMock

from figma_bot import control_plane, state


def _make_handler(headers: dict | None = None, body: bytes = b"") -> control_plane.ControlHandler:
    """Construct a ControlHandler skeleton without invoking __init__.

    BaseHTTPRequestHandler.__init__ wants a real socket. We bypass that
    by instantiating via __new__, then attach just the attributes our
    methods under test read.
    """
    h = control_plane.ControlHandler.__new__(control_plane.ControlHandler)
    h.headers = headers or {}
    h.rfile = io.BytesIO(body)
    h.wfile = io.BytesIO()
    h.send_response = MagicMock()  # type: ignore[method-assign]
    h.send_header = MagicMock()  # type: ignore[method-assign]
    h.end_headers = MagicMock()  # type: ignore[method-assign]
    return h


# ─── _auth_ok ───────────────────────────────────────────────────────────


def test_auth_ok_allows_health_without_token():
    """GET /health is meant for kubectl probes — it MUST be unauth'd so
    livenessProbe/readinessProbe work without secrets."""
    h = _make_handler()
    h.path = "/health"
    assert h._auth_ok() is True


def test_auth_ok_allows_lease_status_without_token():
    """GET /lease/status is the same — observable without auth so
    operators can grep for stuck leases via curl."""
    h = _make_handler()
    h.path = "/lease/status"
    assert h._auth_ok() is True


def test_auth_ok_rejects_other_paths_without_token():
    with mock.patch.object(control_plane, "CONTROL_TOKEN", "secret"):
        h = _make_handler(headers={})
        h.path = "/lease/acquire"
        assert h._auth_ok() is False


def test_auth_ok_rejects_wrong_token():
    with mock.patch.object(control_plane, "CONTROL_TOKEN", "secret"):
        h = _make_handler(headers={"X-Control-Token": "wrong"})
        h.path = "/screenshot"
        assert h._auth_ok() is False


def test_auth_ok_accepts_matching_token():
    with mock.patch.object(control_plane, "CONTROL_TOKEN", "secret"):
        h = _make_handler(headers={"X-Control-Token": "secret"})
        h.path = "/screenshot"
        assert h._auth_ok() is True


# ─── _read_json ─────────────────────────────────────────────────────────


def test_read_json_zero_length_returns_empty():
    h = _make_handler(headers={"Content-Length": "0"}, body=b"")
    assert h._read_json() == {}


def test_read_json_missing_length_returns_empty():
    h = _make_handler(headers={}, body=b"")
    assert h._read_json() == {}


def test_read_json_parses_valid_body():
    body = json.dumps({"client_id": "smoke-1", "ttl": 60}).encode("utf-8")
    h = _make_handler(headers={"Content-Length": str(len(body))}, body=body)
    assert h._read_json() == {"client_id": "smoke-1", "ttl": 60}


def test_read_json_returns_empty_on_invalid_json():
    """control_plane._read_json swallows JSON errors → {} so do_POST can
    400 cleanly on body validation rather than 500 with a trace."""
    body = b"{not valid"
    h = _make_handler(headers={"Content-Length": str(len(body))}, body=body)
    assert h._read_json() == {}


# ─── _send_json / _send_bytes ───────────────────────────────────────────


def test_send_json_writes_serialized_body():
    h = _make_handler()
    h._send_json(200, {"ok": True, "x": 7})
    h.send_response.assert_called_once_with(200)
    call_args = [c.args for c in h.send_header.call_args_list]
    assert ("Content-Type", "application/json") in call_args
    written = h.wfile.getvalue()
    assert json.loads(written) == {"ok": True, "x": 7}
    # Content-Length matches body
    cl = next(v for k, v in call_args if k == "Content-Length")
    assert int(cl) == len(written)


# ─── do_GET /health ─────────────────────────────────────────────────────


def test_health_returns_status_snapshot():
    """/health is what kubectl probes + paperclip agents read."""
    state.status.clear()
    state.status.update({
        "ready": True,
        "phase": "serving",
        "logged_in": True,
        "url": "https://www.figma.com/files/recent",
        "active_identity": "ally@blockcast.net",
    })
    h = _make_handler()
    h.path = "/health"
    h.do_GET()
    body = json.loads(h.wfile.getvalue())
    assert body["ok"] is True
    assert body["ready"] is True
    assert body["phase"] == "serving"
    assert body["logged_in"] is True
    assert body["active_identity"] == "ally@blockcast.net"
    # `email` defaults to active_identity (per source contract)
    assert body["email"] == "ally@blockcast.net"
    # The version key is part of the contract — paperclip agents log it.
    assert body["version"].startswith("figma-bot/")


def test_health_includes_lease_snapshot():
    """/health.lease is the only place callers see the lease state when
    they don't have access to /lease/status (which is also unauth'd, so
    this is more of a convenience surface)."""
    state.lease.update({
        "lease_id": "abc",
        "client_id": "smoke-1",
        "acquired_at": 100.0,
        "last_heartbeat_at": 100.0,
        "ttl_seconds": 60,
    })
    h = _make_handler()
    h.path = "/health"
    h.do_GET()
    body = json.loads(h.wfile.getvalue())
    assert "lease" in body
    assert body["lease"]["lease_id"] == "abc"


def test_get_404_for_unknown_path():
    h = _make_handler()
    h.path = "/nonsense"
    h.do_GET()
    h.send_response.assert_called_once_with(404)


# ─── do_POST /lease/acquire ─────────────────────────────────────────────


def test_lease_acquire_400_when_client_id_missing():
    """Missing client_id is a structural error — fail fast with 400."""
    with mock.patch.object(control_plane, "CONTROL_TOKEN", ""):
        # Stub identities so the assertion at line 175 doesn't fire
        fake_registry = MagicMock()
        fake_registry.default_identity.return_value = "ally@example.com"
        fake_registry.maybe_reload.return_value = None
        state.set_identities(fake_registry)
        body = json.dumps({}).encode("utf-8")
        h = _make_handler(headers={"Content-Length": str(len(body))}, body=body)
        h.path = "/lease/acquire"
        h.do_POST()
        h.send_response.assert_called_once_with(400)


def test_lease_release_400_when_x_lease_id_missing():
    with mock.patch.object(control_plane, "CONTROL_TOKEN", ""):
        h = _make_handler(headers={})
        h.path = "/lease/release"
        h.do_POST()
        h.send_response.assert_called_once_with(400)
