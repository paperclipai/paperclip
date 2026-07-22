Academy-Auto Phase A (MVP) — lässt Claude Code eine vorgegebene Aufgabe an
WHITESTAG.ACADEMY in einem isolierten Worktree umsetzen, prüft mit
jest+tsc+lint und meldet den Stand als Jarvis-Digest.

## Ausführen (manuell, Phase A)

    cd tools/academy-auto
    python -m academy_auto.orchestrator "Beschreibe hier die Aufgabe"

## Tests

    cd tools/academy-auto && python -m pytest tests/ -v

## Kill-Switch

    touch ~/.paperclip/academy-auto.pause   # hält jeden Lauf sofort an
    rm    ~/.paperclip/academy-auto.pause   # wieder freigeben

## Deploy (launchd, Phase B)

Paket nach ~/.paperclip/scripts/academy-auto/ kopieren (launchd kann
CloudStorage nicht lesen) und `send_digest`-Sender an den voice-echo-bot
verdrahten. launchd-Automatik + self-directed Triage kommen in Phase B.
