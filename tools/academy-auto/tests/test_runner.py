# tools/academy-auto/tests/test_runner.py
from academy_auto.config import Config
from academy_auto.runner import implement_task, CLAUDE_CMD


def _ok_proc(stdout="fertig", returncode=0, stderr=""):
    class R:
        pass
    r = R()
    r.stdout = stdout
    r.stderr = stderr
    r.returncode = returncode
    return r


def _deps(**over):
    d = dict(
        available=lambda cfg: True,
        make_profile=lambda cfg: "/tmp/prof.sb",
        wrap=lambda cfg, cmd, profile: ["sandbox-exec", "-f", str(profile), *cmd],
    )
    d.update(over)
    return d


def test_implement_task_runs_inside_sandbox():
    cfg = Config.default()
    captured = {}

    def runner(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["cwd"] = kwargs.get("cwd")
        return _ok_proc()

    outcome = implement_task(cfg, "/tmp/wt", "Fixe den Login-Bug", runner=runner, **_deps())
    assert outcome.ok is True
    assert outcome.output == "fertig"
    # Kommando ist sandbox-gekapselt UND enthält den echten claude-Aufruf + Prompt
    assert captured["cmd"][:2] == ["sandbox-exec", "-f"]
    assert captured["cmd"][3:3 + len(CLAUDE_CMD)] == CLAUDE_CMD
    assert "Fixe den Login-Bug" in captured["cmd"]
    assert captured["cwd"] == "/tmp/wt"


def test_implement_task_fail_closed_when_sandbox_unavailable():
    cfg = Config.default()
    calls = {"n": 0}

    def counting_runner(*a, **k):
        calls["n"] += 1
        return _ok_proc()

    outcome = implement_task(
        cfg, "/tmp/wt", "x", runner=counting_runner, **_deps(available=lambda cfg: False)
    )
    assert outcome.ok is False
    # Belastbarer Wächter: claude wurde NICHT gestartet — unabhängig davon,
    # ob eine Exception vom breiten except verschluckt würde.
    assert calls["n"] == 0
    assert "andbox" in outcome.output


def test_implement_task_reports_failure_on_nonzero_exit():
    cfg = Config.default()
    outcome = implement_task(
        cfg, "/tmp/wt", "x",
        runner=lambda cmd, **k: _ok_proc(stdout="", stderr="claude timeout", returncode=2),
        **_deps(),
    )
    assert outcome.ok is False
    assert "timeout" in outcome.output


def test_implement_task_fail_soft_when_runner_raises():
    cfg = Config.default()

    def boom(*a, **k):
        raise RuntimeError("prozess kaputt")

    outcome = implement_task(cfg, "/tmp/wt", "x", runner=boom, **_deps())
    assert outcome.ok is False
    assert "kaputt" in outcome.output


def test_implement_task_cleans_up_profile(tmp_path):
    cfg = Config.default()
    prof = tmp_path / "prof.sb"
    prof.write_text("(version 1)")
    implement_task(
        cfg, "/tmp/wt", "x", runner=lambda cmd, **k: _ok_proc(),
        **_deps(make_profile=lambda cfg: str(prof)),
    )
    assert not prof.exists()  # Temp-Profil nach dem Lauf gelöscht
