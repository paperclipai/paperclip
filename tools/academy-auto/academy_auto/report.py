from __future__ import annotations

from .gate import GateResult
from .runner import RunOutcome


def build_digest(
    task_prompt: str,
    run_outcome: RunOutcome,
    gate_result: GateResult,
    committed: bool,
    cap_exceeded: bool = False,
    scope_violations: list[str] | None = None,
) -> str:
    """Deutschen Tages-Digest für Jarvis/Telegram bauen."""
    lines = ["🎓 Academy-Auto — Tagesstand", ""]
    lines.append(f"Aufgabe: {task_prompt}")
    lines.append(f"Umsetzung: {'ok' if run_outcome.ok else 'fehlgeschlagen'}")

    if gate_result.passed:
        lines.append("Gate: grün (jest + tsc + lint)")
    else:
        failing = gate_result.steps[-1] if gate_result.steps else None
        cmd = " ".join(failing.cmd) if failing else "unbekannt"
        lines.append(f"Gate: rot bei `{cmd}`")

    if committed:
        lines.append("Ergebnis: auf agents/academy-auto committet")
    elif scope_violations:
        lines.append("Ergebnis: verworfen (Scope-Verletzung: " + ", ".join(scope_violations) + ")")
    elif cap_exceeded:
        lines.append("Ergebnis: verworfen (Diff-Cap überschritten)")
    else:
        lines.append("Ergebnis: verworfen (kein grünes Gate)")

    return "\n".join(lines)


def send_digest(text: str, sender) -> None:
    """Digest verschicken. `sender` kapselt den Jarvis/Telegram-Versand."""
    sender(text)
