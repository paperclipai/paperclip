from __future__ import annotations

import subprocess

APPROVAL_TIMEOUT = 60


def _stdout(runner, cmd) -> str | None:
    """stdout bei Erfolg, sonst None (auch bei Timeout/Crash)."""
    try:
        proc = runner(cmd, capture_output=True, text=True, check=False, timeout=APPROVAL_TIMEOUT)
    except Exception:
        return None
    if getattr(proc, "returncode", 1) != 0:
        return None
    return getattr(proc, "stdout", "") or ""


def has_unapproved_commit(cfg, runner=subprocess.run) -> bool:
    """Wartet auf dem Agenten-Branch ein Commit auf Walters Telegram-Freigabe?

    Hintergrund: `prepare_worktree` startet jeden Lauf mit
    `git reset --hard <base_branch>`. Das verschiebt den Branch-Zeiger und
    macht einen noch nicht freigegebenen Commit unerreichbar (nur noch im
    Reflog). Der normale Takt geht auf — 02:00 Lauf, 08:00 Digest, Entscheidung
    am selben Tag —, aber jede Abweichung davon kostet die Arbeit.

    Erkennung in zwei Schritten:
      1. Liegt ueberhaupt ein Commit ueber dem Basis-Branch?
      2. Steht er schon auf origin? Der Executor pusht bei ✅ vor dem
         `gh pr create`; gleiche SHA heisst also freigegeben. Der PR lebt dann
         auf origin weiter, der lokale Reset ist harmlos.

    Fail-safe: jede unklare Antwort gilt als "offen". Eine ausgelassene Nacht
    ist sichtbar (Log + der Digest wiederholt sich), ein vernichteter Commit
    nicht.
    """
    repo = str(cfg.academy_repo)

    ahead = _stdout(runner, ["git", "-C", repo, "rev-list", "--count",
                             f"{cfg.base_branch}..{cfg.branch}"])
    if ahead is None:
        return True
    if ahead.strip() in ("", "0"):
        return False

    local = _stdout(runner, ["git", "-C", repo, "rev-parse", cfg.branch])
    remote = _stdout(runner, ["git", "-C", repo, "rev-parse", f"origin/{cfg.branch}"])
    if local is None or remote is None:
        return True
    return local.strip() != remote.strip()
