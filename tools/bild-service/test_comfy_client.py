import pytest
import comfy_client as cc


def test_parse_prompt_response_returns_id():
    assert cc.parse_prompt_response({"prompt_id": "abc-123", "number": 1}) == "abc-123"


def test_parse_prompt_response_without_id_raises():
    with pytest.raises(RuntimeError):
        cc.parse_prompt_response({"error": "kaputt"})


def test_parse_history_unknown_id_is_running():
    status, payload = cc.parse_history("abc", {})
    assert status == "running"
    assert payload is None


def test_parse_history_completed_returns_images():
    hist = {"abc": {
        "status": {"completed": True, "status_str": "success"},
        "outputs": {"11": {"images": [
            {"filename": "whitestag_00001_.png", "subfolder": "", "type": "output"}]}},
    }}
    status, payload = cc.parse_history("abc", hist)
    assert status == "done"
    assert payload == [{"filename": "whitestag_00001_.png", "subfolder": "", "type": "output"}]


def test_parse_history_error_returns_message():
    hist = {"abc": {"status": {"completed": False, "status_str": "error",
                               "messages": [["execution_error",
                                             {"node_type": "UNETLoader",
                                              "exception_message": "Modell fehlt"}]]}}}
    status, payload = cc.parse_history("abc", hist)
    assert status == "error"
    assert "UNETLoader" in payload
    assert "Modell fehlt" in payload


def test_parse_history_still_running():
    hist = {"abc": {"status": {"completed": False, "status_str": "success"}, "outputs": {}}}
    status, payload = cc.parse_history("abc", hist)
    assert status == "running"


def test_view_path_encodes_query():
    p = cc.view_path({"filename": "a b.png", "subfolder": "sub dir", "type": "output"})
    assert p.startswith("/view?")
    assert "filename=a+b.png" in p or "filename=a%20b.png" in p
    assert "subfolder=sub" in p
    assert "type=output" in p


def test_parse_prompt_response_raises_comfy_error():
    """parse_prompt_response should raise ComfyError (which is a RuntimeError)."""
    with pytest.raises(cc.ComfyError):
        cc.parse_prompt_response({"error": "kaputt"})


def test_parse_history_completed_without_images():
    """Completed job with no images should return error status."""
    hist = {"abc": {
        "status": {"completed": True, "status_str": "success"},
        "outputs": {}
    }}
    status, payload = cc.parse_history("abc", hist)
    assert status == "error"
    assert "Bild" in payload


def test_poll_handles_malformed_json():
    """poll() should raise ComfyError on malformed JSON, not JSONDecodeError."""
    import urllib.request

    # Monkeypatch urlopen to return malformed JSON
    original_urlopen = urllib.request.urlopen

    class FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self):
            return b"<html>502 Bad Gateway</html>"

    def fake_urlopen(url, *args, **kwargs):
        return FakeResponse()

    try:
        urllib.request.urlopen = fake_urlopen
        with pytest.raises(cc.ComfyError):
            cc.poll("test-id")
    finally:
        urllib.request.urlopen = original_urlopen


def test_parse_upload_response_liefert_namen():
    assert cc.parse_upload_response({"name": "a.png", "subfolder": "", "type": "input"}) == "a.png"


def test_parse_upload_response_beruecksichtigt_unterordner():
    """LoadImage erwartet 'unterordner/name', wenn ComfyUI einen vergibt."""
    got = cc.parse_upload_response({"name": "a.png", "subfolder": "sub", "type": "input"})
    assert got == "sub/a.png"


def test_parse_upload_response_ohne_namen_raises():
    with pytest.raises(cc.ComfyError):
        cc.parse_upload_response({"error": "kaputt"})


def test_upload_image_baut_multipart_und_liefert_namen():
    import urllib.request
    original = urllib.request.urlopen
    gesehen = {}

    class FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self):
            return b'{"name": "quelle.png", "subfolder": "", "type": "input"}'

    def fake_urlopen(req, *a, **k):
        gesehen["url"] = req.full_url
        gesehen["ctype"] = req.headers.get("Content-type")
        gesehen["body"] = req.data
        return FakeResponse()

    try:
        urllib.request.urlopen = fake_urlopen
        name = cc.upload_image("quelle.png", b"BILDDATEN")
    finally:
        urllib.request.urlopen = original

    assert name == "quelle.png"
    assert gesehen["url"].endswith("/upload/image")
    assert gesehen["ctype"].startswith("multipart/form-data; boundary=")
    assert b'name="image"; filename="quelle.png"' in gesehen["body"]
    assert b"BILDDATEN" in gesehen["body"]


def test_upload_image_http_fehler_wird_comfy_error():
    import urllib.error
    import urllib.request
    original = urllib.request.urlopen

    def fake_urlopen(*a, **k):
        raise urllib.error.HTTPError("http://x", 413, "Too Large", {}, None)

    try:
        urllib.request.urlopen = fake_urlopen
        with pytest.raises(cc.ComfyError):
            cc.upload_image("a.png", b"x")
    finally:
        urllib.request.urlopen = original
