import json, os, tempfile, pytest
from config import load_resident_set

HERE = os.path.dirname(__file__)

def test_loads_real_set():
    entries = load_resident_set(os.path.join(HERE, "resident-set.json"))
    assert len(entries) == 9
    keys = {(e["load_key"], e["device"]) for e in entries}
    assert ("qwen/qwen3-coder-next", "macbook") in keys
    assert ("qwen/qwen3-coder-next", "rtx") in keys

def test_rejects_unknown_device(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"devices": ["studio"], "models": [
        {"device": "moon", "ps_key": "x", "load_key": "x", "ctx": 10, "parallel": 4, "when": "always"}]}))
    with pytest.raises(ValueError):
        load_resident_set(str(p))

def test_rejects_missing_field(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"devices": ["studio"], "models": [
        {"device": "studio", "load_key": "x", "ctx": 10, "parallel": 4, "when": "always"}]}))
    with pytest.raises(ValueError):
        load_resident_set(str(p))
