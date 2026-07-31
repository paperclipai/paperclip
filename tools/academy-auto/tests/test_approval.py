from academy_auto.config import Config
from academy_auto.approval import has_unmerged_commit


class Git:
    """Runner-Attrappe fuer die Freigabe-Sperre."""

    def __init__(self, ahead="0", fail_on=()):
        self.ahead = ahead
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

        class R:
            returncode = rc
            stdout = out
            stderr = ""

        return R()


def _cfg():
    return Config(**dict(Config.default().__dict__))


def test_branch_merged_into_base_is_not_pending():
    """Arbeit ist in main angekommen -> der Reset darf laufen."""
    assert has_unmerged_commit(_cfg(), runner=Git(ahead="0")) is False


def test_unapproved_commit_is_pending():
    """Commit wartet auf Walters ✅ -> reset --hard wuerde ihn vernichten."""
    assert has_unmerged_commit(_cfg(), runner=Git(ahead="1")) is True


def test_approved_but_unmerged_commit_is_still_pending():
    """Nach ✅ steht der Commit auf origin und ein PR ist offen. Trotzdem
    gesperrt: der naechste Lauf wuerde vom zurueckgesetzten Branch aus
    committen, und das `git push -f` des Executors bei der naechsten Freigabe
    wuerde den Inhalt des offenen PRs ersetzen. Erst der Merge macht frei."""
    assert has_unmerged_commit(_cfg(), runner=Git(ahead="1")) is True


def test_git_failure_is_treated_as_pending():
    """Fail-safe: lieber eine Nacht aussetzen als Arbeit vernichten."""
    assert has_unmerged_commit(_cfg(), runner=Git(ahead="1", fail_on=("rev-list",))) is True


def test_push_state_does_not_enter_the_decision():
    """Nur der Abstand zum Basis-Branch entscheidet. Der Push-Zustand des
    Agenten-Branches wird NICHT abgefragt — 'gepusht' hiess frueher
    faelschlich 'erledigt', obwohl der PR noch offen war und ein spaeteres
    `push -f` seinen Inhalt ersetzt haette."""
    git = Git(ahead="1")
    has_unmerged_commit(_cfg(), runner=git)
    assert not any("rev-parse" in c for c in git.calls)


def test_check_never_mutates_the_tree():
    """Die Pruefung laeuft VOR prepare_worktree und darf selbst nichts anfassen."""
    git = Git(ahead="1")
    has_unmerged_commit(_cfg(), runner=git)
    assert not any("reset" in c or "clean" in c or "checkout" in c for c in git.calls)


def test_lock_compares_against_the_remote_base():
    """Gleiche Falle wie in prepare_worktree: `gh pr merge` bewegt den lokalen
    main-Zeiger nicht. Verglichen mit dem veralteten lokalen Stand blieben
    laengst gemergte Commits ewig 'offen' — die Pipeline waere dauerhaft
    gesperrt."""
    git = Git(ahead="0")
    has_unmerged_commit(_cfg(), runner=git)
    assert any("fetch" in c for c in git.calls)
    assert any("origin/main.." in c for c in git.calls)
