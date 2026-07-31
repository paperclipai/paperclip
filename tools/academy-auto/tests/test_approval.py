from academy_auto.config import Config
from academy_auto.approval import has_unapproved_commit


class Git:
    """Runner-Attrappe fuer die drei git-Abfragen der Freigabe-Sperre."""

    def __init__(self, ahead="0", local="aaa", remote="aaa", fail_on=()):
        self.ahead, self.local, self.remote = ahead, local, remote
        self.fail_on = fail_on
        self.calls = []

    def __call__(self, cmd, **kwargs):
        joined = " ".join(cmd)
        self.calls.append(joined)
        out, rc = "", 0
        if any(f in joined for f in self.fail_on):
            rc = 128
        elif "rev-list" in joined:
            out = self.ahead + "\n"
        elif "rev-parse" in joined and "origin/" in joined:
            out = self.remote + "\n"
        elif "rev-parse" in joined:
            out = self.local + "\n"

        class R:
            returncode = rc
            stdout = out
            stderr = ""

        return R()


def _cfg():
    return Config(**dict(Config.default().__dict__))


def test_branch_equal_to_base_is_not_pending():
    """Kein Commit ueber main hinaus -> nichts wartet auf Freigabe."""
    assert has_unapproved_commit(_cfg(), runner=Git(ahead="0")) is False


def test_unpushed_commit_is_pending():
    """Commit da, aber nicht auf origin -> Walter hat noch nicht freigegeben."""
    git = Git(ahead="1", local="abc123", remote="aaa")
    assert has_unapproved_commit(_cfg(), runner=git) is True


def test_pushed_commit_is_not_pending():
    """Der Executor pusht bei ✅. Gleiche SHA auf origin = freigegeben,
    der PR lebt dort weiter und der Reset darf laufen."""
    git = Git(ahead="1", local="abc123", remote="abc123")
    assert has_unapproved_commit(_cfg(), runner=git) is False


def test_missing_origin_ref_is_pending():
    """Nie gepusht -> `rev-parse origin/<branch>` scheitert -> offen."""
    git = Git(ahead="1", fail_on=("origin/",))
    assert has_unapproved_commit(_cfg(), runner=git) is True


def test_git_failure_is_treated_as_pending():
    """Fail-safe: lieber eine Nacht aussetzen als einen nicht freigegebenen
    Commit durch `reset --hard` vernichten."""
    git = Git(ahead="1", fail_on=("rev-list",))
    assert has_unapproved_commit(_cfg(), runner=git) is True


def test_check_never_mutates_the_tree():
    """Die Pruefung laeuft VOR prepare_worktree und darf selbst nichts anfassen."""
    git = Git(ahead="1", local="abc", remote="aaa")
    has_unapproved_commit(_cfg(), runner=git)
    assert not any("reset" in c or "clean" in c or "checkout" in c for c in git.calls)
