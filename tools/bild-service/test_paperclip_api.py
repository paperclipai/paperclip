import io
import json
import urllib.error

import paperclip_api
import pytest


class _FakeResp(object):
    """Minimal stand-in for the object urlopen() returns as context manager."""

    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def _patch_token(monkeypatch):
    monkeypatch.setattr(paperclip_api, "_token", lambda: "tok-123")


# --- Fix round: Finding 6 — nicht-Auth-Fehler muessen typisiert sein, nicht ---
# --- als bare RuntimeError oder gar-nicht-gefangen durchgereicht werden.    ---

def test_request_maps_non_auth_http_status_to_paperclip_error(monkeypatch):
    _patch_token(monkeypatch)

    def raise_http(*a, **k):
        raise urllib.error.HTTPError("http://x", 500, "Server Error", {},
                                     io.BytesIO(b"kaputt"))

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_http)
    with pytest.raises(paperclip_api.PaperclipError) as exc:
        paperclip_api._request("GET", "/api/issues/1")
    msg = str(exc.value)
    assert "GET" in msg
    assert "/api/issues/1" in msg
    assert "500" in msg
    assert "kaputt" in msg


def test_request_still_raises_auth_error_for_401(monkeypatch):
    _patch_token(monkeypatch)

    def raise_http(*a, **k):
        raise urllib.error.HTTPError("http://x", 401, "Unauthorized", {},
                                     io.BytesIO(b""))

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_http)
    with pytest.raises(paperclip_api.AuthError):
        paperclip_api._request("GET", "/api/issues/1")
    # AuthError ist kein PaperclipError -- die beiden Faelle bleiben unterscheidbar
    assert not issubclass(paperclip_api.AuthError, paperclip_api.PaperclipError)


def test_request_still_raises_auth_error_for_403(monkeypatch):
    _patch_token(monkeypatch)

    def raise_http(*a, **k):
        raise urllib.error.HTTPError("http://x", 403, "Forbidden", {},
                                     io.BytesIO(b""))

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_http)
    with pytest.raises(paperclip_api.AuthError):
        paperclip_api._request("GET", "/api/issues/1")


def test_request_maps_url_error(monkeypatch):
    _patch_token(monkeypatch)

    def raise_url(*a, **k):
        raise urllib.error.URLError("Verbindung abgelehnt")

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_url)
    with pytest.raises(paperclip_api.PaperclipError) as exc:
        paperclip_api._request("POST", "/api/issues/1/comments",
                               json_body={"body": "hallo"})
    msg = str(exc.value)
    assert "POST" in msg
    assert "/api/issues/1/comments" in msg


def test_request_maps_os_error(monkeypatch):
    _patch_token(monkeypatch)

    def raise_os(*a, **k):
        raise OSError("Netzwerk kaputt")

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_os)
    with pytest.raises(paperclip_api.PaperclipError) as exc:
        paperclip_api._request("GET", "/api/issues/1")
    assert "GET" in str(exc.value)


# --- Paperclip nicht erreichbar ist ein EIGENER Fall ----------------------
#
# Der Aufrufer muss "Server ist unten" von "Server antwortet, aber der
# Aufruf war falsch" unterscheiden koennen, ohne in Fehlertexten zu suchen:
# nur der erste Fall darf gedaempft werden, der zweite muss sofort auffallen.

def test_url_error_ist_unreachable(monkeypatch):
    _patch_token(monkeypatch)

    def raise_url(*a, **k):
        raise urllib.error.URLError("Verbindung abgelehnt")

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_url)
    with pytest.raises(paperclip_api.PaperclipUnreachable):
        paperclip_api._request("GET", "/api/issues/1")


def test_os_error_ist_unreachable(monkeypatch):
    _patch_token(monkeypatch)

    def raise_os(*a, **k):
        raise OSError("Netzwerk kaputt")

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_os)
    with pytest.raises(paperclip_api.PaperclipUnreachable):
        paperclip_api._request("GET", "/api/issues/1")


def test_unreachable_bleibt_ein_paperclip_error():
    """Bestehende breite except-Bloecke duerfen nicht durchfallen."""
    assert issubclass(paperclip_api.PaperclipUnreachable,
                      paperclip_api.PaperclipError)


def test_http_status_ist_nicht_unreachable(monkeypatch):
    """500 heisst: der Server ANTWORTET. Das darf nicht gedaempft werden."""
    _patch_token(monkeypatch)

    def raise_http(*a, **k):
        raise urllib.error.HTTPError("http://x", 500, "Server Error", {},
                                     io.BytesIO(b"kaputt"))

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_http)
    with pytest.raises(paperclip_api.PaperclipError) as exc:
        paperclip_api._request("GET", "/api/issues/1")
    assert not isinstance(exc.value, paperclip_api.PaperclipUnreachable)


def test_fetch_attachment_url_error_ist_unreachable(monkeypatch):
    _patch_token(monkeypatch)

    def raise_url(*a, **k):
        raise urllib.error.URLError("Verbindung abgelehnt")

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_url)
    with pytest.raises(paperclip_api.PaperclipUnreachable):
        paperclip_api.fetch_attachment("att-1")


def test_request_maps_malformed_json_body(monkeypatch):
    _patch_token(monkeypatch)
    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen",
                        lambda *a, **k: _FakeResp(b"das ist kein JSON"))
    with pytest.raises(paperclip_api.PaperclipError) as exc:
        paperclip_api._request("GET", "/api/issues/1")
    msg = str(exc.value)
    assert "GET" in msg
    assert "/api/issues/1" in msg


def test_request_empty_body_still_returns_empty_dict(monkeypatch):
    """Regression guard: ein leerer 204-Body ist kein Fehlerfall."""
    _patch_token(monkeypatch)
    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen",
                        lambda *a, **k: _FakeResp(b""))
    assert paperclip_api._request("PATCH", "/api/issues/1") == {}


def test_mail_alarm_tolerates_missing_secrets_file():
    """Test that mail_alarm() degrades gracefully when secrets file is missing.

    mail_alarm() is called from exception handlers in bild_service.py.
    If it raises, it would crash the poller. It must tolerate missing
    secrets file just like it tolerates unreachable webhook.
    """
    # Patch to point at non-existent file
    original_secret_env = paperclip_api.MAIL_SECRET_ENV
    try:
        paperclip_api.MAIL_SECRET_ENV = '/tmp/gibtsnicht-mailhub-12345.env'

        # This must not raise, even though secrets file doesn't exist
        paperclip_api.mail_alarm("Test Subject", "Test Body")

        # If we get here, test passed (no exception)
        assert True
    finally:
        paperclip_api.MAIL_SECRET_ENV = original_secret_env


def test_list_attachments_ruft_den_richtigen_pfad(monkeypatch):
    _patch_token(monkeypatch)
    gesehen = {}

    def fake_urlopen(req, *a, **k):
        gesehen["url"] = req.full_url
        return _FakeResp(json.dumps([{"id": "att-1"}]).encode())

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", fake_urlopen)
    res = paperclip_api.list_attachments("issue-9")
    assert res == [{"id": "att-1"}]
    assert gesehen["url"].endswith("/api/issues/issue-9/attachments")


def test_fetch_attachment_liefert_rohe_bytes(monkeypatch):
    """Darf NICHT durch json.loads laufen -- das wuerde ein PNG zerreissen."""
    _patch_token(monkeypatch)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20

    def fake_urlopen(req, *a, **k):
        return _FakeResp(png)

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", fake_urlopen)
    assert paperclip_api.fetch_attachment("att-1") == png


def test_fetch_attachment_401_ist_autherror(monkeypatch):
    _patch_token(monkeypatch)

    def raise_http(*a, **k):
        raise urllib.error.HTTPError("http://x", 401, "Unauthorized", {},
                                     io.BytesIO(b""))

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_http)
    with pytest.raises(paperclip_api.AuthError):
        paperclip_api.fetch_attachment("att-1")


def test_fetch_attachment_500_ist_paperclip_error(monkeypatch):
    _patch_token(monkeypatch)

    def raise_http(*a, **k):
        raise urllib.error.HTTPError("http://x", 500, "Server Error", {},
                                     io.BytesIO(b"kaputt"))

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_http)
    with pytest.raises(paperclip_api.PaperclipError):
        paperclip_api.fetch_attachment("att-1")
