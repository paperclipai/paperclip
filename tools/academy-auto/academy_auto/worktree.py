from __future__ import annotations

import subprocess
from pathlib import Path

from .config import Config

# Obergrenze fuer Git-Operationen. Haengt der Repo-Pfad (z.B. Netz-/Cloud-Mount
# ohne Zugriff), muss der Lauf scheitern statt unbegrenzt zu blockieren.
WORKTREE_TIMEOUT = 120


def prepare_worktree(cfg: Config, runner=subprocess.run) -> Path:
    """Frischen, isolierten Worktree auf dem Agenten-Branch herstellen.

    Entfernt einen evtl. vorhandenen Worktree (Fehler toleriert) und legt ihn
    neu an. Verändert NIE main oder die Haupt-Arbeitskopie.
    """
    repo = str(cfg.academy_repo)
    wt = str(cfg.worktree_path)

    # 1) Alten Worktree entfernen — darf fehlschlagen (existiert evtl. nicht)
    runner(
        ["git", "-C", repo, "worktree", "remove", "--force", wt],
        check=False,
        capture_output=True,
        text=True,
        timeout=WORKTREE_TIMEOUT,
    )

    # 2) Neuen Worktree auf dem Agenten-Branch anlegen (Branch bei Bedarf neu)
    runner(
        ["git", "-C", repo, "worktree", "add", "-B", cfg.branch, wt],
        check=True,
        capture_output=True,
        text=True,
        timeout=WORKTREE_TIMEOUT,
    )
    _link_node_modules(cfg)
    return cfg.worktree_path


def _link_node_modules(cfg: Config) -> bool:
    """node_modules aus dem Haupt-Repo in den Worktree verlinken.

    Ein frischer Worktree hat keine node_modules (gitignored) — ohne sie
    koennen jest/tsc/lint nicht laufen und das Gate misst nichts.
    Symlink statt Installation: der Worktree wird jeden Lauf neu erzeugt.
    Fail-soft: fehlt die Quelle, laeuft der Lauf trotzdem weiter.
    """
    src = Path(cfg.academy_repo) / "node_modules"
    dst = Path(cfg.worktree_path) / "node_modules"
    try:
        if not src.is_dir():
            return False
        if dst.is_symlink() or dst.exists():
            return True
        dst.symlink_to(src, target_is_directory=True)
        return True
    except OSError:
        return False
