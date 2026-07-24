from loader import set_preferred_cmd, load_cmd

def test_set_preferred():
    assert set_preferred_cmd("R1") == ["lms", "link", "set-preferred-device", "R1"]

def test_load_cmd_full():
    e = {"load_key": "qwen/qwen3-coder-next", "ctx": 65000, "parallel": 4}
    assert load_cmd(e) == ["lms", "load", "qwen/qwen3-coder-next", "-c", "65000", "--parallel", "4", "-y"]

def test_load_cmd_embeddings_no_ctx():
    e = {"load_key": "text-embedding-bge-m3", "ctx": None, "parallel": None}
    assert load_cmd(e) == ["lms", "load", "text-embedding-bge-m3", "-y"]
