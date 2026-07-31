from __future__ import annotations

import argparse
from dataclasses import dataclass

from .config import Config
from .gate import delta_decision
from .pending import PendingRecord
from .risk import GREEN, classify
from .scope import check_scope


@dataclass
class RunReport:
    status: str  # "paused" | "awaiting_approval" | "committed" | "discarded" | "impl_failed" | "nothing_to_do" | "error"


def run_once(cfg: Config, task_prompt, deps) -> RunReport:
    """Pause → Freigabe-Sperre → [Top-Level-Schutz] → Worktree → Baseline → Triage → Impl → Delta → Scope → Cap → Commit+Park."""
    if cfg.pause_flag.exists():
        return RunReport(status="paused")
    # Vor allem anderen, insbesondere vor prepare_worktree: dessen
    # `reset --hard <base_branch>` wuerde Arbeit vernichten, die noch nicht in
    # main gelandet ist — sei es ein Commit, der auf Walters Telegram-✅ wartet,
    # oder ein bereits freigegebener, dessen PR noch offen ist (dort wuerde das
    # spaetere `git push -f` des Executors den PR-Inhalt ersetzen).
    # Auch NICHT parken — pending.json traegt die run_ts, auf die die Buttons
    # zeigen (executor prueft ref_run_ts); ein neuer Datensatz wuerde die
    # Freigabe entwerten.
    if deps.awaiting_approval(cfg):
        return RunReport(status="awaiting_approval")
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
    """Arbeitet bis zu `max_tasks_per_run` Aufgaben ab.

    Grüne Aufgaben (siehe risk.py) landen ohne Rückfrage in main; danach geht
    es mit der nächsten weiter. Eine gelbe Aufgabe beendet den Lauf: sie wartet
    auf Walters ✅, und solange sie auf dem Branch liegt, ist der ohnehin durch
    die Freigabe-Sperre blockiert.

    Geparkt wird genau EINMAL, am Ende, als Zusammenfassung des ganzen Laufs —
    pending.json ist die Grundlage des 08:00-Digests und trägt die run_ts, auf
    die die Telegram-Buttons zeigen.
    """
    explicit = task_prompt is not None
    rounds = 1 if explicit else max(1, cfg.max_tasks_per_run)

    landed: list[str] = []
    cwd = None
    status = "nothing_to_do"
    pending_change = False
    task = reason = note = ""
    tsc_delta = 0

    for _ in range(rounds):
        cwd = deps.prepare_worktree(cfg)
        baseline = deps.measure_gate(cfg, cwd)

        pick = None
        if explicit:
            task, reason = task_prompt, ""
        else:
            pick = deps.triage_and_pick(cfg, cwd, baseline.total > 0)
            if pick is None:
                if not landed:
                    status = "nothing_to_do"
                    task = reason = note = ""
                break
            task, reason = pick.task_prompt, pick.reason

        outcome = deps.implement_task(cfg, cwd, task)
        if not outcome.ok:
            # Fehlerausgabe mitschicken: bei einem Nachtlauf ist der geparkte
            # Datensatz die einzige Spur, warum die Umsetzung scheiterte.
            detail = (outcome.output or "").strip()[-600:] or "(keine Ausgabe)"
            status = "impl_failed"
            note = f"Umsetzung fehlgeschlagen\nFehlerausgabe: {detail}"
            _after_task(deps, cfg, cwd, pick, "impl_failed")
            continue

        after = deps.measure_gate(cfg, cwd)
        delta = delta_decision(baseline, after)
        note = delta.note
        if not delta.passed:
            status = "discarded"
            _after_task(deps, cfg, cwd, pick, "discarded")
            continue

        changed = deps.list_changed_files(cfg, cwd)
        scope = check_scope(cfg, changed)
        if not scope.ok:
            status = "discarded"
            note = delta.note + "\nScope-Verletzung: " + ", ".join(scope.violations)
            _after_task(deps, cfg, cwd, pick, "discarded")
            continue

        lines = deps.count_diff_lines(cfg, cwd)
        if lines > cfg.max_diff_lines:
            status = "discarded"
            note = delta.note + f"\nDiff-Cap überschritten: {lines} > {cfg.max_diff_lines}"
            _after_task(deps, cfg, cwd, pick, "discarded")
            continue

        deps.commit_and_pr(cfg, cwd, task)
        risk = classify(cfg, changed, lines)

        if risk.level != GREEN:
            # Gelb: Branch bleibt stehen und wartet auf ✅. Weiterarbeiten ginge
            # nicht — der nächste Lauf wäre durch die Freigabe-Sperre blockiert.
            status = "committed"
            pending_change = True
            tsc_delta = baseline.total - after.total
            note = delta.note + f"\nFreigabe nötig: {risk.reason}"
            _after_task(deps, cfg, cwd, pick, "committed")
            break

        res = deps.land(cfg, cwd)
        _after_task(deps, cfg, cwd, pick, "committed" if res.ok else "discarded")
        if not res.ok:
            # Merge schiefgegangen oder auf main rot und zurückgenommen: der
            # Zustand von main ist nicht mehr der, auf dem die Baseline stand.
            status = "land_failed"
            note = res.note
            break
        landed.append(f"{res.merge_sha[:7]} {task}".strip())
        status = "landed"

    if pending_change:
        outcome_name = "committed"
    elif landed:
        outcome_name = "landed"
    else:
        outcome_name = status

    deps.park(cfg, PendingRecord(
        run_ts=deps.now_ts(),
        outcome=outcome_name,
        task=task if (pending_change or not landed) else "",
        reason=reason if (pending_change or not landed) else "",
        gate_note=note,
        branch_sha=deps.branch_sha(cfg, cwd) if pending_change else "",
        has_change=pending_change,
        tsc_delta=tsc_delta,
        quarantined=deps.quarantined(cfg),
        landed=landed,
    ))
    return RunReport(status=outcome_name if not pending_change else "committed")


def _after_task(deps, cfg, cwd, pick, status) -> None:
    """Triage-Ergebnis festhalten und den Worktree für die nächste Runde säubern."""
    if pick is not None:
        deps.record_triage_outcome(cfg, pick.chosen_key, status)
    if status in ("impl_failed", "discarded"):
        deps.reset_worktree(cfg, cwd)


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
        awaiting_approval=_awaiting_approval,
        land=_land,
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


def _awaiting_approval(cfg):  # pragma: no cover - echte git-Abfrage beim Deploy
    from .approval import has_unmerged_commit
    return has_unmerged_commit(cfg)


def _land(cfg, cwd):  # pragma: no cover - echter push/gh-Aufruf beim Deploy
    from .landing import land
    return land(cfg, cwd)


def _reset_worktree(cfg, cwd):  # pragma: no cover - echter Git-Reset beim Deploy
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "reset", "--hard"], check=False)
    subprocess.run(["git", "-C", str(cwd), "clean", "-fd"], check=False)


if __name__ == "__main__":  # pragma: no cover
    main()
