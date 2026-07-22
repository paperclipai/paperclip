import os
import shutil
import subprocess
from pathlib import Path
import pytest
from academy_auto.config import Config
from academy_auto.sandbox import build_profile, write_profile, wrap_command, sandbox_available


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


def test_sandbox_available_false_when_tool_missing(tmp_path):
    cfg = _cfg(tmp_path)
    def no_tool(*a, **k):
        raise FileNotFoundError("sandbox-exec not found")
    assert sandbox_available(cfg, runner=no_tool) is False


def test_sandbox_available_true_on_clean_dryrun(tmp_path):
    cfg = _cfg(tmp_path)
    def ok(*a, **k):
        class R:
            returncode = 0
        return R()
    assert sandbox_available(cfg, runner=ok) is True


def test_sandbox_available_false_on_bad_profile(tmp_path):
    cfg = _cfg(tmp_path)
    def rc1(*a, **k):
        class R:
            returncode = 1
        return R()
    assert sandbox_available(cfg, runner=rc1) is False


@pytest.mark.skipif(shutil.which("sandbox-exec") is None, reason="sandbox-exec nicht verfügbar")
def test_generated_profile_really_isolates(tmp_path):
    wt = tmp_path / "wt"; wt.mkdir()
    secret = tmp_path / "secret"; secret.mkdir()
    (secret / "token.txt").write_text("TOPSECRET")
    outside = tmp_path / "outside"; outside.mkdir()
    # NUR der Worktree ist schreibbar (Caches leer), Secret-Pfad gesperrt
    cfg = Config(**{**Config.default().__dict__,
                    "worktree_path": wt,
                    "sandbox_write_paths": (),
                    "secret_read_paths": (str(secret),)})
    profile = write_profile(cfg)

    def sb(bash):
        return subprocess.run(
            wrap_command(cfg, ["/bin/bash", "-c", bash], str(profile)),
            capture_output=True, text=True,
        )

    # Schreiben IM Worktree: erlaubt
    r = sb(f'echo x > "{wt}/a.txt" && echo WROTE')
    assert "WROTE" in r.stdout and (wt / "a.txt").exists()
    # Schreiben AUSSERHALB: blockiert
    r = sb(f'echo x > "{outside}/b.txt" 2>/dev/null && echo LEAK || echo BLOCKED')
    assert "BLOCKED" in r.stdout
    assert not (outside / "b.txt").exists()
    # Secret LESEN: verweigert
    r = sb(f'cat "{secret}/token.txt" 2>/dev/null && echo READ || echo DENIED')
    assert "DENIED" in r.stdout
    assert "TOPSECRET" not in r.stdout


def test_config_secret_read_paths_include_common_credential_stores():
    cfg = Config.default()
    joined = " ".join(cfg.secret_read_paths)
    for needle in [".netrc", ".git-credentials", ".npmrc", ".gnupg", "Keychains"]:
        assert needle in joined


def test_build_profile_denies_write_to_dangerous_claude_paths():
    cfg = Config.default()
    prof = build_profile(cfg)
    settings_real = os.path.realpath(str(Path.home() / ".claude/settings.json"))
    scripts_real = os.path.realpath(str(Path.home() / ".claude/scripts"))
    assert f'deny file-write* (subpath "{scripts_real}")' in prof or f'deny file-write* (subpath "{scripts_real}") (path "{scripts_real}")' in prof
    assert settings_real in prof.split("deny file-read*")[0]  # als write-deny, vor dem read-Block
    # der Schutz-Deny steht NACH dem ~/.claude-write-allow (last-match-wins)
    claude_allow = os.path.realpath(str(Path.home() / ".claude"))
    assert prof.index(f'allow file-write* (subpath "{claude_allow}")') < prof.rindex(settings_real)


def test_sandbox_available_fail_soft_when_write_profile_raises(tmp_path, monkeypatch):
    from academy_auto import sandbox as sbmod
    cfg = _cfg(tmp_path)
    def boom(cfg):
        raise OSError("tempdir kaputt")
    monkeypatch.setattr(sbmod, "write_profile", boom)
    assert sbmod.sandbox_available(cfg, runner=lambda *a, **k: None) is False


@pytest.mark.skipif(shutil.which("sandbox-exec") is None, reason="sandbox-exec nicht verfügbar")
def test_protected_claude_paths_really_write_blocked(tmp_path):
    claude = tmp_path / "claude"; (claude / "projects").mkdir(parents=True); (claude / "scripts").mkdir()
    wt = tmp_path / "wt"; wt.mkdir()
    cfg = Config(**{**Config.default().__dict__,
                    "worktree_path": wt,
                    "sandbox_write_paths": (str(claude),),
                    "protected_write_paths": (str(claude / "settings.json"), str(claude / "scripts")),
                    "secret_read_paths": ()})
    profile = write_profile(cfg)
    def sb(bash):
        return subprocess.run(wrap_command(cfg, ["/bin/bash", "-c", bash], str(profile)), capture_output=True, text=True)
    # operativer ~/.claude-Unterpfad schreibbar
    r = sb(f'echo x > "{claude}/projects/p.txt" && echo OK'); assert "OK" in r.stdout
    # settings.json (Hook-Config) BLOCKIERT
    r = sb(f'echo evil > "{claude}/settings.json" 2>/dev/null && echo LEAK || echo BLOCKED'); assert "BLOCKED" in r.stdout
    assert not (claude / "settings.json").exists()
    # scripts/ BLOCKIERT
    r = sb(f'echo evil > "{claude}/scripts/x.sh" 2>/dev/null && echo LEAK || echo BLOCKED'); assert "BLOCKED" in r.stdout


def test_protected_write_paths_include_skills():
    from academy_auto.config import Config
    cfg = Config.default()
    assert any(p.endswith(".claude/skills") for p in cfg.protected_write_paths)
