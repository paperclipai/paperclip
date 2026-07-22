from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    academy_repo: Path
    worktree_path: Path
    branch: str
    pause_flag: Path
    gate_commands: list[list[str]]
    max_tasks_per_run: int
    max_diff_lines: int
    denied_globs: tuple[str, ...]

    @classmethod
    def default(cls) -> "Config":
        home = Path.home()
        academy = (
            home
            / "Library/CloudStorage/SynologyDrive-Mac"
            / "Claude Code MAC/WHITESTAG.ACADEMY"
        )
        base = home / ".paperclip" / "academy-auto"
        return cls(
            academy_repo=academy,
            worktree_path=base / "worktree",
            branch="agents/academy-auto",
            pause_flag=home / ".paperclip" / "academy-auto.pause",
            gate_commands=[
                ["npm", "test"],
                ["npx", "tsc", "--noEmit"],
                ["npm", "run", "lint"],
            ],
            max_tasks_per_run=1,
            max_diff_lines=800,
            denied_globs=(
                ".env", ".env.*", "*.env",
                "*.pem", "*.key", "*.keystore", "*.jks", "*.p12", "*.p8",
                "*.mobileprovision",
                "google-services.json", "GoogleService-Info.plist",
                "supabase/migrations/*", ".git/*",
            ),
        )
