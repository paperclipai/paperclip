from __future__ import annotations

import subprocess
from dataclasses import dataclass

LAND_TIMEOUT = 300


@dataclass(frozen=True)
class LandResult:
    ok: bool
    note: str
    merge_sha: str = ""
    pr_url: str = ""
    reverted: bool = False


def _run(runner, cmd, cwd=None):
    """(returncode, stdout) — wirft nie."""
    try:
        proc = runner(cmd, cwd=cwd, capture_output=True, text=True,
                      check=False, timeout=LAND_TIMEOUT)
    except Exception as exc:
        return 1, f"{exc}"
    return getattr(proc, "returncode", 1), (getattr(proc, "stdout", "") or "")


def land(cfg, cwd, runner=subprocess.run, measure_gate=None) -> LandResult:
    """Gruene Aufgabe ohne Rueckfrage nach main bringen — mit Sicherheitsnetz.

    Ablauf: push → PR → merge → **Gate auf dem frisch gemergten main** →
    bei rot automatischer Revert.

    Warum die Nachpruefung noetig ist, obwohl das Gate den Branch schon grün
    gemessen hat: zwischen Baseline und Merge kann sich `main` bewegt haben
    (ein von Walter gemergter gelber PR, ein Handcommit). Zwei je fuer sich
    gruene Aenderungen koennen zusammen rot ergeben. Nur eine Messung auf dem
    tatsaechlich entstandenen main faengt das.

    Der Revert nimmt die gesamte Spanne `main_vorher..HEAD` zurueck, nicht nur
    einen Merge-Commit — damit ist er unabhaengig davon, ob gh einen
    Merge-Commit erzeugt oder vorgespult hat.

    Der Agenten-Branch wird NIE geloescht (kein `--delete-branch`): die
    Pipeline braucht ihn jede Nacht.
    """
    if measure_gate is None:  # pragma: no cover - Standardverdrahtung
        from .gate import measure_gate as _mg
        measure_gate = _mg

    wt = str(cwd)
    base = cfg.base_branch

    rc, main_before = _run(runner, ["git", "-C", wt, "rev-parse", f"origin/{base}"])
    if rc != 0:
        return LandResult(False, "konnte origin/main nicht auflösen")
    main_before = main_before.strip()

    rc, out = _run(runner, ["git", "-C", wt, "push", "-f", "origin", cfg.branch])
    if rc != 0:
        return LandResult(False, f"push fehlgeschlagen: {out.strip()[:200]}")

    # cwd=wt ist Pflicht: `gh pr create --fill` liest Titel/Body aus dem
    # lokalen Git-Log (gleicher Gotcha wie in executor.py).
    rc, out = _run(runner, ["gh", "pr", "create", "--repo", cfg.github_repo,
                            "--head", cfg.branch, "--base", base, "--fill"], cwd=wt)
    if rc != 0:
        return LandResult(False, f"PR konnte nicht geöffnet werden: {out.strip()[:200]}")
    pr_url = out.strip().splitlines()[-1] if out.strip() else ""

    rc, out = _run(runner, ["gh", "pr", "merge", cfg.branch, "--repo", cfg.github_repo,
                            "--merge"], cwd=wt)
    if rc != 0:
        # Nichts gelandet -> nichts zurueckzunehmen.
        return LandResult(False, f"Merge abgelehnt: {out.strip()[:200]}", pr_url=pr_url)

    _run(runner, ["git", "-C", wt, "fetch", "origin"])
    rc, _ = _run(runner, ["git", "-C", wt, "reset", "--hard", f"origin/{base}"])
    if rc != 0:
        return LandResult(True, "gemergt, Nachprüfung nicht möglich (reset fehlgeschlagen)",
                          pr_url=pr_url)

    rc, merge_sha = _run(runner, ["git", "-C", wt, "rev-parse", "HEAD"])
    merge_sha = merge_sha.strip() if rc == 0 else ""

    after = measure_gate(cfg, cwd)
    if getattr(after, "ok", True) and getattr(after, "total", 0) == 0:
        return LandResult(True, "gemergt, Gate auf main grün",
                          merge_sha=merge_sha, pr_url=pr_url)

    # Rot auf main: sofort zurücknehmen, sonst steht die Basis für alle
    # folgenden Läufe kaputt da.
    rc, out = _run(runner, ["git", "-C", wt, "revert", "--no-commit", f"{main_before}..HEAD"])
    if rc != 0:
        return LandResult(False, f"Gate auf main ROT und Revert fehlgeschlagen: {out.strip()[:200]}",
                          merge_sha=merge_sha, pr_url=pr_url)
    _run(runner, ["git", "-C", wt, "commit", "-m",
                  "revert: Auto-Merge zurückgenommen (Gate auf main rot)"])
    rc, out = _run(runner, ["git", "-C", wt, "push", "origin", f"HEAD:{base}"])
    if rc != 0:
        return LandResult(False, f"Gate auf main ROT, Revert nicht gepusht: {out.strip()[:200]}",
                          merge_sha=merge_sha, pr_url=pr_url, reverted=True)
    return LandResult(False, "Gate auf main war rot — Merge automatisch zurückgenommen",
                      merge_sha=merge_sha, pr_url=pr_url, reverted=True)
