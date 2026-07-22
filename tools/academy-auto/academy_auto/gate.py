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
    ok: bool = True


@dataclass
class DeltaResult:
    passed: bool
    mode: str   # "absolut" | "delta"
    note: str


def delta_decision(baseline: GateMeasure, after: GateMeasure) -> DeltaResult:
    """Absolutes Gate bei grüner Baseline, sonst Delta (weniger Fehler + kein Schritt schlechter)."""
    if not after.ok:
        mode = "delta" if baseline.total > 0 else "absolut"
        return DeltaResult(False, mode, "rot (After-Messung unbrauchbar: Timeout/Crash)")
    if baseline.total == 0:
        if after.total == 0:
            return DeltaResult(True, "absolut", "grün (absolut)")
        return DeltaResult(False, "absolut", f"rot (Fehler: {after.total})")
    base_by = {tuple(s.cmd): s.count for s in baseline.steps}
    no_regression = all(s.count <= base_by.get(tuple(s.cmd), 0) for s in after.steps)
    improved = after.total < baseline.total
    if no_regression and improved:
        return DeltaResult(True, "delta", f"Delta grün (Fehler {baseline.total}→{after.total})")
    return DeltaResult(False, "delta", f"rot (Fehler {baseline.total}→{after.total}, kein Fortschritt)")


def _count_step_errors(cmd, output: str, returncode: int) -> int:
    joined = " ".join(cmd)
    text = output or ""
    if "tsc" in joined:
        m = re.search(r"Found (\d+) error", text)
        parsed = int(m.group(1)) if m else len(re.findall(r"error TS\d+", text))
    elif "test" in joined:  # jest
        m = re.search(r"(\d+) failed", text)
        parsed = int(m.group(1)) if m else 0
    else:  # lint
        m = re.search(r"(\d+) error", text)
        parsed = int(m.group(1)) if m else 0
    return max(parsed, 1 if returncode != 0 else 0)


def measure_gate(cfg: Config, cwd, runner=subprocess.run) -> GateMeasure:
    """Alle Gate-Schritte ausführen (kein fail-fast) und Fehler je Schritt zählen."""
    steps: list[StepMeasure] = []
    ok = True
    for cmd in cfg.gate_commands:
        try:
            proc = runner(cmd, cwd=str(cwd), capture_output=True, text=True, check=False, timeout=GATE_TIMEOUT)
        except Exception:
            # Timeout / Crash eines Schritts: als „mindestens ein Fehler" werten (nie grün fälschen)
            steps.append(StepMeasure(cmd=cmd, count=1))
            ok = False
            continue
        output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
        steps.append(StepMeasure(cmd=cmd, count=_count_step_errors(cmd, output, proc.returncode)))
    total = sum(s.count for s in steps)
    return GateMeasure(steps=steps, total=total, ok=ok)
