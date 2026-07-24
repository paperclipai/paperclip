from reconcile import plan_actions

DEVICES = {"studio": "S1", "macbook": "M1", "rtx": "R1"}
def entry(dev, key, ctx, when="always"):
    return {"device": dev, "ps_key": key, "load_key": key, "ctx": ctx, "parallel": 4, "when": when}

def test_missing_model_yields_load():
    desired = [entry("studio", "gemma-4-31b-it-mlx", 65000)]
    actions = plan_actions(desired, [], DEVICES, {"studio", "macbook", "rtx"})
    assert [a["action"] for a in actions] == ["load"]

def test_present_correct_yields_nothing():
    desired = [entry("studio", "gemma-4-31b-it-mlx", 65000)]
    loaded = [{"model_key": "gemma-4-31b-it-mlx", "ctx": 65000, "device_id": None}]
    assert plan_actions(desired, loaded, DEVICES, {"studio"}) == []

def test_wrong_ctx_yields_mismatch_not_load():
    desired = [entry("studio", "gemma-4-31b-it-mlx", 65000)]
    loaded = [{"model_key": "gemma-4-31b-it-mlx", "ctx": 40000, "device_id": None}]
    actions = plan_actions(desired, loaded, DEVICES, {"studio"})
    assert [a["action"] for a in actions] == ["ctx_mismatch"]

def test_dayonly_on_absent_device_skipped():
    desired = [entry("rtx", "google/gemma-4-12b-qat", 65024, when="day-only")]
    assert plan_actions(desired, [], DEVICES, {"studio", "macbook"}) == []

def test_dayonly_present_on_available_device_ok():
    desired = [entry("rtx", "qwen/qwen3-coder-next", 131328, when="day-only")]
    loaded = [{"model_key": "qwen/qwen3-coder-next", "ctx": 131328, "device_id": "R1"}]
    assert plan_actions(desired, loaded, DEVICES, {"studio", "macbook", "rtx"}) == []

def test_same_model_two_devices_independent():
    desired = [entry("macbook", "qwen/qwen3-coder-next", 65000),
               entry("rtx", "qwen/qwen3-coder-next", 131328, when="day-only")]
    loaded = [{"model_key": "qwen/qwen3-coder-next", "ctx": 131328, "device_id": "R1"}]
    actions = plan_actions(desired, loaded, DEVICES, {"studio", "macbook", "rtx"})
    # macbook-Instanz fehlt -> genau ein load
    assert [ (a["action"], a["entry"]["device"]) for a in actions ] == [("load", "macbook")]
