from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass

from .config import Config

# Headless-Aufruf der Claude Code CLI. Zentral hier anpassbar, falls sich
# CLI-Flags ändern. acceptEdits erlaubt autonome Dateiänderungen im Worktree.
# Implementierer fest auf opus: er schreibt echten Code, der spaeter committet
# wird — hier zaehlt Qualitaet. Explizit gepinnt, damit ein geaenderter
# CLI-Standard (/model) den Nachtlauf nicht still mitzieht.
CLAUDE_CMD = ["claude", "-p", "--model", "opus", "--permission-mode", "acceptEdits"]

# Obergrenze für einen Implementierungslauf. Ein hängender claude darf den
# Orchestrator nicht blockieren; TimeoutExpired wird unten fail-soft gefangen.
IMPLEMENT_TIMEOUT = 1800


@dataclass
class RunOutcome:
    ok: bool
    output: str


def implement_task(
    cfg: Config,
    cwd,
    task_prompt: str,
    runner=subprocess.run,
    available=None,
    make_profile=None,
    wrap=None,
) -> RunOutcome:
    """Claude Code headless im isolierten Worktree — ausschließlich in der sandbox-exec-Kapsel.

    Fail-closed: Ist die Sandbox nicht startbar, wird claude gar nicht ausgeführt.
    """
    from . import sandbox as _sb

    available = available or _sb.sandbox_available
    make_profile = make_profile or _sb.write_profile
    wrap = wrap or _sb.wrap_command

    if not available(cfg):
        return RunOutcome(
            ok=False,
            output="Sandbox nicht startbar (fail-closed) — Lauf abgebrochen, claude wurde nicht gestartet.",
        )

    profile = None
    try:
        profile = make_profile(cfg)
        cmd = wrap(cfg, CLAUDE_CMD + [task_prompt], str(profile))
        proc = runner(
            cmd, cwd=str(cwd), capture_output=True, text=True, check=False,
            timeout=IMPLEMENT_TIMEOUT, stdin=subprocess.DEVNULL,
        )
        output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
        return RunOutcome(ok=(proc.returncode == 0), output=output.strip())
    except Exception as exc:
        return RunOutcome(ok=False, output=f"Sandbox-Lauf fehlgeschlagen: {exc}")
    finally:
        if profile is not None:
            try:
                os.unlink(profile)
            except OSError:
                pass
