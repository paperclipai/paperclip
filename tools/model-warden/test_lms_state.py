from lms_state import resolve_devices, parse_loaded, available_devices

LINK = '{"deviceName":"MacStudioM4Max128","deviceIdentifier":"S1","peers":[' \
       '{"deviceName":"MacbookM5Mx128","deviceIdentifier":"M1"},' \
       '{"deviceName":"RTX Pro 6000","deviceIdentifier":"R1"}]}'
LINK_NIGHT = '{"deviceName":"MacStudioM4Max128","deviceIdentifier":"S1","peers":[' \
             '{"deviceName":"MacbookM5Mx128","deviceIdentifier":"M1"}]}'
PS = '[{"modelKey":"gemma-4-31b-it-mlx","contextLength":65000,"deviceIdentifier":null},' \
     '{"modelKey":"qwen/qwen3-coder-next","contextLength":131328,"deviceIdentifier":"R1"}]'

def test_resolve_devices():
    d = resolve_devices(LINK)
    assert d["studio"] == "S1" and d["macbook"] == "M1" and d["rtx"] == "R1"

def test_available_excludes_absent_rtx():
    assert available_devices(LINK_NIGHT) == {"studio", "macbook"}
    assert "rtx" in available_devices(LINK)

def test_parse_loaded():
    loaded = parse_loaded(PS)
    assert {"model_key": "gemma-4-31b-it-mlx", "ctx": 65000, "device_id": None} in loaded
    assert {"model_key": "qwen/qwen3-coder-next", "ctx": 131328, "device_id": "R1"} in loaded
