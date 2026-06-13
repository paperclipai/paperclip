# Deployment — n8n-workflow-watcher

Dieses Repo ist die **Source of Truth**. Die Scripts werden zum Ausführen an einen
launchd-fähigen Ort **kopiert** — denn macOS verweigert launchd-Prozessen den
Zugriff auf `~/Library/CloudStorage/SynologyDrive…` (`Operation not permitted`).
Deshalb läuft der Watcher (wie der Schwester-`walter-deliverable-watcher`) aus
`~/.paperclip/scripts/`.

Der Detektor erstellt bei Fehlern **Paperclip-Issues** (zugewiesen an den
Diagnose-Agenten `n8n-Betriebsingenieur`), keine Sammel-Mail mehr. Eine Mail geht
nur noch als **Meta-Fallback** raus, wenn die Paperclip-API nicht erreichbar ist.

## Install / Update

```bash
# aus der Repo-Wurzel — ALLE DREI Python-Dateien kopieren (unveränderte Namen!)
cp "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" ~/.paperclip/scripts/
cp "tools/n8n-workflow-watcher/n8n_execution_error.py"  ~/.paperclip/scripts/
cp "tools/n8n-workflow-watcher/paperclip_client.py"     ~/.paperclip/scripts/
cp "tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist" ~/Library/LaunchAgents/
mkdir -p ~/Library/Logs/paperclip-n8n-watcher
launchctl unload ~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist 2>/dev/null || true
launchctl load  ~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist
```

**Wichtig:**
- `n8n_workflow_watcher.py` importiert `paperclip_client` und `n8n_execution_error` —
  ohne die beiden Begleitdateien im selben Verzeichnis bricht der Lauf mit
  `ModuleNotFoundError` ab. Immer **alle drei** kopieren.
- Dateinamen mit **Unterstrich** (Importnamen). Die plist `ProgramArguments` zeigt auf
  `n8n_workflow_watcher.py`. (Eine ältere Mail-Version hieß `n8n-workflow-watcher.py`
  mit Bindestrich — die ist abgelöst und wurde entfernt.)
- System-`/usr/bin/python3`, nur Stdlib (keine Drittpakete).

## Konfiguration (Env-Vars in der plist)

- `N8N_RECOVERY_AGENT_ID` — Agent-ID des `n8n-Betriebsingenieur`, dem neue Fehler-Issues
  zugewiesen werden (aktuell `dfa8d0e2-d48a-4342-82c2-f7cf6de9d562`). Fehlt sie, werden
  Issues unassigned angelegt und der Agent nicht geweckt.
- `PCP_API` (optional) — Control-Plane-Base, Default `http://localhost:3100`.
- Der Board-Token wird aus `~/.paperclip/auth.json` geladen (kein Token in der plist).

## Manuell auslösen

```bash
launchctl start ing.paperclip.n8n-workflow-watcher                  # echter Lauf (legt Issues an)
N8N_RECOVERY_AGENT_ID=<id> /usr/bin/python3 ~/.paperclip/scripts/n8n_workflow_watcher.py --dry-run
                                                                    # nur anzeigen, nichts anlegen
```

## Pfade zur Laufzeit

- DB (read-only): `~/.n8n/database.sqlite`
- State (inkl. `reported_exec_ids` für Idempotenz): `~/.paperclip/instances/default/state/n8n-workflow-watcher.json`
- App-Log: `~/.paperclip/instances/default/logs/n8n-workflow-watcher.log`
- launchd stdout/err: `~/Library/Logs/paperclip-n8n-watcher/`

## Zeitplan

Täglich 03:30 (`StartCalendarInterval`), `RunAtLoad false`. Pro neuem Fehler-Execution
(jüngster Lauf eines aktiven Workflows = `error`/`crashed`, 14-Tage-Fenster) wird **ein**
Issue angelegt; Idempotenz über `reported_exec_ids` verhindert Duplikate. Mail nur als
Meta-Fallback bei API-Ausfall.

## Recovery-Toolkit (Plan B)

Der Diagnose-Agent `n8n-Betriebsingenieur` (claude_local, gestufte Recovery) nutzt ein
REST-Toolkit. Deployment:

```bash
# aus der Repo-Wurzel
mkdir -p ~/.paperclip/scripts/recovery
cp tools/n8n-workflow-watcher/recovery/n8n_rest.py \
   tools/n8n-workflow-watcher/recovery/n8n_health.py \
   tools/n8n-workflow-watcher/recovery/__init__.py ~/.paperclip/scripts/recovery/
```

- **API-Key:** `N8N_API_KEY` muss in `~/.whitestag.env` stehen (`export N8N_API_KEY=...`;
  `n8n_rest.load_api_key()` akzeptiert mit/ohne `export`-Präfix). In der n8n-UI unter
  **Settings → n8n API** erzeugen (kein Neustart). Der launchd-Detektor braucht ihn NICHT —
  nur der Agent.
- **Agent-Instructions (Phase B):** Quelle `tools/n8n-workflow-watcher/agent/AGENTS.md`; live
  als managed-Bundle unter `…/agents/dfa8d0e2…/instructions/AGENTS.md`. Bei Änderungen die
  Datei dort **direkt** aktualisieren (PATCH des Bundles schreibt die managed-Disk-Datei nicht
  zuverlässig neu) — der Adapter liest sie pro Heartbeat frisch. Agent ist via `EXCLUDE_NAMES`
  vom Nacht-Generator ausgenommen.
- **Stufen:** 🟢 GRÜN = Workflow reaktivieren (deactivate→activate-Zyklus; nötig, da plain
  `activate` auf bereits aktivem Workflow den Trigger nicht neu registriert — live verifiziert).
  🟡 GELB = Retry (`retry_execution`) — Werkzeug vorhanden, aber nur vom Menschen ausgelöst
  (Doppel-Seiteneffekt-Risiko). 🔴 ROT (Neustart/Credential/JSON-Edit) = Empfehlung,
  menschliche Ausführung.
