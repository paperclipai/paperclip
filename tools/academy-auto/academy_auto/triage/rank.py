from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass

# Ranker fest auf haiku: es ist eine winzige Urteilsfrage ueber ~30 Zeilen.
# Ohne --model erbt der Aufruf den CLI-Standard (opus) und verbrennt jede
# Nacht unnoetig Tokens. Alias statt Modell-ID, damit es nicht veraltet.
RANK_CMD = ["claude", "-p", "--model", "haiku", "--tools", "", "--strict-mcp-config"]
MAX_CANDIDATES = 30
RANK_TIMEOUT = 180

# Der haiku-Ranker liefert gelegentlich eine leere/kaputte Antwort. Statt die
# ganze Nacht zu verschenken, wird der (billige) Aufruf einige Male wiederholt.
RANK_ATTEMPTS = 3

# Quellen, die NIE verdraengt werden duerfen: Issues sind Walters expliziter
# Steuerhebel — er legt sie bewusst an, sie muessen den Ranker immer erreichen.
PRIORITY_SOURCES = ("issue",)
# Mindestplaetze je uebriger Quelle, damit nicht eine einzelne Fehlerklasse
# (z.B. 657 tsc-Fehler) die gesamte Liste fuellt.
SOURCE_QUOTA = 3


@dataclass
class Pick:
    chosen_key: str
    task_prompt: str
    reason: str


def _select_candidates(candidates, limit: int = MAX_CANDIDATES):
    """Kandidaten fuer den Ranker auswaehlen, ohne dass eine Quelle alles verdraengt."""
    chosen: list = []
    seen: set = set()

    def take(c):
        if c.key not in seen:
            seen.add(c.key)
            chosen.append(c)

    ordered = sorted(candidates, key=lambda c: (-c.raw_priority, c.key))

    # 1) Steuerhebel zuerst: alle Issues
    for c in ordered:
        if c.source in PRIORITY_SOURCES and len(chosen) < limit:
            take(c)
    # 2) Mindestquote je uebriger Quelle
    per_source: dict = {}
    for c in ordered:
        if c.source in PRIORITY_SOURCES or len(chosen) >= limit:
            continue
        n = per_source.get(c.source, 0)
        if n < SOURCE_QUOTA:
            per_source[c.source] = n + 1
            take(c)
    # 3) Rest nach Prioritaet auffuellen
    for c in ordered:
        if len(chosen) >= limit:
            break
        take(c)

    return sorted(chosen, key=lambda c: (-c.raw_priority, c.key))


def _build_prompt(candidates, baseline_red: bool) -> str:
    lines = [
        "Du bist Tech-Lead der WHITESTAG.ACADEMY-App (Expo/React Native).",
        "Wähle aus der Kandidatenliste GENAU EINE gut umsetzbare, klar abgegrenzte Aufgabe.",
        "Meide zu große/riskante Aufgaben.",
        "",
        "WICHTIG — deine Aufgabe ist die AUSWAHL, nicht die Lösung:",
        "Beschreibe in `task_prompt` nur das ZIEL und woran man erkennt, dass es",
        "erreicht ist. Schreibe NICHT den Lösungsweg vor — keine konkreten",
        "Funktionen, Hooks, Parameter oder Code-Zeilen. Wie es umgesetzt wird,",
        "entscheidet der Entwickler, der den Code vor sich hat.",
        "",
        "Antworte AUSSCHLIESSLICH als JSON in einer Zeile:",
        '{"chosen_key": "<key aus der Liste>", "task_prompt": "<Ziel + Abnahmekriterium, ohne Lösungsweg>", "reason": "<kurze Begründung>"}',
    ]
    if baseline_red:
        lines.append("HINWEIS: Die Baseline ist ROT (tsc/lint-Fehler). Bevorzuge eine Aufgabe, die das Gate grün macht.")
    lines.append("Kandidaten:")
    for c in _select_candidates(candidates):
        loc = f"{c.file}:{c.line}" if c.file else c.key
        lines.append(f"- {c.key} [{c.source}] {loc} — {c.text}")
    return "\n".join(lines)


def _extract_json(raw: str):
    try:
        start = raw.index("{")
        end = raw.rindex("}") + 1
    except ValueError:
        return None
    try:
        return json.loads(raw[start:end])
    except ValueError:
        return None


def _default_ranker(prompt: str) -> str:  # pragma: no cover - echter claude-Aufruf beim Deploy
    proc = subprocess.run(RANK_CMD + [prompt], capture_output=True, text=True, check=False, timeout=RANK_TIMEOUT)
    return getattr(proc, "stdout", "") or ""


def _rank_once(candidates, baseline_red: bool = False, ranker=_default_ranker) -> "Pick | None":
    if not candidates:
        return None
    prompt = _build_prompt(candidates, baseline_red)
    try:
        raw = ranker(prompt)
    except Exception:
        return None
    data = _extract_json(raw or "")
    if not isinstance(data, dict):
        return None
    key = data.get("chosen_key")
    if key not in {c.key for c in candidates}:
        return None
    task_prompt = (data.get("task_prompt") or "").strip()
    if not task_prompt:
        return None
    return Pick(chosen_key=key, task_prompt=task_prompt, reason=data.get("reason") or "")


def rank(candidates, baseline_red: bool = False, ranker=_default_ranker) -> "Pick | None":
    if not candidates:
        return None
    for _ in range(RANK_ATTEMPTS):
        pick = _rank_once(candidates, baseline_red=baseline_red, ranker=ranker)
        if pick is not None:
            return pick
    return None
