import os
import tempfile

import state_io


def setup_tmp():
    fd, path = tempfile.mkstemp()
    os.close(fd)
    os.remove(path)
    return path


def test_load_missing_file_returns_empty_dict():
    path = setup_tmp()
    result = state_io.load(path)
    assert result == {}


def test_load_corrupt_json_returns_empty_dict():
    path = setup_tmp()
    with open(path, "w") as f:
        f.write("{ invalid json }")
    result = state_io.load(path)
    assert result == {}


def test_save_and_load_roundtrip():
    path = setup_tmp()
    state = {"key1": "value1", "key2": {"nested": "value2"}}
    state_io.save(path, state)
    loaded = state_io.load(path)
    assert loaded == state
