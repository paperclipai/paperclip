"""Schließt Triage-Issues deterministisch ab, die Luna faktisch erledigt hat.

**Problem:** Lunas lokales Modell beendet den Run regelmäßig, OHNE
`paperclip_update_issue` mit terminalem Status aufzurufen — es *erzählt* den
Statuswechsel nur im Abschlusstext („Task … marked as in_review"), führt ihn aber
nicht aus. Der Adapter-Guard sieht „Run beendet ohne terminalen Status" und blockt
das Issue. Ergebnis: Berge von `blocked`-Triage-Issues, die die Recovery sinnlos
immer wieder anläuft (verbrennt lokale Modell-Zyklen).

**Lösung:** Genau diese Issues bekommen deterministisch den Zustand, den Luna
beabsichtigt hatte — `in_review`, Walter zugewiesen. Choke-Point ist Code, nicht
der Prompt: das Modell *sagt* ja bereits, es habe den Call gemacht.

**Bewusst konservativ:** Nur Issues mit dem Adapter-Guard-Marker werden angefasst.
Der Guard beweist, dass der Run *zu Ende lief* und lediglich der Statuswechsel
fehlt. Issues, die aus einem echten Fehler blockiert sind (z.B. `llm_unreachable`),
bleiben unberührt — die sollen sichtbar bleiben.

Die HTTP-Zugriffe werden injiziert (`list_blocked` / `get_comments` / `close_issue`),
damit die Logik ohne Netz testbar ist.
"""
from __future__ import annotations

# Nur watcher-erzeugte Triage-Issues anfassen (nicht Korrektur-/Fremd-Issues).
TRIAGE_TITLE_PREFIXES = ("Neue Mails:",)

# Beide Marker müssen vorkommen → schmaler, sicherer Treffer auf den Adapter-Guard.
GUARD_MARKERS = ("post-run guard", "paperclip_update_issue")


def is_triage_issue(issue: dict) -> bool:
    """True, wenn das Issue vom Mail-Watcher als Triage-Auftrag erzeugt wurde."""
    title = (issue or {}).get("title") or ""
    return any(title.startswith(p) for p in TRIAGE_TITLE_PREFIXES)


def is_guard_blocked(comments) -> bool:
    """True, wenn der Adapter-Post-Run-Guard den Run beendet hat.

    Das heißt: der Lauf war fertig, nur der terminale Statuswechsel fehlt —
    im Gegensatz zu einem echten Fehler (der bleibt unangetastet)."""
    for c in comments or []:
        body = ((c or {}).get("body") or "").lower()
        if all(m in body for m in GUARD_MARKERS):
            return True
    return False


def reconcile(*, list_blocked, get_comments, close_issue, dry_run: bool = False) -> list[dict]:
    """Setzt erledigte-aber-blockierte Triage-Issues auf in_review.

    Gibt [{id, action}] zurück: closed | would-close | error. Ein kaputter
    Eintrag darf den Lauf nicht killen (per-Issue try/except)."""
    results: list[dict] = []
    for issue in list_blocked() or []:
        issue_id = (issue or {}).get("id")
        try:
            if not is_triage_issue(issue):
                continue
            if not is_guard_blocked(get_comments(issue_id)):
                continue  # echter Fehler → sichtbar lassen
            if dry_run:
                results.append({"id": issue_id, "action": "would-close"})
                continue
            close_issue(issue_id)
            results.append({"id": issue_id, "action": "closed"})
        except Exception as e:  # noqa: BLE001
            results.append({"id": issue_id, "action": "error", "error": str(e)})
    return results
