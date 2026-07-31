from __future__ import annotations

import argparse
from dataclasses import dataclass

from .config import Config
from .gate import delta_decision
from .pending import PendingRecord
from .scope import check_scope


@dataclass
class RunReport:
    status: str  # "paused" | "committed" | "discarded" | "impl_failed" | "nothing_to_do" | "error"


def run_once(cfg: Config, task_prompt, deps) -> RunReport:
    """Pause → [Top-Level-Schutz] → Worktree → Baseline → Triage → Impl → Delta → Scope → Cap → Commit+Park."""
    if cfg.pause_flag.exists():
        return RunReport(status="paused")
    try:
        return _run_once_inner(cfg, task_prompt, deps)
    except Exception as exc:
        try:
            deps.park(cfg, PendingRecord(
                run_ts=deps.now_ts(), outcome="error", task=task_prompt or "", reason="",
                gate_note=f"unerwarteter Fehler\n\n{exc}", branch_sha="",
                has_change=False, tsc_delta=0, quarantined=[],
            ))
        except Exception:
            pass
        return RunReport(status="error")


def _run_once_inner(cfg: Config, task_prompt, deps) -> RunReport:
    cwd = deps.prepare_worktree(cfg)
    quar = deps.quarantined(cfg)

    baseline = deps.measure_gate(cfg, cwd)
    baseline_red = baseline.total > 0

    pick = None
    if task_prompt is None:
        pick = deps.triage_and_pick(cfg, cwd, baseline_red)
        if pick is None:
            deps.park(cfg, PendingRecord(
                run_ts=deps.now_ts(), outcome="nothing_to_do", task="", reason="",
                gate_note="", branch_sha="", has_change=False, tsc_delta=0,
                quarantined=quar,
            ))
            return RunReport(status="nothing_to_do")
        task_prompt = pick.task_prompt
    reason = pick.reason if pick is not None else ""

    outcome = deps.implement_task(cfg, cwd, task_prompt)
    if not outcome.ok:
        # Fehlerausgabe mitschicken: bei einem Nachtlauf ist der geparkte
        # Datensatz die einzige Spur, warum die Umsetzung scheiterte.
        detail = (outcome.output or "").strip()[-600:] or "(keine Ausgabe)"
        deps.park(cfg, PendingRecord(
            run_ts=deps.now_ts(), outcome="impl_failed", task=task_prompt, reason=reason,
            gate_note=f"Umsetzung fehlgeschlagen\nFehlerausgabe: {detail}",
            branch_sha="", has_change=False, tsc_delta=0, quarantined=quar,
        ))
        return _finalize(deps, cfg, cwd, pick, "impl_failed")

    after = deps.measure_gate(cfg, cwd)
    delta = delta_decision(baseline, after)
    tsc_delta = baseline.total - after.total
    if not delta.passed:
        deps.park(cfg, PendingRecord(
            run_ts=deps.now_ts(), outcome="discarded", task=task_prompt, reason=reason,
            gate_note=delta.note, branch_sha="", has_change=False, tsc_delta=0,
            quarantined=quar,
        ))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    changed = deps.list_changed_files(cfg, cwd)
    scope = check_scope(cfg, changed)
    if not scope.ok:
        note = delta.note + "\nScope-Verletzung: " + ", ".join(scope.violations)
        deps.park(cfg, PendingRecord(
            run_ts=deps.now_ts(), outcome="discarded", task=task_prompt, reason=reason,
            gate_note=note, branch_sha="", has_change=False, tsc_delta=0,
            quarantined=quar,
        ))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    lines = deps.count_diff_lines(cfg, cwd)
    if lines > cfg.max_diff_lines:
        note = delta.note + f"\nDiff-Cap überschritten: {lines} > {cfg.max_diff_lines}"
        deps.park(cfg, PendingRecord(
            run_ts=deps.now_ts(), outcome="discarded", task=task_prompt, reason=reason,
            gate_note=note, branch_sha="", has_change=False, tsc_delta=0,
            quarantined=quar,
        ))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    run_ts = deps.now_ts()
    deps.commit_and_pr(cfg, cwd, task_prompt)  # committet nur auf den Branch; PR erst bei Freigabe (executor.py)
    deps.park(cfg, PendingRecord(
        run_ts=run_ts, outcome="committed", task=task_prompt, reason=reason,
        gate_note=delta.note, branch_sha=deps.branch_sha(cfg, cwd),
        has_change=True, tsc_delta=tsc_delta, quarantined=quar,
    ))
    return _finalize(deps, cfg, cwd, pick, "committed")


def _finalize(deps, cfg, cwd, pick, status) -> RunReport:
    if pick is not None:
        deps.record_triage_outcome(cfg, pick.chosen_key, status)
    if status in ("impl_failed", "discarded"):
        deps.reset_worktree(cfg, cwd)
    return RunReport(status=status)


def _empty_gate():
    from .gate import GateResult
    return GateResult(passed=False, steps=[])


def main() -> None:  # pragma: no cover - CLI-Verdrahtung
    parser = argparse.ArgumentParser(description="Academy-Auto Phase A")
    parser.add_argument("task_prompt", nargs="?", default=None, help="Aufgabe (leer = Triage wählt selbst)")
    args = parser.parse_args()

    from . import worktree, gate, runner

    cfg = Config.default()
    deps = _build_default_deps(worktree, gate, runner)
    result = run_once(cfg, args.task_prompt, deps)
    print(result.status)


def _build_default_deps(worktree, gate, runner):  # pragma: no cover
    from types import SimpleNamespace
    return SimpleNamespace(
        prepare_worktree=lambda cfg: worktree.prepare_worktree(cfg),
        implement_task=lambda cfg, cwd, prompt: runner.implement_task(cfg, cwd, prompt),
        measure_gate=lambda cfg, cwd: gate.measure_gate(cfg, cwd),
        commit_and_pr=_commit_and_pr,
        park=lambda cfg, rec: _park_default(cfg, rec),
        branch_sha=lambda cfg, cwd: _branch_sha(cfg, cwd),
        now_ts=_now_ts,
        count_diff_lines=_count_diff_lines,
        list_changed_files=_list_changed_files,
        triage_and_pick=lambda cfg, cwd, baseline_red: _triage_and_pick(cfg, cwd, baseline_red),
        record_triage_outcome=_record_triage_outcome,
        reset_worktree=_reset_worktree,
        quarantined=_quarantined,
    )


def _park_default(cfg, rec):  # pragma: no cover - IO beim Deploy
    from . import pending
    print(f"[park] {rec.outcome} has_change={rec.has_change}")  # ins launchd-Log
    pending.write_pending(cfg.pending_path, rec)


def _branch_sha(cfg, cwd):
    import subprocess
    proc = subprocess.run(["git", "-C", str(cwd), "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=False)
    return proc.stdout.strip()


def _now_ts():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _count_diff_lines(cfg, cwd):
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


def _list_changed_files(cfg, cwd):
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "add", "-A"], check=True)
    proc = subprocess.run(
        ["git", "-C", str(cwd), "diff", "--cached", "--name-only"],
        cwd=str(cwd), capture_output=True, text=True, check=False,
    )
    return [line for line in proc.stdout.splitlines() if line]


def _commit_and_pr(cfg, cwd, prompt):
    # committet nur auf den Branch; PR erst bei Freigabe (executor.py)
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(cwd), "commit", "-m", f"feat(academy-auto): {prompt}"], check=True)
    return True


def _triage_and_pick(cfg, cwd, baseline_red):  # pragma: no cover - echte Triage beim Deploy
    from .triage.pick import triage_and_pick
    return triage_and_pick(cfg, cwd, baseline_red=baseline_red)


def _record_triage_outcome(cfg, key, status):
    from datetime import datetime, timezone
    from .triage.state import load_state, record_outcome, save_state
    state = load_state(cfg.triage_state_path)
    record_outcome(state, key, status, now=datetime.now(timezone.utc).isoformat())
    save_state(cfg.triage_state_path, state)


def _quarantined(cfg):
    from .triage.state import load_state, quarantined_keys
    return quarantined_keys(load_state(cfg.triage_state_path))


def _reset_worktree(cfg, cwd):  # pragma: no cover - echter Git-Reset beim Deploy
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "reset", "--hard"], check=False)
    subprocess.run(["git", "-C", str(cwd), "clean", "-fd"], check=False)


if __name__ == "__main__":  # pragma: no cover
    main()
