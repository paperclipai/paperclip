from academy_auto.config import Config
from academy_auto.gate import run_gate, measure_gate, GateMeasure, _count_step_errors, GATE_TIMEOUT


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


def test_count_step_errors_tsc():
    out = "src/a.ts(1,2): error TS2322: x\nsrc/b.ts(3,4): error TS2531: y\nFound 2 errors.\n"
    assert _count_step_errors(["npx", "tsc", "--noEmit"], out, 2) == 2


def test_count_step_errors_jest_failed_count():
    out = "Tests:       3 failed, 5 passed, 8 total\n"
    assert _count_step_errors(["npm", "test"], out, 1) == 3


def test_count_step_errors_jest_green():
    assert _count_step_errors(["npm", "test"], "Tests: 8 passed", 0) == 0


def test_count_step_errors_lint():
    out = "✖ 4 problems (4 errors, 0 warnings)\n"
    assert _count_step_errors(["npm", "run", "lint"], out, 1) == 4


def test_count_step_errors_returncode_fallback():
    # kein parsbares Muster, aber returncode != 0 -> mindestens 1
    assert _count_step_errors(["npm", "run", "lint"], "irgendwas kaputt", 1) == 1
    assert _count_step_errors(["npm", "run", "lint"], "alles gut", 0) == 0


def test_measure_gate_runs_all_steps_no_failfast():
    # Reihenfolge gate_commands: npm test, npx tsc, npm run lint
    outputs = {
        "npm test": ("Tests: 1 failed, 2 total", 1),
        "npx tsc --noEmit": ("Found 2 errors.", 2),
        "npm run lint": ("✖ 0 problems", 0),
    }
    def runner(cmd, **kwargs):
        out, rc = outputs[" ".join(cmd)]
        class R:
            stdout = out; stderr = ""; returncode = rc
        return R()
    m = measure_gate(Config.default(), "/tmp/wt", runner=runner)
    assert isinstance(m, GateMeasure)
    assert len(m.steps) == 3  # ALLE Schritte, kein fail-fast
    assert m.total == 3  # 1 (jest) + 2 (tsc) + 0 (lint)


def test_measure_gate_passes_timeout():
    captured = {}
    def runner(cmd, **kwargs):
        captured.update(kwargs)
        class R:
            stdout = ""; stderr = ""; returncode = 0
        return R()
    measure_gate(Config.default(), "/tmp/wt", runner=runner)
    assert captured.get("timeout") == GATE_TIMEOUT
