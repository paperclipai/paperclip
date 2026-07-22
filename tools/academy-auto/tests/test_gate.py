from academy_auto.config import Config
from academy_auto.gate import run_gate


def make_runner(return_codes):
    seq = list(return_codes)

    def runner(cmd, **kwargs):
        rc = seq.pop(0)

        class R:
            returncode = rc
            stdout = "ok" if rc == 0 else "boom"
            stderr = ""
        return R()

    return runner


def test_gate_all_green_passes():
    cfg = Config.default()
    res = run_gate(cfg, cwd="/tmp/wt", runner=make_runner([0, 0, 0]))
    assert res.passed is True
    assert len(res.steps) == 3
    assert [s.cmd for s in res.steps] == cfg.gate_commands


def test_gate_fails_fast_on_first_red():
    cfg = Config.default()
    # jest rot -> tsc/lint dürfen NICHT mehr laufen
    res = run_gate(cfg, cwd="/tmp/wt", runner=make_runner([1, 0, 0]))
    assert res.passed is False
    assert len(res.steps) == 1
    assert res.steps[0].cmd == ["npm", "test"]
    assert res.steps[0].returncode == 1
