from __future__ import annotations

import argparse
from dataclasses import dataclass

from .config import Config
from .gate import delta_decision
from .report import build_digest, build_nothing_digest
from .scope import check_scope


@dataclass
class RunReport:
    status: str  # "paused" | "committed" | "discarded" | "impl_failed" | "nothing_to_do" | "dry_run" | "error"


def run_once(cfg: Config, task_prompt, deps) -> RunReport:
    """Pause → [Top-Level-Schutz] → Worktree → Baseline → Triage → Impl → Delta → Scope → Cap → Commit/Trockenlauf."""
    if cfg.pause_flag.exists():
        return RunReport(status="paused")
    try:
        return _run_once_inner(cfg, task_prompt, deps)
    except Exception as exc:
        try:
            deps.send_digest(f"🎓 Academy-Auto — unerwarteter Fehler\n\n{exc}")
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
            deps.send_digest(build_nothing_digest(quar))
            return RunReport(status="nothing_to_do")
        task_prompt = pick.task_prompt
    reason = pick.reason if pick is not None else ""

    outcome = deps.implement_task(cfg, cwd, task_prompt)
    if not outcome.ok:
        # Fehlerausgabe mitschicken: bei einem Nachtlauf ist der Digest die
        # einzige Spur, warum die Umsetzung scheiterte.
        detail = (outcome.output or "").strip()[-600:] or "(keine Ausgabe)"
        deps.send_digest(build_digest(
            task_prompt, outcome, None, committed=False, reason=reason, quarantined=quar,
            gate_note=f"Umsetzung fehlgeschlagen\nFehlerausgabe: {detail}",
        ))
        return _finalize(deps, cfg, cwd, pick, "impl_failed")

    after = deps.measure_gate(cfg, cwd)
    delta = delta_decision(baseline, after)
    if not delta.passed:
        deps.send_digest(build_digest(task_prompt, outcome, None, committed=False, reason=reason, quarantined=quar, gate_note=delta.note))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    changed = deps.list_changed_files(cfg, cwd)
    scope = check_scope(cfg, changed)
    if not scope.ok:
        deps.send_digest(build_digest(task_prompt, outcome, None, committed=False, scope_violations=scope.violations, reason=reason, quarantined=quar, gate_note=delta.note))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    lines = deps.count_diff_lines(cfg, cwd)
    if lines > cfg.max_diff_lines:
        deps.send_digest(build_digest(task_prompt, outcome, None, committed=False, cap_exceeded=True, reason=reason, quarantined=quar, gate_note=delta.note))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    if cfg.dry_run_flag.exists():
        summary = f"{len(changed)} Dateien, {lines} Zeilen"
        deps.send_digest(build_digest(
            task_prompt, outcome, None, committed=False, reason=reason, quarantined=quar,
            gate_note=delta.note,
            result_override=f"TROCKENLAUF — hätte committet ({summary})",
        ))
        deps.reset_worktree(cfg, cwd)   # nichts bleibt liegen; KEINE State-Verbuchung
        return RunReport(status="dry_run")

    deps.commit_and_pr(cfg, cwd, task_prompt)
    deps.send_digest(build_digest(task_prompt, outcome, None, committed=True, reason=reason, quarantined=quar, gate_note=delta.note))
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
        measure_gate=lambda cfg, cwd: gate.measure_gate(cfg, cwd),
        commit_and_pr=_commit_and_pr,
        send_digest=_send_digest_default,
        count_diff_lines=_count_diff_lines,
        list_changed_files=_list_changed_files,
        triage_and_pick=lambda cfg, cwd, baseline_red: _triage_and_pick(cfg, cwd, baseline_red),
        record_triage_outcome=_record_triage_outcome,
        reset_worktree=_reset_worktree,
        quarantined=_quarantined,
    )


def _send_digest_default(text):  # pragma: no cover - echter Versand beim Deploy
    from . import notify
    print(text)              # immer ins launchd-Log
    notify.send_digest(text)  # fail-soft nach Telegram


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
