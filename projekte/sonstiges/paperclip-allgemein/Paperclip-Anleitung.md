# Paperclip — Kurzanleitung

**Stand:** 2026-04-20
**Company:** WHITESTAG (`9cebf3cf-efe8-4597-a400-f06488900a87`, Prefix `WHI`)
**API:** http://127.0.0.1:3100 · **UI:** http://localhost:3100

---

## Alltag

### Neues Issue anlegen
In der UI: Projekt → „+ Neues Issue". Per CLI:

```bash
npx paperclipai issue create \
  --company-id 9cebf3cf-efe8-4597-a400-f06488900a87 \
  --title "Titel" \
  --description "Beschreibung" \
  --status todo \
  --assignee-agent-id <AGENT_ID>
```

### Task-Status ändern
**UI:** Issue öffnen → Status-Dropdown oben rechts.

**CLI:**
```bash
npx paperclipai issue update <ISSUE_ID> --status cancelled
```

**Status-Werte:** `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`

### Task „stoppen"
Einen laufenden Task kannst du nicht direkt pausieren — du kannst ihn nur:
- auf `cancelled` setzen (für immer beendet, keine Retries)
- auf `blocked` setzen (Agent wird geweckt wenn Blocker frei wird — Achtung, Paperclip retry-t automatisch wenn kein lebender Run existiert)
- auf `in_review` setzen (wartet auf dich, kein Retry)

Empfehlung: Für „ich hab mir's anders überlegt" → `cancelled`. Für „später weiter" → `in_review`, dir selbst zugewiesen.

---

## Agent-Heartbeat

### Wann läuft ein Heartbeat?
- **Automatisch:** wenn `heartbeat.enabled: true` (zeitbasiert) oder auf Event (neuer Task, neuer Kommentar).
- **Manuell:** per Button in der UI oder per CLI:

```bash
npx paperclipai heartbeat run --agent-id <AGENT_ID>
```

### Laufenden Heartbeat abbrechen
Der `lmstudio_local`-Adapter hat seit dem letzten Patch einen automatischen **Wallclock-Schutz: 5 Minuten pro Run**. Danach bricht er selbst mit `run_deadline_exceeded` ab.

Wenn du trotzdem manuell eingreifen musst (z.B. weil du siehst, dass LM Studio durchläuft):

```bash
# Zeigt wer gerade mit LM Studio redet
lsof -iTCP:1234 -sTCP:ESTABLISHED

# Sicherer Weg: ganzen Paperclip-Server neu starten
kill -TERM $(cat ~/.whitestag-pids/paperclip.pid)
bash ~/Desktop/n8n.sh   # idempotent, startet was nicht läuft
```

**Nicht** einzelne Kind-Prozesse killen — sie sind oft der Server selbst, nicht ein isolierter Heartbeat. Ganzer Restart ist schneller und sicherer.

---

## Server-Management

### Status prüfen
```bash
ps -p $(cat ~/.whitestag-pids/paperclip.pid) -o pid,etime,comm
lsof -iTCP:3100 -sTCP:LISTEN
tail -50 ~/.whitestag-logs/paperclip.log
```

### Neustart (sauber)
```bash
kill -TERM $(cat ~/.whitestag-pids/paperclip.pid)
# 5 Sekunden warten, dann:
bash ~/Desktop/n8n.sh
```

### Kompletter Kaltstart aller WHITESTAG-Dienste
```bash
bash ~/Desktop/n8n.sh
```
Startet n8n, Audio-Player, Voice-Agent, ComfyUI, CCC-Film, Paperclip, Cannabis-GUI — alles idempotent.

---

## Agenten verwalten

### Liste aller Agenten
```bash
npx paperclipai agent list --company-id 9cebf3cf-efe8-4597-a400-f06488900a87
```

### Einzel-Agent inspizieren
```bash
npx paperclipai agent get <AGENT_ID>
```

### Modell wechseln (UI-Weg empfohlen)
Agent-Seite → „Permissions & Configuration" → Modell wählen → Speichern.

### Modell per API wechseln (z.B. um Cloud↔Lokal zu A/B-testen)
```bash
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.paperclip/auth.json'))['credentials']['http://localhost:3100']['token'])")

curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "http://127.0.0.1:3100/api/agents/<AGENT_ID>" \
  -d '{"adapterConfig": {"defaultModel": "qwen/qwen3.6-35b-a3b"}}'
```

---

## Notfall-Checkliste

### „LM Studio generiert Tokens obwohl kein Task aktiv ist"
Seit dem 2026-04-20-Patch passiert das automatisch nicht mehr — der Adapter bricht nach 5 Min ab. Falls doch:
```bash
kill -TERM $(cat ~/.whitestag-pids/paperclip.pid) && bash ~/Desktop/n8n.sh
```

### „Agent schreibt in `paperclip-inbox/` statt in den Vault"
Vault-Mount prüfen:
```bash
ls /Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault
```
Wenn leer/fehlend → externes Volume anschließen oder im Finder `Cmd+K` → SMB neu mounten. Agent-Run wiederholen, Datei landet dann im richtigen Ordner.

### „Agent antwortet auf Englisch"
AGENTS.md des Agenten prüfen:
```bash
grep -A1 "## Sprache" ~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents/<AGENT_ID>/instructions/AGENTS.md
```
Wenn der Abschnitt fehlt → manuell ergänzen oder Agent neu hiren.

### „Task steckt in `blocked`-Retry-Schleife"
Paperclip retry-t blocked Tasks automatisch wenn der Run-Prozess verloren ging. Wenn das ungewollt ist:
```bash
npx paperclipai issue update <ISSUE_ID> --status cancelled
```

### „API antwortet 401"
Token abgelaufen oder Server neugestartet:
```bash
cat ~/.paperclip/auth.json | python3 -m json.tool
```
Wenn Token leer/alt: `npx paperclipai auth ...` (siehe `npx paperclipai auth --help`).

---

## Wichtige Pfade

| Was | Pfad |
|---|---|
| Server-PID | `~/.whitestag-pids/paperclip.pid` |
| Server-Log | `~/.whitestag-logs/paperclip.log` |
| Auth-Token | `~/.paperclip/auth.json` |
| Agent-Instruktionen (AGENTS.md) | `~/.paperclip/instances/default/companies/<COMPANY_ID>/agents/<AGENT_ID>/instructions/AGENTS.md` |
| Adapter-Plugin-Config | `~/.paperclip/adapter-plugins.json` |
| LM-Studio-Adapter-Source | `~/Desktop/Claude Code/Paperclip/paperclip-adapter-lmstudio/` |
| Obsidian-Vault | `/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault/` |
| Start-All-Skript | `~/Desktop/n8n.sh` |

---

## Wichtige API-Endpoints

```
GET    /api/agents/me                                     Identität
GET    /api/companies/<ID>/agents                         Alle Agenten
GET    /api/companies/<ID>/issues?status=in_progress      Aktive Tasks
GET    /api/agents/me/inbox-lite                          Meine Inbox kompakt
GET    /api/issues/<ID>                                   Einzelnes Issue
PATCH  /api/issues/<ID>                                   Issue updaten
POST   /api/companies/<ID>/issues                         Neues Issue
GET/PUT /api/issues/<ID>/documents/<key>                  Issue-Dokumente (z.B. plan)
```

Alle Requests brauchen `Authorization: Bearer <TOKEN>` (aus `~/.paperclip/auth.json`).

---

## Häufig gebrauchte Agent-IDs

| Agent | ID |
|---|---|
| CEO | `506c873e-3a40-4483-9a45-0eb0fa1554bb` |
| CTO | `5b7cb8a7-945f-4861-b3a7-4ae84d242d1e` |
| CFO | `408f7e88-1ab6-4c9a-988b-68040fd28c13` |
| CMO | `bbf38291-1129-43db-97de-c03c998b691e` |
| Buchhaltung | `c73aceb3-63a5-4927-bff4-c595b408cd83` |
| Vermögensverwaltung | `6bbbfe93-7fa8-44cb-8e21-23e81a9bb4dd` |
| Online-Recherche | `d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7` |
| Drehbuch | `478fad75-48b1-4248-9dc5-5f3980a961fd` |
| Creative Director | `4920b0be-b197-45ae-a169-54b99082c4ea` |

Vollständige Liste: `npx paperclipai agent list --company-id 9cebf3cf-efe8-4597-a400-f06488900a87`

---

## Quick-Troubleshooting-Matrix

| Symptom | Erste Aktion |
|---|---|
| UI lädt nicht | Port 3100 frei? Server neustarten |
| Agent antwortet nicht | Heartbeat manuell triggern; LM Studio läuft? |
| LM Studio endlos Tokens | Server neustarten; Wallclock-Schutz greift sonst nach 5 min |
| Agent verweigert Tool | Path außerhalb `cwd` und `allowedWriteRoots`? Vault gemountet? |
| Zwei Modell-Felder in Config-UI | Hinterlassenschaft aus Adapter-Switch; ignorierbar, Adapter nutzt `defaultModel` |
| Commit-Co-Author falsch | Git-Identität prüfen: `git config --global user.email` |

---

## Verwandte Dokumente im Projekt-Root

- [LLM-Empfehlungen Paperclip-Agenten.md](LLM-Empfehlungen Paperclip-Agenten.md) — Zuordnung Agent → Modell
- [Obsidian-Paperclip-Integration.md](Obsidian-Paperclip-Integration.md) — Plugin-Konzept für Vault-Sync
