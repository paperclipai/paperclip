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


def has_unmerged_commit(cfg, runner=subprocess.run) -> bool:
    """Liegt auf dem Agenten-Branch Arbeit, die noch nicht in `base_branch` ist?

    Solange das zutrifft, darf kein neuer Lauf starten. Zwei Zustaende fallen
    darunter, und beide sind gefaehrlich:

    1. **Noch nicht freigegeben.** `prepare_worktree` startet jeden Lauf mit
       `git reset --hard <base_branch>`. Das verschiebt den Branch-Zeiger und
       macht den Commit unerreichbar (nur noch im Reflog).

    2. **Freigegeben, aber der PR ist noch offen.** Nach Walters ✅ steht der
       Commit auf origin und `gh pr create` hat einen PR geoeffnet. Liefe jetzt
       ein neuer Lauf, wuerde er vom zurueckgesetzten Branch aus committen —
       und das `git push -f origin <branch>` des Executors bei der naechsten
       Freigabe wuerde den **Inhalt des offenen PRs ersetzen**. Die freigegebene
       Arbeit verschwaende aus dem PR.

    Deshalb entscheidet allein `<base_branch>..<branch>`; der Push-Zustand ist
    irrelevant. Erst der **Merge** gibt die Pipeline wieder frei — damit haengt
    immer hoechstens ein offener Agenten-PR in der Luft.

    Fail-safe: jede unklare git-Antwort gilt als "offen". Eine ausgelassene
    Nacht ist sichtbar (Log + der Digest wiederholt sich), vernichtete Arbeit
    nicht.
    """
    ahead = _stdout(runner, ["git", "-C", str(cfg.academy_repo), "rev-list", "--count",
                             f"{cfg.base_branch}..{cfg.branch}"])
    if ahead is None:
        return True
    return ahead.strip() not in ("", "0")
