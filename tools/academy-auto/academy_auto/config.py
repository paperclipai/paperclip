from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    academy_repo: Path
    worktree_path: Path
    branch: str
    pause_flag: Path
    dry_run_flag: Path
    gate_commands: list[list[str]]
    max_tasks_per_run: int
    max_diff_lines: int
    denied_globs: tuple[str, ...]
    triage_state_path: Path
    secret_read_paths: tuple[str, ...]
    sandbox_write_paths: tuple[str, ...]
    protected_write_paths: tuple[str, ...]

    @classmethod
    def default(cls) -> "Config":
        home = Path.home()
        # Bewusst NICHT in CloudStorage/SynologyDrive: launchd-Prozesse haben dort
        # keinen Zugriff (git haengt dann unbegrenzt), und der Sync flippt Dateimodi.
        academy = home / "Developer" / "WHITESTAG.ACADEMY"
        base = home / ".paperclip" / "academy-auto"
        return cls(
            academy_repo=academy,
            worktree_path=base / "worktree",
            branch="agents/academy-auto",
            pause_flag=home / ".paperclip" / "academy-auto.pause",
            dry_run_flag=home / ".paperclip" / "academy-auto.dryrun",
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
                "*supabase/migrations/*", ".git/*",
            ),
            triage_state_path=base / "triage-state.json",
            secret_read_paths=(
                str(home / ".ssh"), str(home / ".aws"), str(home / ".config/gcloud"),
                str(home / ".whitestag.env"), str(home / ".n8n"), str(home / ".paperclip"),
                str(home / "Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC"),
                str(home / ".netrc"), str(home / ".git-credentials"), str(home / ".npmrc"),
                str(home / ".gnupg"), str(home / ".docker"),
                str(home / ".kube"), str(home / ".azure"), str(home / ".pypirc"),
                str(home / ".cargo/credentials"),
                # Hinweis: ~/Library/Keychains bewusst NICHT gesperrt — dort liegt Claudes
                # eigenes OAuth-Token (Deny => 401, Lauf unmöglich). Keychain-Dateien sind
                # verschlüsselt und securityd ist via (allow default) ohnehin erreichbar.
            ),
            sandbox_write_paths=(
                "/private/tmp", "/private/var/folders",
                str(home / ".npm"), str(home / "Library/Caches"),
                str(home / ".cache"), str(home / ".expo"), str(home / ".claude"),
            ),
            protected_write_paths=(
                str(home / ".claude/settings.json"), str(home / ".claude/settings.local.json"),
                str(home / ".claude/scripts"), str(home / ".claude/hooks"),
                str(home / ".claude/CLAUDE.md"), str(home / ".claude/plugins"), str(home / ".claude/skills"),
                str(home / ".claude/commands"), str(home / ".claude/agents"),
                str(home / ".claude/keybindings.json"),
            ),
        )
