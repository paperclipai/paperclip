from __future__ import annotations

import subprocess
from pathlib import Path

from .config import Config

# Obergrenze fuer Git-Operationen. Haengt der Repo-Pfad (z.B. Netz-/Cloud-Mount
# ohne Zugriff), muss der Lauf scheitern statt unbegrenzt zu blockieren.
WORKTREE_TIMEOUT = 120
# npm ci kann bei kaltem Cache lange dauern (nur beim allerersten Lauf noetig).
NPM_INSTALL_TIMEOUT = 1800


def _is_valid_worktree(cfg: Config, runner) -> bool:
    """Existiert am Zielpfad bereits ein funktionierender Git-Worktree?"""
    try:
        proc = runner(
            ["git", "-C", str(cfg.worktree_path), "rev-parse", "--is-inside-work-tree"],
            check=False, capture_output=True, text=True, timeout=WORKTREE_TIMEOUT,
        )
        return getattr(proc, "returncode", 1) == 0
    except Exception:
        return False


def ensure_dependencies(cfg: Config, runner=subprocess.run) -> bool:
    """npm ci — nur wenn node_modules fehlt.

    Ohne Dependencies misst das Gate nichts und die Triage findet nichts.
    Der Worktree ist persistent, deshalb faellt das nur beim ersten Lauf an.
    """
    nm = Path(cfg.worktree_path) / "node_modules"
    try:
        if nm.is_dir() and any(nm.iterdir()):
            return True
    except OSError:
        pass
    try:
        proc = runner(
            list(cfg.npm_install_cmd), cwd=str(cfg.worktree_path),
            check=False, capture_output=True, text=True, timeout=NPM_INSTALL_TIMEOUT,
        )
        if getattr(proc, "returncode", 1) == 0:
            return True
        # Sichtbar machen: ohne Dependencies misst das Gate nichts und die
        # Triage findet nichts — der Lauf waere stillschweigend wertlos.
        tail = ((getattr(proc, "stderr", "") or "") + (getattr(proc, "stdout", "") or ""))[-500:]
        print(f"WARNUNG: {' '.join(cfg.npm_install_cmd)} fehlgeschlagen — Gate misst nichts.\n{tail}")
        return False
    except Exception:
        return False


def prepare_worktree(cfg: Config, runner=subprocess.run) -> Path:
    """Isolierten Worktree auf dem Agenten-Branch bereitstellen.

    Persistent: existiert er bereits, wird er in-place auf den Basis-Branch
    zurueckgesetzt (`reset --hard` + `clean -fd`). `clean` ohne `-x` laesst
    ignorierte Dateien wie node_modules stehen — sonst muesste jede Nacht neu
    installiert werden und npm raeumt Symlinks weg.
    Veraendert NIE das Haupt-Repo oder dessen Branch.
    """
    repo = str(cfg.academy_repo)
    wt = str(cfg.worktree_path)

    if _is_valid_worktree(cfg, runner):
        runner(["git", "-C", wt, "reset", "--hard", cfg.base_branch],
               check=True, capture_output=True, text=True, timeout=WORKTREE_TIMEOUT)
        runner(["git", "-C", wt, "clean", "-fd"],
               check=True, capture_output=True, text=True, timeout=WORKTREE_TIMEOUT)
    else:
        runner(["git", "-C", repo, "worktree", "remove", "--force", wt],
               check=False, capture_output=True, text=True, timeout=WORKTREE_TIMEOUT)
        runner(["git", "-C", repo, "worktree", "add", "-B", cfg.branch, wt],
               check=True, capture_output=True, text=True, timeout=WORKTREE_TIMEOUT)

    ensure_dependencies(cfg, runner=runner)
    return cfg.worktree_path
