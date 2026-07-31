from pathlib import Path
from academy_auto.config import Config
from academy_auto.worktree import (
    prepare_worktree, ensure_dependencies, WORKTREE_TIMEOUT, NPM_INSTALL_TIMEOUT,
)


class Rec:
    """Runner-Attrappe: zeichnet Kommandos auf, steuert rev-parse-Ergebnis."""
    def __init__(self, worktree_valid: bool):
        self.calls = []
        self.worktree_valid = worktree_valid

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        rc = 0
        if "rev-parse" in cmd:
            rc = 0 if self.worktree_valid else 128
        class R:
            returncode = rc
            stdout = ""
            stderr = ""
        return R()

    def joined(self):
        return [" ".join(c) for c, _ in self.calls]


def _cfg(tmp_path, **over):
    base = dict(Config.default().__dict__)
    base["worktree_path"] = tmp_path / "wt"
    base.update(over)
    return Config(**base)


def test_existing_worktree_is_refreshed_in_place(tmp_path):
    wt = tmp_path / "wt"; (wt / "node_modules").mkdir(parents=True)
    (wt / "node_modules" / "x").write_text("1")
    cfg = _cfg(tmp_path)
    rec = Rec(worktree_valid=True)
    prepare_worktree(cfg, runner=rec)
    j = rec.joined()
    assert any("reset --hard" in x and cfg.base_branch in x for x in j)
    assert any("clean -fd" in x for x in j)
    assert not any("worktree add" in x for x in j)      # NICHT neu erzeugt
    assert not any(" -fdx" in x for x in j)             # niemals -x: wuerde node_modules loeschen


def test_missing_worktree_is_created(tmp_path):
    cfg = _cfg(tmp_path)
    rec = Rec(worktree_valid=False)
    prepare_worktree(cfg, runner=rec)
    j = rec.joined()
    assert any("worktree remove --force" in x for x in j)
    assert any("worktree add -B" in x and cfg.branch in x for x in j)
    assert not any("reset --hard" in x for x in j)


def test_all_git_calls_use_repo_or_worktree_and_timeout(tmp_path):
    cfg = _cfg(tmp_path)
    rec = Rec(worktree_valid=True)
    prepare_worktree(cfg, runner=rec)
    for cmd, kwargs in rec.calls:
        if cmd[0] == "git":
            assert "-C" in cmd
            assert cmd[cmd.index("-C") + 1] in (str(cfg.academy_repo), str(cfg.worktree_path))
            assert kwargs.get("timeout") == WORKTREE_TIMEOUT


def test_ensure_dependencies_skips_when_present(tmp_path):
    wt = tmp_path / "wt"; (wt / "node_modules").mkdir(parents=True)
    (wt / "node_modules" / "pkg").write_text("x")
    cfg = _cfg(tmp_path)
    called = []
    def runner(cmd, **k):
        called.append(cmd)
        class R: returncode = 0; stdout = ""; stderr = ""
        return R()
    assert ensure_dependencies(cfg, runner=runner) is True
    assert called == []                                  # kein npm ci noetig


def test_ensure_dependencies_installs_when_missing(tmp_path):
    wt = tmp_path / "wt"; wt.mkdir()
    cfg = _cfg(tmp_path)
    seen = {}
    def runner(cmd, **k):
        seen["cmd"] = cmd; seen["timeout"] = k.get("timeout"); seen["cwd"] = k.get("cwd")
        class R: returncode = 0; stdout = ""; stderr = ""
        return R()
    assert ensure_dependencies(cfg, runner=runner) is True
    assert seen["cmd"] == list(cfg.npm_install_cmd)
    assert seen["timeout"] == NPM_INSTALL_TIMEOUT
    assert seen["cwd"] == str(wt)


def test_ensure_dependencies_fail_soft(tmp_path):
    (tmp_path / "wt").mkdir()
    cfg = _cfg(tmp_path)
    def boom(cmd, **k):
        raise OSError("npm weg")
    assert ensure_dependencies(cfg, runner=boom) is False


def test_config_has_base_branch():
    assert Config.default().base_branch == "main"


def test_ensure_dependencies_uses_configured_install_cmd(tmp_path):
    """Das Install-Kommando kommt aus der Config (Repo braucht --legacy-peer-deps)."""
    (tmp_path / "wt").mkdir()
    cfg = _cfg(tmp_path)
    seen = {}

    def runner(cmd, **k):
        seen["cmd"] = cmd
        class R:
            returncode = 0
            stdout = ""
            stderr = ""
        return R()

    assert ensure_dependencies(cfg, runner=runner) is True
    assert seen["cmd"] == list(cfg.npm_install_cmd)
    assert "--legacy-peer-deps" in seen["cmd"]


def test_config_npm_install_cmd_default():
    assert Config.default().npm_install_cmd == ("npm", "ci", "--legacy-peer-deps")


def test_reset_targets_the_remote_branch_not_the_stale_local_one(tmp_path):
    """`gh pr merge` (landing.py) mergt auf GitHub — der LOKALE main-Zeiger
    wandert dabei nicht mit. Ein Reset auf `main` setzt den Worktree deshalb
    auf einen veralteten Stand zurueck: der Implementierer sieht die eigene
    Arbeit der Vorrunde nicht mehr, und das Gate misst den falschen Baum.
    Live beobachtet am 31.07. (Web-Lauf: lokal b91044f, origin 85784ff).
    """
    wt = tmp_path / "wt"; (wt / "node_modules").mkdir(parents=True)
    (wt / "node_modules" / "x").write_text("1")
    cfg = _cfg(tmp_path)
    rec = Rec(worktree_valid=True)
    prepare_worktree(cfg, runner=rec)
    j = rec.joined()
    assert any("fetch" in x for x in j), "ohne fetch ist auch origin/main veraltet"
    assert any(f"reset --hard origin/{cfg.base_branch}" in x for x in j)
