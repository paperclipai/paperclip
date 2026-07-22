from __future__ import annotations

import subprocess
from dataclasses import dataclass, field

from .config import Config


@dataclass
class GateStep:
    cmd: list[str]
    returncode: int
    output: str


@dataclass
class GateResult:
    passed: bool
    steps: list[GateStep] = field(default_factory=list)


def run_gate(cfg: Config, cwd, runner=subprocess.run) -> GateResult:
    """Green-Gate im Worktree ausführen, fail-fast beim ersten roten Schritt."""
    steps: list[GateStep] = []
    for cmd in cfg.gate_commands:
        proc = runner(cmd, cwd=str(cwd), capture_output=True, text=True, check=False)
        output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
        steps.append(GateStep(cmd=cmd, returncode=proc.returncode, output=output))
        if proc.returncode != 0:
            return GateResult(passed=False, steps=steps)
    return GateResult(passed=True, steps=steps)
