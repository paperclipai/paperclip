# Deployment — n8n-workflow-watcher

Dieses Repo ist die **Source of Truth**. Das Script wird zum Ausführen an einen
launchd-fähigen Ort **kopiert** — denn macOS verweigert launchd-Prozessen den
Zugriff auf `~/Library/CloudStorage/SynologyDrive…` (`Operation not permitted`).
Deshalb läuft der Watcher (wie der Schwester-`walter-deliverable-watcher`) aus
`~/.paperclip/scripts/`.

## Install / Update

```bash
# aus der Repo-Wurzel
cp "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" ~/.paperclip/scripts/n8n-workflow-watcher.py
cp "tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist" ~/Library/LaunchAgents/
mkdir -p ~/Library/Logs/paperclip-n8n-watcher
launchctl unload ~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist 2>/dev/null || true
launchctl load  ~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist
```

**Wichtig:** Nach jeder Code-Änderung das Script erneut nach `~/.paperclip/scripts/`
kopieren (Schritt 1 oben) — sonst läuft nachts die alte Version.

## Manuell auslösen

```bash
launchctl start ing.paperclip.n8n-workflow-watcher        # echter Lauf (sendet ggf. Mail)
python3 ~/.paperclip/scripts/n8n-workflow-watcher.py --dry-run   # nur anzeigen, nichts senden
```

## Pfade zur Laufzeit

- DB (read-only): `~/.n8n/database.sqlite`
- State: `~/.paperclip/instances/default/state/n8n-workflow-watcher.json`
- App-Log: `~/.paperclip/instances/default/logs/n8n-workflow-watcher.log`
- launchd stdout/err: `~/Library/Logs/paperclip-n8n-watcher/`

## Zeitplan

Täglich 03:30 (`StartCalendarInterval`), `RunAtLoad false`. Mail nur bei Befund;
montags zusätzlich „alles grün"-Heartbeat. Tages-Dedup verhindert Doppelversand.
