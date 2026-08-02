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
