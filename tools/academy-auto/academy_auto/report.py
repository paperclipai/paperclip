from __future__ import annotations

from .gate import GateResult
from .runner import RunOutcome


def build_digest(
    task_prompt: str,
    run_outcome: RunOutcome,
    gate_result: GateResult | None = None,
    committed: bool = False,
    cap_exceeded: bool = False,
    scope_violations: list[str] | None = None,
    reason: str = "",
    quarantined: list[str] | None = None,
    gate_note: str = "",
    result_override: str = "",
) -> str:
    """Deutschen Tages-Digest für Jarvis/Telegram bauen."""
    lines = ["🎓 Academy-Auto — Tagesstand", ""]
    lines.append(f"Aufgabe: {task_prompt}")
    lines.append(f"Umsetzung: {'ok' if run_outcome.ok else 'fehlgeschlagen'}")

    if gate_note:
        lines.append(f"Gate: {gate_note}")
    elif gate_result is not None:
        if gate_result.passed:
            lines.append("Gate: grün (jest + tsc + lint)")
        else:
            failing = gate_result.steps[-1] if gate_result.steps else None
            cmd = " ".join(failing.cmd) if failing else "unbekannt"
            lines.append(f"Gate: rot bei `{cmd}`")

    if result_override:
        lines.append(f"Ergebnis: {result_override}")
    elif committed:
        lines.append("Ergebnis: auf agents/academy-auto committet")
    elif scope_violations:
        lines.append("Ergebnis: verworfen (Scope-Verletzung: " + ", ".join(scope_violations) + ")")
    elif cap_exceeded:
        lines.append("Ergebnis: verworfen (Diff-Cap überschritten)")
    else:
        lines.append("Ergebnis: verworfen (kein grünes Gate)")

    if reason:
        lines.append(f"Warum diese Aufgabe: {reason}")
    if quarantined:
        lines.append("Quarantäne (bitte anschauen): " + ", ".join(quarantined))

    return "\n".join(lines)


def send_digest(text: str, sender) -> None:
    """Digest verschicken. `sender` kapselt den Jarvis/Telegram-Versand."""
    sender(text)


def build_nothing_digest(quarantined: list[str] | None = None) -> str:
    """Digest, wenn die Triage keine umsetzbare Aufgabe findet."""
    lines = ["🎓 Academy-Auto — Tagesstand", "", "Aufgabe: keine (Triage fand nichts Umsetzbares)"]
    if quarantined:
        lines.append("Quarantäne (bitte anschauen): " + ", ".join(quarantined))
    return "\n".join(lines)
