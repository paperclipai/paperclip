from __future__ import annotations

from dataclasses import dataclass

GREEN = "green"
YELLOW = "yellow"

# Dateien und Ordner, die Build, Abhaengigkeiten, Test-Setup oder Auslieferung
# steuern. Sie liegen teils AUSSERHALB der gruenen Praefixe und waeren damit
# ohnehin gelb — die Liste steht trotzdem explizit da, damit ein spaeter
# erweiterter Praefix (z.B. ".") sie nicht versehentlich gruen macht.
SENSITIVE_NAMES = (
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "tsconfig.json", "app.json", "app.config.js", "app.config.ts",
    "eslint.config.js", "jest.config.js", "babel.config.js", "metro.config.js",
    "Podfile", "build.gradle", "Gemfile",
)
SENSITIVE_PREFIXES = (".github/", "ios/", "android/", "scripts/", "supabase/")


@dataclass(frozen=True)
class RiskResult:
    level: str      # GREEN | YELLOW
    reason: str


def classify(cfg, changed_files: list[str], diff_lines: int) -> RiskResult:
    """Gruen (darf ohne Rueckfrage nach main) oder gelb (braucht Walters ✅)?

    Bewusst eine reine Funktion ueber Dateiliste und Diff-Groesse — kein LLM.
    Eine Einschaetzung, die entscheidet, was unbeaufsichtigt gemergt wird, darf
    nicht selbst raten koennen. Gleiche Eingabe, gleiches Ergebnis, immer.

    Alles, was nicht nachweislich harmlos ist, wird gelb. Die rote Stufe
    (Secrets, Signing-Keys, Supabase-Migrationen) faengt schon vorher der
    Scope-Zaun in `scope.py` ab — dort wird verworfen statt gefragt.
    """
    if not changed_files:
        return RiskResult(YELLOW, "keine Dateiliste — Einstufung nicht moeglich")

    for path in changed_files:
        base = path.rsplit("/", 1)[-1]
        if base in SENSITIVE_NAMES:
            return RiskResult(YELLOW, f"beruehrt Build/Abhaengigkeiten: {path}")
        if any(path.startswith(p) for p in SENSITIVE_PREFIXES):
            return RiskResult(YELLOW, f"beruehrt Infrastruktur: {path}")
        if not any(path.startswith(p) for p in cfg.auto_merge_path_prefixes):
            return RiskResult(YELLOW, f"ausserhalb der Auto-Merge-Pfade: {path}")

    if diff_lines > cfg.auto_merge_max_lines:
        return RiskResult(YELLOW, f"Diff zu gross fuer Auto-Merge: {diff_lines} > {cfg.auto_merge_max_lines}")

    return RiskResult(GREEN, f"{len(changed_files)} Datei(en), {diff_lines} Zeilen, nur Auto-Merge-Pfade")
