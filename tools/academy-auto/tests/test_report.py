from academy_auto.gate import GateResult, GateStep
from academy_auto.runner import RunOutcome
from academy_auto.report import build_digest, send_digest


def test_build_digest_green_committed():
    text = build_digest(
        task_prompt="Login-Bug fixen",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=True, steps=[
            GateStep(["npm", "test"], 0, "ok"),
        ]),
        committed=True,
    )
    assert "Academy" in text
    assert "Login-Bug fixen" in text
    assert "grün" in text.lower()
    assert "committet" in text.lower()


def test_build_digest_red_gate_mentions_failing_step():
    text = build_digest(
        task_prompt="Refactor X",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=False, steps=[
            GateStep(["npm", "test"], 1, "1 test failed"),
        ]),
        committed=False,
    )
    assert "rot" in text.lower()
    assert "npm test" in text
    assert "verworfen" in text.lower()


def test_send_digest_uses_sender():
    sent = []
    send_digest("hallo", sender=lambda t: sent.append(t))
    assert sent == ["hallo"]
