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

## Betrieb (launchd)

Deploy — launchd kann CloudStorage/SynologyDrive nicht lesen, deshalb eine Kopie:

    rsync -a --delete --exclude __pycache__ tools/academy-auto/ ~/.paperclip/scripts/academy-auto/
    cp tools/academy-auto/de.whitestag.academy-auto.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/de.whitestag.academy-auto.plist

Läuft täglich 02:00. Log: `~/.paperclip/logs/academy-auto.log`

Schalter (Flag-Dateien, kein Code-Edit nötig):

    touch ~/.paperclip/academy-auto.dryrun   # Trockenlauf: laeuft komplett, committet NICHT
    rm    ~/.paperclip/academy-auto.dryrun   # scharf schalten
    touch ~/.paperclip/academy-auto.pause    # Not-Aus (hat Vorrang vor allem)

Lauf von Hand (statt auf 02:00 zu warten):

    zsh ~/.paperclip/scripts/academy-auto/run-nightly.sh

## Freigabe-Sperre (`awaiting_approval`)

Solange auf `agents/academy-auto` ein Commit liegt, der noch nicht per
Telegram-✅ freigegeben wurde, **setzt der Lauf komplett aus** und meldet
`awaiting_approval`.

Grund: `prepare_worktree` startet jeden Lauf mit
`git reset --hard <base_branch>`. Das verschiebt den Branch-Zeiger und macht
einen nicht freigegebenen Commit unerreichbar (nur noch im Reflog). Der
normale Takt geht auf — 02:00 Lauf, 08:00 Digest, Entscheidung am selben Tag —,
aber jede Abweichung (Lauf von Hand, Urlaub, übersehener Digest) hätte die
Arbeit gekostet.

Erkennung in `approval.py`: Commit über `base_branch` vorhanden **und** noch
nicht auf `origin` (der Executor pusht bei ✅ vor `gh pr create`, gleiche SHA
heißt also freigegeben). Jede unklare git-Antwort gilt als „offen" —
eine ausgelassene Nacht ist sichtbar, ein vernichteter Commit nicht.

Wichtig: Im Sperrfall wird `pending.json` **nicht** überschrieben. Die Datei
trägt die `run_ts`, auf die die Telegram-Buttons zeigen (`executor` prüft
`ref_run_ts`); ein neuer Datensatz würde die Freigabe entwerten. Der 08:00-
Digest wiederholt deshalb denselben Stand mit funktionierenden Buttons, bis
entschieden ist.

Steckengeblieben? Entweder in Telegram ✅/❌ drücken, oder von Hand auflösen:

    git -C ~/Developer/WHITESTAG.ACADEMY log --oneline main..agents/academy-auto
