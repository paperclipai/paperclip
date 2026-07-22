from __future__ import annotations

import subprocess
from pathlib import Path

from .config import Config


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
    )

    # 2) Neuen Worktree auf dem Agenten-Branch anlegen (Branch bei Bedarf neu)
    runner(
        ["git", "-C", repo, "worktree", "add", "-B", cfg.branch, wt],
        check=True,
        capture_output=True,
        text=True,
    )
    return cfg.worktree_path
