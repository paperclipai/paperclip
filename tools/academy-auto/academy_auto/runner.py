from __future__ import annotations

import subprocess
from dataclasses import dataclass

from .config import Config

# Headless-Aufruf der Claude Code CLI. Zentral hier anpassbar, falls sich
# CLI-Flags ändern. acceptEdits erlaubt autonome Dateiänderungen im Worktree.
CLAUDE_CMD = ["claude", "-p", "--permission-mode", "acceptEdits"]


@dataclass
class RunOutcome:
    ok: bool
    output: str


def implement_task(cfg: Config, cwd, task_prompt: str, runner=subprocess.run) -> RunOutcome:
    """Claude Code headless im isolierten Worktree eine Aufgabe umsetzen lassen."""
    cmd = CLAUDE_CMD + [task_prompt]
    proc = runner(cmd, cwd=str(cwd), capture_output=True, text=True, check=False)
    output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
    return RunOutcome(ok=(proc.returncode == 0), output=output.strip())
