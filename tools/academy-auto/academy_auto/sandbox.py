from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from .config import Config

_DEVICE_WRITES = ("/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/random", "/dev/urandom")


def _real(p) -> str:
    return os.path.realpath(str(p))


def build_profile(cfg: Config) -> str:
    """SBPL-Profil: Schreiben nur im Worktree (+ Caches), Secrets nicht lesbar."""
    wt = _real(cfg.worktree_path)
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        f'(allow file-write* (subpath "{wt}"))',
    ]
    for w in cfg.sandbox_write_paths:
        lines.append(f'(allow file-write* (subpath "{_real(w)}"))')
    dev = " ".join(f'(path "{d}")' for d in _DEVICE_WRITES)
    lines.append(f"(allow file-write-data {dev})")
    if cfg.secret_read_paths:
        denies = " ".join(f'(subpath "{_real(s)}")' for s in cfg.secret_read_paths)
        lines.append(f"(deny file-read* {denies})")
    # Worktree-Reads zuletzt wieder erlauben (liegt evtl. unter einem Deny-Pfad)
    lines.append(f'(allow file-read* (subpath "{wt}"))')
    return "\n".join(lines) + "\n"


def write_profile(cfg: Config) -> Path:
    fd, path = tempfile.mkstemp(prefix="academy-auto-sb-", suffix=".sb")
    with os.fdopen(fd, "w") as f:
        f.write(build_profile(cfg))
    return Path(path)


def wrap_command(cfg: Config, cmd, profile_path) -> list[str]:
    return ["sandbox-exec", "-f", str(profile_path), *cmd]


def sandbox_available(cfg: Config, runner=subprocess.run) -> bool:
    """True nur wenn sandbox-exec vorhanden UND das Profil sauber kompiliert (Dry-Run)."""
    profile = write_profile(cfg)
    try:
        proc = runner(
            ["sandbox-exec", "-f", str(profile), "/usr/bin/true"],
            capture_output=True, text=True, check=False, timeout=30,
        )
    except Exception:
        return False
    return getattr(proc, "returncode", 1) == 0
