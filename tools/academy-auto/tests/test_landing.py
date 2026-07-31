from academy_auto.config import Config
from academy_auto.landing import land


class Git:
    """Runner-Attrappe: zeichnet alles auf, laesst einzelne Kommandos scheitern."""

    def __init__(self, fail_on=()):
        self.fail_on = fail_on
        self.calls = []

    def __call__(self, cmd, **kwargs):
        joined = " ".join(cmd)
        self.calls.append(joined)
        rc = 128 if any(f in joined for f in self.fail_on) else 0
        out = ""
        if "rev-parse" in joined:
            out = "cafe1234\n"
        if "pr create" in joined:
            out = "https://github.com/whitestagai/ki-kompass/pull/42\n"

        class R:
            returncode = rc
            stdout = out
            stderr = "" if rc == 0 else "boom"

        return R()

    def index_of(self, needle):
        for i, c in enumerate(self.calls):
            if needle in c:
                return i
        return -1


class Gate:
    def __init__(self, total):
        self.total = total

    def __call__(self, cfg, cwd):
        class M:
            pass
        m = M()
        m.total = self.total
        m.ok = True
        m.steps = []
        return m


def _cfg():
    return Config(**dict(Config.default().__dict__))


def test_green_gate_on_main_lands_without_revert():
    git = Git()
    res = land(_cfg(), "/wt", runner=git, measure_gate=Gate(0))
    assert res.ok is True
    assert res.reverted is False
    assert git.index_of("push") >= 0
    assert git.index_of("pr create") >= 0
    assert git.index_of("pr merge") >= 0
    assert not any("revert" in c for c in git.calls)


def test_red_gate_on_main_triggers_revert_and_push():
    """Der Baustein, der Auto-Merge verantwortbar macht."""
    git = Git()
    res = land(_cfg(), "/wt", runner=git, measure_gate=Gate(3))
    assert res.ok is False
    assert res.reverted is True
    assert any("revert --no-commit" in c for c in git.calls)
    assert any("push origin HEAD:" in c for c in git.calls)


def test_agent_branch_is_never_deleted():
    """`gh pr merge --delete-branch` wuerde agents/academy-auto entfernen —
    den braucht die Pipeline jede Nacht."""
    git = Git()
    land(_cfg(), "/wt", runner=git, measure_gate=Gate(0))
    assert not any("delete-branch" in c for c in git.calls)


def test_verification_runs_on_main_not_on_the_agent_branch():
    """Erst auf den frisch gemergten main zuruecksetzen, dann messen —
    sonst wuerde nur der Branch nochmal geprueft, den das Gate schon kannte."""
    seen = {}

    def gate(cfg, cwd):
        seen["at_call"] = list(git.calls)
        class M:
            total = 0
            ok = True
            steps = []
        return M()

    git = Git()
    land(_cfg(), "/wt", runner=git, measure_gate=gate)
    before = seen["at_call"]
    assert any("fetch" in c for c in before)
    assert any("reset --hard origin/" in c for c in before)


def test_push_failure_stops_before_opening_a_pr():
    git = Git(fail_on=("push -f",))
    res = land(_cfg(), "/wt", runner=git, measure_gate=Gate(0))
    assert res.ok is False
    assert res.reverted is False
    assert git.index_of("pr create") == -1


def test_merge_failure_does_not_revert():
    """Nichts gelandet -> nichts zurueckzunehmen. Ein Revert waere hier
    ein Eingriff in fremde Commits auf main."""
    git = Git(fail_on=("pr merge",))
    res = land(_cfg(), "/wt", runner=git, measure_gate=Gate(0))
    assert res.ok is False
    assert res.reverted is False
    assert not any("revert" in c for c in git.calls)
