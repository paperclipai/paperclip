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


def test_build_digest_cap_exceeded_mentions_cap_not_no_green_gate():
    text = build_digest(
        task_prompt="Riesenrefactor",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=True, steps=[
            GateStep(["npm", "test"], 0, "ok"),
        ]),
        committed=False,
        cap_exceeded=True,
    )
    assert "Cap" in text
    assert "verworfen" in text.lower()
    assert "kein grünes Gate" not in text


def test_build_digest_scope_violation_names_files():
    from academy_auto.gate import GateResult, GateStep
    from academy_auto.runner import RunOutcome
    from academy_auto.report import build_digest
    text = build_digest(
        task_prompt="X",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=True, steps=[GateStep(["npm", "test"], 0, "ok")]),
        committed=False,
        scope_violations=[".env", "ios/cert.p12"],
    )
    assert "Scope" in text
    assert ".env" in text
    assert "verworfen" in text.lower()


def test_send_digest_uses_sender():
    sent = []
    send_digest("hallo", sender=lambda t: sent.append(t))
    assert sent == ["hallo"]


def test_build_digest_includes_reason_and_quarantine():
    from academy_auto.gate import GateResult, GateStep
    from academy_auto.runner import RunOutcome
    from academy_auto.report import build_digest
    text = build_digest(
        task_prompt="Fix a.ts",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=True, steps=[GateStep(["npm", "test"], 0, "ok")]),
        committed=True,
        reason="höchste Priorität",
        quarantined=["todo:x.ts:9"],
    )
    assert "höchste Priorität" in text
    assert "todo:x.ts:9" in text
    assert "Quarant" in text


def test_build_nothing_digest():
    from academy_auto.report import build_nothing_digest
    text = build_nothing_digest(quarantined=["todo:x.ts:9"])
    assert "nichts" in text.lower() or "keine" in text.lower()
    assert "todo:x.ts:9" in text


# Task 2: gate_note Tests
def test_build_digest_uses_gate_note_when_set():
    from academy_auto.runner import RunOutcome
    from academy_auto.report import build_digest
    text = build_digest(
        task_prompt="x", run_outcome=RunOutcome(ok=True, output=""),
        gate_result=None, committed=True, gate_note="Delta grün (Fehler 5→2)",
    )
    assert "Delta grün (Fehler 5→2)" in text
    assert "Gate: Delta grün" in text


def test_build_digest_result_override_replaces_result_line():
    from academy_auto.runner import RunOutcome
    from academy_auto.report import build_digest
    text = build_digest(
        task_prompt="x", run_outcome=RunOutcome(ok=True, output=""),
        gate_result=None, committed=False,
        result_override="TROCKENLAUF — hätte committet (3 Dateien, 42 Zeilen)",
    )
    assert "TROCKENLAUF" in text
    assert "42 Zeilen" in text
    assert "kein grünes Gate" not in text


def test_build_digest_from_pending_change():
    from academy_auto.pending import PendingRecord
    from academy_auto.report import build_digest_from_pending
    rec = PendingRecord(
        run_ts="2026-07-25T02:00:03", outcome="committed", task="Jest-Typen",
        reason="17x impact", gate_note="Delta grün (658→12)", branch_sha="abc",
        has_change=True, tsc_delta=646, quarantined=["tsc:foo:1:TS2593"],
    )
    text = build_digest_from_pending(rec)
    assert "Academy-Auto" in text
    assert "Jest-Typen" in text
    assert "Delta grün (658→12)" in text
    assert "Quarantäne" in text


def test_build_digest_from_pending_nothing():
    from academy_auto.pending import PendingRecord
    from academy_auto.report import build_digest_from_pending
    rec = PendingRecord("t", "nothing_to_do", "", "", "", "", False, 0, [])
    text = build_digest_from_pending(rec)
    assert "nichts Umsetzbares" in text
