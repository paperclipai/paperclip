from academy_auto.config import Config
from academy_auto.runner import implement_task, CLAUDE_CMD


def test_implement_task_invokes_claude_headless_in_worktree():
    cfg = Config.default()
    captured = {}

    def runner(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["cwd"] = kwargs.get("cwd")

        class R:
            returncode = 0
            stdout = "fertig"
            stderr = ""
        return R()

    outcome = implement_task(
        cfg, cwd="/tmp/wt", task_prompt="Fixe den Login-Bug", runner=runner
    )
    assert outcome.ok is True
    assert outcome.output == "fertig"
    # headless-Präfix + Prompt landen im Kommando, cwd ist der Worktree
    assert captured["cmd"][: len(CLAUDE_CMD)] == CLAUDE_CMD
    assert "Fixe den Login-Bug" in " ".join(captured["cmd"])
    assert captured["cwd"] == "/tmp/wt"


def test_implement_task_reports_failure_on_nonzero_exit():
    cfg = Config.default()

    def runner(cmd, **kwargs):
        class R:
            returncode = 2
            stdout = ""
            stderr = "claude timeout"
        return R()

    outcome = implement_task(cfg, cwd="/tmp/wt", task_prompt="x", runner=runner)
    assert outcome.ok is False
    assert "timeout" in outcome.output
