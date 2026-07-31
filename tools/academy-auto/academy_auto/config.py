from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# Die Läufe, die es gibt. "academy" = die Lern-App (ki-kompass),
# "web" = die Stufe-1-Marketing-Site (whitestag-academy-web).
TARGETS = ("academy", "web")


@dataclass(frozen=True)
class Config:
    academy_repo: Path
    worktree_path: Path
    branch: str
    base_branch: str
    pause_flag: Path
    dry_run_flag: Path
    gate_commands: list[list[str]]
    max_tasks_per_run: int
    max_diff_lines: int
    denied_globs: tuple[str, ...]
    triage_state_path: Path
    npm_install_cmd: tuple[str, ...]
    secret_read_paths: tuple[str, ...]
    sandbox_write_paths: tuple[str, ...]
    protected_write_paths: tuple[str, ...]
    notify_mode: str
    pending_path: Path
    intent_path: Path
    milestone_delta_threshold: int
    github_repo: str
    auto_merge_max_lines: int
    auto_merge_path_prefixes: tuple[str, ...]
    # Welche Triage-Quellen dieser Lauf anbieten darf. MUSS zu `gate_commands`
    # passen: bietet der Scanner Arbeit an, die das Gate nicht misst, kann der
    # Lauf sie nie als Fortschritt nachweisen und verwirft sie jede Nacht aufs
    # Neue (live erlebt am 31.07. mit lint-Kandidaten aus tests/).
    scan_sources: tuple[str, ...]

    @classmethod
    def default(cls) -> "Config":
        """Der ki-kompass-Lauf. Bleibt der Standard — alles Bestehende hängt daran."""
        return cls.for_target("academy")

    @classmethod
    def for_target(cls, target: str) -> "Config":
        if target == "web":
            return cls._web()
        if target == "academy":
            return cls._academy()
        raise ValueError(f"unbekanntes Ziel: {target!r} (erlaubt: {', '.join(TARGETS)})")

    @classmethod
    def _academy(cls) -> "Config":
        home = Path.home()
        # Bewusst NICHT in CloudStorage/SynologyDrive: launchd-Prozesse haben dort
        # keinen Zugriff (git haengt dann unbegrenzt), und der Sync flippt Dateimodi.
        academy = home / "Developer" / "WHITESTAG.ACADEMY"
        base = home / ".paperclip" / "academy-auto"
        return cls(
            academy_repo=academy,
            # Worktree bewusst AUSSERHALB von ~/.paperclip: dieses Verzeichnis steht
            # auf der Sandbox-Read-Denylist, und der Deny blockt auch die Pfad-
            # Traversierung in Unterordner — tsc/node scheitern dann mit EPERM.
            worktree_path=home / ".academy-auto" / "worktree",
            branch="agents/academy-auto",
            base_branch="main",
            # --legacy-peer-deps: das Repo hat einen Peer-Konflikt, "npm ci"
            # allein scheitert mit ERESOLVE (live verifiziert).
            npm_install_cmd=("npm", "ci", "--legacy-peer-deps"),
            pause_flag=home / ".paperclip" / "academy-auto.pause",
            dry_run_flag=home / ".paperclip" / "academy-auto.dryrun",
            gate_commands=[
                ["npm", "test"],
                ["npx", "tsc", "--noEmit"],
                ["npm", "run", "lint"],
            ],
            # Mehrere Aufgaben je Lauf: das Feld gab es seit Phase A, es wurde
            # aber nirgends ausgewertet — der Lauf schaffte genau einen Krümel
            # pro Nacht. Der Deckel begrenzt gleichzeitig den Schaden eines
            # Ausreissers (max. 3 Merges pro Nacht).
            max_tasks_per_run=3,
            max_diff_lines=800,
            # Auto-Merge-Schwellen (siehe risk.py). Bewusst STRENGER als der
            # allgemeine Diff-Cap: was ohne Rückfrage in main landet, soll klein
            # und überschaubar sein. Alles Grössere geht als Freigabe an Walter.
            auto_merge_max_lines=300,
            auto_merge_path_prefixes=("src/", "tests/"),
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
                # Pflicht: Claude Code schreibt seinen Zustand in die DATEI
                # ~/.claude.json neben dem Ordner ~/.claude. Die subpath-Regel
                # auf den Ordner deckt sie NICHT ab — ohne diese beiden Eintraege
                # bricht die CLI mitten in der Umsetzung mit
                # "API Error: EPERM ... open '~/.claude.json'" ab (live belegt
                # am 30.07.: Datei halb geaendert, Lauf tot, Gate rot).
                str(home / ".claude.json"), str(home / ".claude.json.backup"),
            ),
            protected_write_paths=(
                str(home / ".claude/settings.json"), str(home / ".claude/settings.local.json"),
                str(home / ".claude/scripts"), str(home / ".claude/hooks"),
                str(home / ".claude/CLAUDE.md"), str(home / ".claude/plugins"), str(home / ".claude/skills"),
                str(home / ".claude/commands"), str(home / ".claude/agents"),
                str(home / ".claude/keybindings.json"),
            ),
            notify_mode="daily",
            pending_path=base / "pending.json",
            intent_path=base / "intent.json",
            milestone_delta_threshold=50,
            github_repo="whitestagai/ki-kompass",
            scan_sources=("todo", "skip", "tsc", "lint", "issue"),
        )

    @classmethod
    def _web(cls) -> "Config":
        """Die Stufe-1-Marketing-Site (Astro).

        Eigenes Repo, eigener Worktree, eigener Zustand — die beiden Läufe
        dürfen sich nichts teilen, sonst überschreiben sie sich gegenseitig
        pending.json und Triage-State.
        """
        home = Path.home()
        base_cfg = cls._academy()      # Sandbox-/Secret-Listen sind identisch
        base = home / ".paperclip" / "academy-auto-web"
        return cls(
            academy_repo=home / "Developer" / "whitestag-academy-web",
            worktree_path=home / ".academy-auto" / "worktree-web",
            branch="agents/academy-auto",
            base_branch="main",
            # Kein --legacy-peer-deps: das Astro-Projekt hat keinen Peer-Konflikt
            # (live mit `npm install` verifiziert).
            npm_install_cmd=("npm", "ci"),
            pause_flag=home / ".paperclip" / "academy-auto-web.pause",
            dry_run_flag=home / ".paperclip" / "academy-auto-web.dryrun",
            # Die Site hat (noch) keine Tests und kein eslint. Der Build ist der
            # erste Beweis — und er hätte den Fehlschlag vom 31.07. sofort
            # gefangen (fehlende Anführungszeichen im Layout-Import).
            # Der Build sagt aber NUR, dass Astro durchläuft. Layout-Fehler
            # bleiben unsichtbar: `check:visual` misst je Seite bei 375/768/
            # 1440 px horizontalen Überlauf, Leerraum, fehlende alt-Attribute
            # und die Überschriftenhierarchie. Er fand auf Anhieb zwei echte
            # Fehler, die der Build für grün hielt (Issue #12).
            gate_commands=[["npm", "run", "build"], ["npm", "run", "check:visual"]],
            max_tasks_per_run=3,
            max_diff_lines=800,
            auto_merge_max_lines=300,
            # Seiten, Komponenten, Layouts und Styles liegen alle unter src/.
            # public/ (Bilder) und astro.config.mjs bleiben damit gelb.
            auto_merge_path_prefixes=("src/",),
            # Passend zum Gate: nur Quellen, deren Erledigung der Build auch
            # nachweisen kann. tsc/lint gibt es hier nicht.
            scan_sources=("todo", "skip", "issue"),
            denied_globs=base_cfg.denied_globs,
            triage_state_path=base / "triage-state.json",
            secret_read_paths=base_cfg.secret_read_paths,
            sandbox_write_paths=base_cfg.sandbox_write_paths,
            protected_write_paths=base_cfg.protected_write_paths,
            notify_mode="daily",
            pending_path=base / "pending.json",
            intent_path=base / "intent.json",
            milestone_delta_threshold=50,
            github_repo="whitestagai/whitestag-academy-web",
        )
