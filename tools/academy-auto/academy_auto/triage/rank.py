from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass

RANK_CMD = ["claude", "-p", "--tools", "", "--strict-mcp-config"]
MAX_CANDIDATES = 30
RANK_TIMEOUT = 180


@dataclass
class Pick:
    chosen_key: str
    task_prompt: str
    reason: str


def _build_prompt(candidates, baseline_red: bool) -> str:
    lines = [
        "Du bist Tech-Lead der WHITESTAG.ACADEMY-App (Expo/React Native).",
        "Wähle aus der Kandidatenliste GENAU EINE gut umsetzbare, klar abgegrenzte Aufgabe.",
        "Meide zu große/riskante Aufgaben. Antworte AUSSCHLIESSLICH als JSON in einer Zeile:",
        '{"chosen_key": "<key aus der Liste>", "task_prompt": "<konkreter Auftrag für den Entwickler>", "reason": "<kurze Begründung>"}',
    ]
    if baseline_red:
        lines.append("HINWEIS: Die Baseline ist ROT (tsc/lint-Fehler). Bevorzuge eine Aufgabe, die das Gate grün macht.")
    lines.append("Kandidaten:")
    for c in candidates[:MAX_CANDIDATES]:
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


def rank(candidates, baseline_red: bool = False, ranker=_default_ranker) -> "Pick | None":
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
