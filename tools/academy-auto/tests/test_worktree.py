from pathlib import Path
from academy_auto.config import Config
from academy_auto.worktree import prepare_worktree


class FakeRunner:
    def __init__(self):
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))

        class R:
            returncode = 0
            stdout = ""
            stderr = ""
        return R()


def test_prepare_worktree_resets_then_adds_on_branch(tmp_path):
    cfg = Config.default()
    fake = FakeRunner()
    result = prepare_worktree(cfg, runner=fake)

    assert result == cfg.worktree_path
    joined = [" ".join(c[0]) for c in fake.calls]
    # 1) alten Worktree entfernen (force, darf fehlschlagen -> check=False)
    assert any("worktree remove" in j and "--force" in j for j in joined)
    # 2) neuen Worktree auf dem Agenten-Branch anlegen
    assert any(
        "worktree add" in j and cfg.branch in j for j in joined
    )
    # Alle git-Aufrufe laufen gegen das Academy-Repo, nie woanders
    for cmd, _ in fake.calls:
        assert cmd[0] == "git"
        assert "-C" in cmd
        assert cmd[cmd.index("-C") + 1] == str(cfg.academy_repo)


def test_prepare_worktree_remove_failure_is_tolerated():
    cfg = Config.default()

    class FlakyRemove:
        def __init__(self):
            self.calls = []

        def __call__(self, cmd, **kwargs):
            self.calls.append(cmd)

            class R:
                returncode = 1 if "remove" in cmd else 0
                stdout = ""
                stderr = "no such worktree"
            # remove wird mit check=False aufgerufen -> kein Raise erwartet
            if kwargs.get("check") and R.returncode != 0:
                raise AssertionError("remove darf nicht check=True sein")
            return R()

    flaky = FlakyRemove()
    prepare_worktree(cfg, runner=flaky)  # darf nicht werfen
