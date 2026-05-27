"""Unit tests for control_plane.py.

ControlHandler is a BaseHTTPRequestHandler subclass — constructing a real
one requires a socket. Instead we build a Mock-shaped instance that has
just enough of the BaseHTTPRequestHandler surface for the methods under
test to run.

The tests focus on the security-critical auth gate, the JSON body parsing
edge cases, and the /health response shape — surfaces that the original
ConfigMap-embedded script could only test by actually deploying it.
"""

from __future__ import annotations

import io
import json
from unittest import mock
from unittest.mock import MagicMock

import pytest

from webflow_bot import control_plane, state


def _make_handler(headers: dict | None = None, body: bytes = b"") -> control_plane.ControlHandler:
    """Construct a ControlHandler skeleton without invoking __init__.

    BaseHTTPRequestHandler.__init__ wants a real socket. We bypass that by
    instantiating via __new__, then attach just the attributes our methods
    under test read.
    """
    h = control_plane.ControlHandler.__new__(control_plane.ControlHandler)
    h.headers = headers or {}
    h.rfile = io.BytesIO(body)
    h.wfile = io.BytesIO()
    # send_response / send_header / end_headers are stub-able as MagicMocks
    # — the tests assert on _send_json / _send_bytes side effects via wfile.
    h.send_response = MagicMock()  # type: ignore[method-assign]
    h.send_header = MagicMock()  # type: ignore[method-assign]
    h.end_headers = MagicMock()  # type: ignore[method-assign]
    return h


# ─── _auth_ok ───────────────────────────────────────────────────────────


def test_auth_ok_rejects_when_control_token_unset():
    """Empty CONTROL_TOKEN must NOT be treated as a valid match for an
    empty X-Control-Token header — silent unauth would let any caller
    drive the bot if the secret were ever empty by accident."""
    with mock.patch.object(control_plane, "CONTROL_TOKEN", ""):
        h = _make_handler(headers={"X-Control-Token": ""})
        assert h._auth_ok() is False


def test_auth_ok_rejects_mismatched_token():
    with mock.patch.object(control_plane, "CONTROL_TOKEN", "secret-abc"):
        h = _make_handler(headers={"X-Control-Token": "wrong"})
        assert h._auth_ok() is False


def test_auth_ok_rejects_missing_header():
    with mock.patch.object(control_plane, "CONTROL_TOKEN", "secret-abc"):
        h = _make_handler(headers={})
        assert h._auth_ok() is False


def test_auth_ok_accepts_matching_token():
    with mock.patch.object(control_plane, "CONTROL_TOKEN", "secret-abc"):
        h = _make_handler(headers={"X-Control-Token": "secret-abc"})
        assert h._auth_ok() is True


# ─── _read_json ─────────────────────────────────────────────────────────


def test_read_json_returns_empty_dict_on_zero_length():
    h = _make_handler(headers={"Content-Length": "0"}, body=b"")
    assert h._read_json() == {}


def test_read_json_returns_empty_dict_on_missing_length():
    """Some clients omit Content-Length entirely; we shouldn't 500 on them
    when the body is empty anyway."""
    h = _make_handler(headers={}, body=b"")
    assert h._read_json() == {}


def test_read_json_parses_valid_body():
    body = json.dumps({"key": "value", "n": 42}).encode("utf-8")
    h = _make_handler(headers={"Content-Length": str(len(body))}, body=body)
    assert h._read_json() == {"key": "value", "n": 42}


def test_read_json_raises_on_invalid_json():
    """Invalid JSON should raise — do_POST catches it and 400s. The unit
    contract is "either return dict or raise"."""
    body = b"{not valid json"
    h = _make_handler(headers={"Content-Length": str(len(body))}, body=body)
    with pytest.raises(json.JSONDecodeError):
        h._read_json()


# ─── _send_json / _send_bytes ───────────────────────────────────────────


def test_send_json_writes_serialized_body_and_content_headers():
    h = _make_handler()
    h._send_json(200, {"ok": True, "result": 7})
    h.send_response.assert_called_once_with(200)
    # Check Content-Type and Content-Length headers were sent
    call_args = [c.args for c in h.send_header.call_args_list]
    assert ("Content-Type", "application/json") in call_args
    # Body is on wfile
    written = h.wfile.getvalue()
    assert json.loads(written) == {"ok": True, "result": 7}
    # Content-Length header value should match actual body byte length
    cl = next(v for k, v in call_args if k == "Content-Length")
    assert int(cl) == len(written)


def test_send_bytes_writes_raw_payload_with_content_type():
    """screenshot endpoint returns a PNG via this path — verify it's not
    accidentally re-encoded."""
    h = _make_handler()
    payload = b"\x89PNG\r\n\x1a\nrest-of-image"
    h._send_bytes(200, "image/png", payload)
    h.send_response.assert_called_once_with(200)
    call_args = [c.args for c in h.send_header.call_args_list]
    assert ("Content-Type", "image/png") in call_args
    assert ("Content-Length", str(len(payload))) in call_args
    assert h.wfile.getvalue() == payload


# ─── do_GET /health ─────────────────────────────────────────────────────


def test_health_returns_status_snapshot():
    """The /health endpoint is what kubectl probes + paperclip agents read
    to decide if the bot is ready. The response shape is part of the public
    contract."""
    # Reset state to a known shape
    state.status.clear()
    state.status.update({"ready": True, "phase": "serving"})
    state.set_page(None)

    h = _make_handler()
    h.path = "/health"
    h.do_GET()

    body = json.loads(h.wfile.getvalue())
    assert body["ok"] is True
    assert body["ready"] is True
    assert body["phase"] == "serving"
    # url is None when no page (which is what we set)
    assert body["url"] is None


def test_health_reports_page_url_when_page_set():
    """When the bot is serving, /health must surface the page url so the
    operator can correlate a degraded probe with what the bot was looking
    at."""
    state.status.clear()
    state.status.update({"ready": True, "phase": "serving"})

    fake_page = MagicMock()
    fake_page.url = "https://lisa-blockcast.design.webflow.com/"
    state.set_page(fake_page)
    try:
        h = _make_handler()
        h.path = "/health"
        h.do_GET()
        body = json.loads(h.wfile.getvalue())
        assert body["url"] == "https://lisa-blockcast.design.webflow.com/"
    finally:
        state.set_page(None)


def test_get_404_for_unknown_path():
    h = _make_handler()
    h.path = "/nonsense"
    h.do_GET()
    h.send_response.assert_called_once_with(404)
