# Design: launchd-Automatik für academy-auto (mit Trockenlauf)

**Datum:** 2026-07-23
**Status:** Design (genehmigt, Spec zur Review)
**Ziel:** Der academy-auto-Loop läuft täglich nachts unbeaufsichtigt — zunächst im **Trockenlauf** (alles echt außer dem Commit), mit täglichem Jarvis/Telegram-Digest, und lässt sich per Flag-Datei scharf schalten.

## Kontext

academy-auto ist funktional vollständig: Orchestrator mit Guard-Kette (Pause → Worktree → Baseline → Triage → Impl → Delta-Gate → Scope → Cap → Commit), self-directed Triage (Scanner + haiku-Ranker + Quarantäne), Baseline-Delta-Gate und **FS-Isolation** (`claude` läuft ausschließlich sandbox-gekapselt, fail-closed, real bewiesen). 121 Tests grün. Was fehlt, ist die Automatik — der Schritt, mit dem das System tatsächlich unbeaufsichtigt arbeitet.

## Entscheidungen (aus dem Brainstorming)

| Frage | Entscheidung |
|---|---|
| Schärfe zum Start | **Trockenlauf zuerst** (läuft komplett, committet nicht), später per Flag scharf |
| Zeitplan | **Täglich ~02:00** (Studio läuft, `keep-awake`-LaunchAgent verhindert Ruhezustand) |
| Digest-Kanal | **Jarvis/Telegram** über den bestehenden Bot (aus dem ersten Brainstorm) |
| plist | wird **geladen** — läuft ab der ersten Nacht, eben trocken |

## Trockenlauf-Modus

Flag-Datei analog zum bestehenden Kill-Switch, damit Umschalten ohne Code-Edit geht:

```
touch ~/.paperclip/academy-auto.dryrun   # Trockenlauf
rm    ~/.paperclip/academy-auto.dryrun   # scharf
```

- `Config.dry_run_flag: Path` = `~/.paperclip/academy-auto.dryrun`.
- Im Trockenlauf läuft die komplette Kette echt (Triage, Claude in der Sandbox, Delta-Gate, Scope-Zaun, Diff-Cap). Nur `commit_and_pr` wird **übersprungen**.
- Status `dry_run`; danach **Worktree-Reset** (nichts bleibt liegen).
- Der Digest enthält zusätzlich die **Diff-Zusammenfassung** (geänderte Dateien + Zeilenzahl), damit die Qualität beurteilbar ist.
- **Bewusst:** Im Trockenlauf wird das Triage-Ergebnis **nicht** im State verbucht (sonst würde die Quarantäne fälschlich greifen). Konsequenz: Der Ranker wählt womöglich mehrere Nächte dieselbe Top-Aufgabe — für eine Probephase akzeptabel und selbst ein Signal.

## launchd-Automatik

Nach dem etablierten Hausmuster:

- **Entrypoint** `run-nightly.sh` im Deploy-Ordner → ruft `python3 -m academy_auto.orchestrator` (ohne Argument = Triage entscheidet selbst).
- **Deploy-Ziel** `~/.paperclip/scripts/academy-auto/` — launchd kann CloudStorage/SynologyDrive nicht lesen („Operation not permitted").
- **plist** `de.whitestag.academy-auto.plist` in `~/Library/LaunchAgents`, `StartCalendarInterval` 02:00, Logs nach `~/.paperclip/logs/academy-auto.log`.
- **Bekannte Fallstricke eingebaut:**
  - plist ruft explizit `/usr/bin/python3` (kein Verlass auf das Executable-Bit — SynologyDrive flippt Dateimodi, das brach schon das seo-geo-Audit).
  - `PATH` in `EnvironmentVariables` gesetzt (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:…`), damit `claude`, `npx`, `git` gefunden werden.
  - `WorkingDirectory` = Deploy-Ordner.

## Telegram-Digest

Der `send_digest`-Sender wird an den bestehenden **Jarvis-Bot** verdrahtet: `Telegram`-Klasse aus `~/.paperclip/scripts/voice-echo-bot/telegram_api.py`, `send_message(chat_id, text)`, mit demselben Token/Chat wie der Bot. **Keine neue Credential.** Fail-soft: schlägt der Versand fehl, bricht der Lauf nicht ab (Ergebnis steht im Log).

## Robustheit für den unbeaufsichtigten Betrieb

- **Top-Level-Fehlerbehandlung in `run_once`:** jede unerwartete Exception → Digest + Status `error`, statt eines stillen launchd-Absturzes. (Offener Punkt aus dem Phase-A-Final-Review; unter Automatik wird er akut.)
- Kill-Switch (`academy-auto.pause`) und alle Subprozess-Timeouts (Ranker, Scan, Gate, Implement) sind bereits vorhanden.

## Fehlerbehandlung

- Sandbox nicht startbar → `impl_failed` (fail-closed), Digest nennt die Ursache.
- Telegram-Versand scheitert → Lauf gilt trotzdem als beendet, Fehler im Log.
- Unerwartete Exception irgendwo → Status `error` + Digest, launchd-Lauf endet sauber.
- Pause-Flag gesetzt → sofortiger Abbruch ohne Digest.

## Testing

- `dry_run`-Pfad: Flag gesetzt → `commit_and_pr` wird NICHT aufgerufen (throw-Guard), Status `dry_run`, Worktree-Reset erfolgt, kein `record_triage_outcome`.
- Flag nicht gesetzt → unverändertes Commit-Verhalten (bestehende Tests bleiben grün).
- Top-Level-Except: eine werfende `deps`-Funktion → Status `error` + Digest, kein Crash.
- Digest enthält im Trockenlauf die Diff-Zusammenfassung.
- Telegram-Sender: gemockt (kein echter Versand im Test); Fail-soft bei Versandfehler.
- `run-nightly.sh` + plist: Syntaxprüfung (`zsh -n`, `plutil -lint`).

## Phasing

- **Phase 1:** Trockenlauf-Modus + Top-Level-Except im Orchestrator (Code + Tests).
- **Phase 2:** Telegram-Sender-Verdrahtung (Code + Tests).
- **Phase 3:** Deploy — `run-nightly.sh`, plist, Kopie nach `~/.paperclip/scripts/`, Flag setzen, plist laden, **echter Probelauf von Hand** (nicht auf die Nacht warten).

## Bewusst außerhalb dieses Designs

Das Scharfschalten selbst (`rm …dryrun`) bleibt Walters Entscheidung nach ein paar beobachteten Nächten. Die Härtung der zeilenbasierten Triage-keys gegen Commit-Pfad-Drift und die Feinjustierung von `IMPLEMENT_TIMEOUT` bleiben offene Punkte für später.
