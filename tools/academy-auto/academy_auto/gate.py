from __future__ import annotations

import re
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


GATE_TIMEOUT = 180


@dataclass
class StepMeasure:
    cmd: list[str]
    count: int


@dataclass
class GateMeasure:
    steps: list[StepMeasure]
    total: int


def _count_step_errors(cmd, output: str, returncode: int) -> int:
    joined = " ".join(cmd)
    text = output or ""
    if "tsc" in joined:
        m = re.search(r"Found (\d+) error", text)
        if m:
            return int(m.group(1))
        n = len(re.findall(r"error TS\d+", text))
        return n if n else (0 if returncode == 0 else 1)
    if "test" in joined:  # jest
        m = re.search(r"(\d+) failed", text)
        if m:
            return int(m.group(1))
        return 0 if returncode == 0 else 1
    # lint
    m = re.search(r"(\d+) error", text)
    if m:
        return int(m.group(1))
    return 0 if returncode == 0 else 1


def measure_gate(cfg: Config, cwd, runner=subprocess.run) -> GateMeasure:
    """Alle Gate-Schritte ausführen (kein fail-fast) und Fehler je Schritt zählen."""
    steps: list[StepMeasure] = []
    for cmd in cfg.gate_commands:
        try:
            proc = runner(cmd, cwd=str(cwd), capture_output=True, text=True, check=False, timeout=GATE_TIMEOUT)
        except Exception:
            # Timeout / Crash eines Schritts: als „mindestens ein Fehler" werten (nie grün fälschen)
            steps.append(StepMeasure(cmd=cmd, count=1))
            continue
        output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
        steps.append(StepMeasure(cmd=cmd, count=_count_step_errors(cmd, output, proc.returncode)))
    total = sum(s.count for s in steps)
    return GateMeasure(steps=steps, total=total)
