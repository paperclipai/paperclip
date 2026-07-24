import os
from warden import run

HERE = os.path.dirname(__file__)
LINK = '{"deviceName":"MacStudioM4Max128","deviceIdentifier":"S1","peers":[{"deviceName":"MacbookM5Mx128","deviceIdentifier":"M1"}]}'

def make_run_cmd(calls, fail_keys=()):
    def run_cmd(argv):
        calls.append(argv)
        if argv[:2] == ["lms", "load"] and argv[2] in fail_keys:
            return (1, "insufficient system resources")
        return (0, "OK")
    return run_cmd

def test_loads_missing_and_skips_absent_rtx():
    calls = []
    ps = "[]"  # nichts geladen
    notified = []
    res = run(make_run_cmd(calls), lambda: LINK, lambda: ps,
              os.path.join(HERE, "resident-set.json"),
              lambda t, b: notified.append((t, b)))
    loaded_keys = {c[2] for c in calls if c[:2] == ["lms", "load"]}
    # studio+macbook always-Modelle geladen, RTX (day-only) NICHT (abwesend)
    assert "gemma-4-31b-it-mlx" in loaded_keys
    assert "qwen3.6-35b-a3b-mlx" in loaded_keys
    assert "google/gemma-4-12b-qat" not in loaded_keys
    assert notified == []

def test_failure_triggers_notify():
    calls = []
    notified = []
    res = run(make_run_cmd(calls, fail_keys={"gemma-4-31b-it-mlx"}),
              lambda: LINK, lambda: "[]",
              os.path.join(HERE, "resident-set.json"),
              lambda t, b: notified.append((t, b)))
    assert res["failures"]
    assert notified and "gemma-4-31b-it-mlx" in notified[0][1]
