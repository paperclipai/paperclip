import os
from pathlib import Path
from academy_auto.config import Config
from academy_auto.sandbox import build_profile, write_profile, wrap_command


def _cfg(tmp_path, **over):
    base = Config.default().__dict__
    base.update({"worktree_path": tmp_path / "wt"}, **over)
    return Config(**base)


def test_build_profile_allows_worktree_write_and_denies_secrets(tmp_path):
    cfg = Config(**{**Config.default().__dict__,
                    "worktree_path": tmp_path / "wt",
                    "secret_read_paths": (str(tmp_path / "secret"),)})
    prof = build_profile(cfg)
    wt_real = os.path.realpath(str(tmp_path / "wt"))
    assert "(version 1)" in prof
    assert "(allow default)" in prof
    assert "(deny file-write*)" in prof
    assert f'(subpath "{wt_real}")' in prof  # Worktree schreibbar
    assert "file-read*" in prof and os.path.realpath(str(tmp_path / "secret")) in prof  # Secret gesperrt
    # ~/.claude ist NICHT in der Read-Deny-Liste
    claude_dir = os.path.realpath(str(Path.home() / ".claude"))
    # der Deny-Block darf ~/.claude nicht enthalten
    deny_section = prof.split("deny file-read*")[1] if "deny file-read*" in prof else ""
    assert claude_dir not in deny_section


def test_build_profile_worktree_reallowed_last(tmp_path):
    cfg = _cfg(tmp_path)
    prof = build_profile(cfg)
    # die Worktree-Read-Allow steht NACH dem Read-Deny (last-match-wins)
    assert prof.index("deny file-read*") < prof.rindex("allow file-read*")


def test_write_profile_creates_readable_file(tmp_path):
    cfg = _cfg(tmp_path)
    p = write_profile(cfg)
    assert Path(p).exists()
    assert "(version 1)" in Path(p).read_text()


def test_wrap_command_structure(tmp_path):
    cfg = _cfg(tmp_path)
    wrapped = wrap_command(cfg, ["claude", "-p", "tu was"], "/tmp/prof.sb")
    assert wrapped[:3] == ["sandbox-exec", "-f", "/tmp/prof.sb"]
    assert wrapped[3:] == ["claude", "-p", "tu was"]


def test_config_default_has_sandbox_fields():
    cfg = Config.default()
    assert isinstance(cfg.secret_read_paths, tuple)
    assert isinstance(cfg.sandbox_write_paths, tuple)
    assert any(".ssh" in p for p in cfg.secret_read_paths)


def test_default_config_worktree_reallow_after_paperclip_deny():
    # Worktree liegt real unter ~/.paperclip (read-denied) -> muss per last-match-wins wieder lesbar sein
    cfg = Config.default()
    prof = build_profile(cfg)
    wt_real = os.path.realpath(str(cfg.worktree_path))
    pp_real = os.path.realpath(str(Path.home() / ".paperclip"))
    assert pp_real in prof                                  # ~/.paperclip ist in der Deny-Liste
    assert wt_real.startswith(pp_real)                      # Worktree liegt tatsächlich darunter
    assert prof.index("deny file-read*") < prof.rindex(f'(subpath "{wt_real}")')  # Worktree-Reallow NACH dem Deny


def test_each_sandbox_write_path_appears_in_profile():
    cfg = Config.default()
    prof = build_profile(cfg)
    for w in cfg.sandbox_write_paths:
        assert os.path.realpath(w) in prof
