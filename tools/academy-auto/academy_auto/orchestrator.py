from __future__ import annotations

import argparse
from dataclasses import dataclass

from .config import Config
from .report import build_digest


@dataclass
class RunReport:
    status: str  # "paused" | "committed" | "discarded" | "impl_failed"


def run_once(cfg: Config, task_prompt: str, deps) -> RunReport:
    """Ein Lauf: Pause-Check → Worktree → Implementieren → Gate → Commit/Digest."""
    if cfg.pause_flag.exists():
        return RunReport(status="paused")

    cwd = deps.prepare_worktree(cfg)

    outcome = deps.implement_task(cfg, cwd, task_prompt)
    if not outcome.ok:
        deps.send_digest(build_digest(task_prompt, outcome, _empty_gate(), committed=False))
        return RunReport(status="impl_failed")

    gate = deps.run_gate(cfg, cwd)
    if not gate.passed:
        deps.send_digest(build_digest(task_prompt, outcome, gate, committed=False))
        return RunReport(status="discarded")

    lines = deps.count_diff_lines(cfg, cwd)
    if lines > cfg.max_diff_lines:
        deps.send_digest(build_digest(task_prompt, outcome, gate, committed=False, cap_exceeded=True))
        return RunReport(status="discarded")

    deps.commit_and_pr(cfg, cwd, task_prompt)
    deps.send_digest(build_digest(task_prompt, outcome, gate, committed=True))
    return RunReport(status="committed")


def _empty_gate():
    from .gate import GateResult
    return GateResult(passed=False, steps=[])


def main() -> None:  # pragma: no cover - CLI-Verdrahtung
    parser = argparse.ArgumentParser(description="Academy-Auto Phase A")
    parser.add_argument("task_prompt", help="Aufgabe für Claude Code (Phase A: manuell)")
    args = parser.parse_args()

    from . import worktree, gate, runner, report

    cfg = Config.default()
    deps = _build_default_deps(worktree, gate, runner, report)
    result = run_once(cfg, args.task_prompt, deps)
    print(result.status)


def _build_default_deps(worktree, gate, runner, report):  # pragma: no cover
    from types import SimpleNamespace
    return SimpleNamespace(
        prepare_worktree=lambda cfg: worktree.prepare_worktree(cfg),
        implement_task=lambda cfg, cwd, prompt: runner.implement_task(cfg, cwd, prompt),
        run_gate=lambda cfg, cwd: gate.run_gate(cfg, cwd),
        commit_and_pr=_commit_and_pr,
        send_digest=lambda text: report.send_digest(text, sender=print),
        count_diff_lines=_count_diff_lines,
    )


def _count_diff_lines(cfg, cwd):  # pragma: no cover - echte Git-Messung beim Deploy
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "add", "-A"], check=True)
    proc = subprocess.run(
        ["git", "-C", str(cwd), "diff", "--cached", "--numstat"],
        cwd=str(cwd), capture_output=True, text=True, check=False,
    )
    total = 0
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            for n in parts[:2]:
                if n.isdigit():
                    total += int(n)
    return total


def _commit_and_pr(cfg, cwd, prompt):  # pragma: no cover - echte Git-/gh-Anbindung beim Deploy
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(cwd), "commit", "-m", f"feat(academy-auto): {prompt}"], check=True)
    return True


if __name__ == "__main__":  # pragma: no cover
    main()
