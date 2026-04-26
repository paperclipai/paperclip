# Obsidian Brain — Bedienungsanleitung

Praktische Anleitung, wie Walter (oder ein anderer Operator) das Brain im Alltag nutzt.

> Funktionsbeschreibung und Architektur stehen im [README](../README.md). Dieses Dokument beantwortet nur: **„Was muss ich klicken / tippen, um etwas zu erreichen?"**

---

## 1. Einen Agenten zum ersten Mal mit dem Brain nutzen

Paperclip ist issue-driven — du „chattest" nicht direkt mit einem Agenten wie in ChatGPT, sondern stellst ihm Aufgaben als Issue. Der Agent picked das Issue beim nächsten Heartbeat und arbeitet es ab. Antworten landen als Kommentare am Issue. Folgefragen schreibst du als weiteren Kommentar.

### 1.1 Issue per UI erstellen

1. Browser öffnen: [http://localhost:3100/](http://localhost:3100/)
2. Deine Company auswählen → Sidebar **Issues** → **„Neues Issue"**.
3. **Title**: knapp formulieren (max. 70 Zeichen), z.B. _„LM-Studio-Wissen aus dem Vault zusammenfassen"_.
4. **Body**: konkrete Frage stellen, z.B. _„Such mir alles raus, was ich über LM-Studio-Setup, Modellwahl und Embedding-Konfiguration im Vault stehen habe, und fass die Kernpunkte als Bullet-List zusammen."_
5. **Assignee**: einen der zwei CEO-Agenten wählen. Aktuell sind im `agentMap` der Plugin-Konfiguration gemappt:
   - `fca63798-7610-4502-8603-1ecd02d4b811` (CEO)
   - `506c873e-3a40-4483-9a45-0eb0fa1554bb` (CEO)
6. Speichern.

### 1.2 Issue per CLI erstellen (schneller)

```bash
cd "~/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip/.worktrees/brain-runtime"
pnpm paperclipai issue create \
  --title "LM-Studio-Wissen aus dem Vault zusammenfassen" \
  --body  "Such alles im Vault zu LM-Studio-Setup, Modellwahl und Embeddings — fass es als Bullet-List zusammen." \
  --assignee fca63798-7610-4502-8603-1ecd02d4b811
```

(Genaue Flags via `pnpm paperclipai issue create --help`.)

### 1.3 Auf den Heartbeat warten

CEO-Heartbeat ist auf **15 min** gesetzt (laut deiner Memory). Nach spätestens 15 min picked der Agent das Issue. Schneller geht's, wenn du ihn manuell anstößt:

```bash
pnpm paperclipai heartbeat run --agent fca63798-7610-4502-8603-1ecd02d4b811
```

### 1.4 Antwort lesen und nachfragen

Im Issue-Detail siehst du den Comment des Agenten. Dort steht entweder die Antwort oder eine Erklärung, falls etwas blockiert ist. **Folgefragen = neuer Kommentar am Issue** — der Agent reagiert darauf beim nächsten Heartbeat.

---

## 2. Verifizieren, dass das Brain wirklich genutzt wurde

Im Comment des Agenten siehst du normalerweise schon, dass er Tools genutzt hat (Paperclip rendert Tool-Calls inline). Falls du sicher gehen willst:

### 2.1 Audit-Log-Query

```bash
psql -h localhost -p 5432 -d paperclip_brain -c "
  SELECT ts, agent_id, tool, query, array_length(returned_paths, 1) AS hits, latency_ms, ok
  FROM brain.access_log
  ORDER BY ts DESC
  LIMIT 10;
"
```

Erwartet: eine Zeile mit `tool=search_vault`, deinem Query-Text, ≥1 hits, `ok=t`.

### 2.2 Direkter MCP-Call (zum Testen ohne Agent)

```bash
curl -sS -X POST http://localhost:7777 \
  -H "Authorization: Bearer 93eb2e6b0ac4b082c371302bf81848acfd05a14deadc45363d4301a58e864830" \
  -H "Content-Type: application/json" \
  -d '{"tool":"search_vault","args":{"query":"Was weiß ich über LM Studio?","agentId":"CEO","limit":5}}' \
  | python3 -m json.tool
```

---

## 3. Einen weiteren Agenten ans Brain anbinden

Beispiel: CTO-Agent (`5b7cb8a7-945f-4861-b3a7-4ae84d242d1e`) soll Lese-Zugriff nur auf den `AI/`-Ordner bekommen.

### 3.1 ACL-Eintrag setzen

Variante A — **Agent als „CTO" mappen** und ACL für „CTO" anlegen:

```bash
# 1. ACL-Zeile in brain.agent_acl
psql -h localhost -p 5432 -d paperclip_brain -c "
  INSERT INTO brain.agent_acl (agent_id, allowed_folders, description)
  VALUES ('CTO', ARRAY['AI']::text[], 'CTO — read-only auf AI/')
  ON CONFLICT (agent_id) DO UPDATE SET allowed_folders = EXCLUDED.allowed_folders;
"

# 2. Plugin-Config-agentMap erweitern
psql -h localhost -p 54329 -U paperclip -d paperclip -c "
  UPDATE plugin_config
  SET config_json = jsonb_set(
        config_json,
        '{agentMap,5b7cb8a7-945f-4861-b3a7-4ae84d242d1e}',
        '\"CTO\"'
      ),
      updated_at = now()
  WHERE plugin_id = 'ad56c135-cc4a-4e52-8475-11121c938ddc';
"

# 3. Plugin reload, damit Worker den neuen agentMap liest
cd "~/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip/.worktrees/brain-runtime"
pnpm paperclipai plugin disable whitestag.brain && \
  pnpm paperclipai plugin enable whitestag.brain
```

Variante B — **ACL direkt auf die UUID** (kein agentMap-Eintrag nötig, weil das Plugin bei unmapped UUIDs die UUID selbst als ACL-Key nutzt):

```bash
psql -h localhost -p 5432 -d paperclip_brain -c "
  INSERT INTO brain.agent_acl (agent_id, allowed_folders, description)
  VALUES ('5b7cb8a7-945f-4861-b3a7-4ae84d242d1e', ARRAY['AI']::text[], 'CTO read-only')
  ON CONFLICT (agent_id) DO UPDATE SET allowed_folders = EXCLUDED.allowed_folders;
"
```

### 3.2 Verifizieren

Per `vault.list_scope`-Call gegen den MCP-Server (siehe 2.2) mit `"agentId":"CTO"` (Variante A) bzw. der UUID (Variante B). Erwartet: `{"allowedFolders":["AI"], "noteCount":>0}`.

---

## 4. Eine einzelne Notiz vor einem Agenten verbergen

Frontmatter in der Notiz selbst pflegen:

```yaml
---
agent_exclude: [CEO, CTO]
---
```

Wirkt sofort beim nächsten Indexer-Lauf (typischerweise binnen Sekunden — `chokidar` reagiert auf den File-Change).

Verifizieren: nach dem Reload zeigt `vault.search` für die geblockten Agenten diese Notiz nicht mehr; auch `vault.get_note` mit dem Pfad liefert `null`.

---

## 5. Einen Ordner aus dem Index ausschließen

Aktuell sind im Indexer hart ausgeschlossen:

- `attachments/`, `.obsidian/`, `.trash/`, alle Dotfiles
- Dateien > 2 MB

Möchtest du einen weiteren Top-Level-Ordner ausschließen (z.B. `Steuer/`):

1. `packages/brain/src/indexer/watcher.ts` öffnen
2. `EXCLUDED_TOP_LEVEL` ergänzen: `new Set(["attachments", ".obsidian", ".trash", "Steuer"])`
3. `pnpm --filter @paperclipai/brain build`
4. Brain-Indexer neu laden:
   ```bash
   launchctl bootout "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
   launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
   ```
5. Vorhandene Notizen aus dem ausgeschlossenen Ordner aus der DB löschen:
   ```bash
   psql -h localhost -p 5432 -d paperclip_brain -c "DELETE FROM brain.notes WHERE folder = 'Steuer';"
   ```

---

## 6. Status, Logs, Health-Check

| Was | Befehl |
|---|---|
| Laufen die zwei Brain-Services? | `launchctl list \| grep whitestag.brain` |
| MCP erreichbar? | `curl -i http://localhost:7777` (erwartet: `405` ohne Bearer, `401` mit ungültigem Bearer) |
| Live-Indexer-Logs | `tail -f ~/.whitestag-logs/brain-indexer.log` |
| MCP-Server-Logs | `tail -f ~/.whitestag-logs/brain-mcp.log` |
| Wieviele Notizen aktuell? | `psql -h localhost -p 5432 -d paperclip_brain -c "SELECT count(*) FROM brain.notes;"` |
| Verteilung nach Ordner | `psql -h localhost -p 5432 -d paperclip_brain -c "SELECT folder, count(*) FROM brain.notes GROUP BY folder ORDER BY 2 DESC;"` |
| Letzte Tool-Calls | siehe 2.1 |

---

## 7. Stoppen und neu starten

```bash
# Stoppen
launchctl bootout "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
launchctl bootout "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-mcp.plist

# Neu starten
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-mcp.plist
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
```

---

## 8. Brain-Code aktualisieren

Falls du am Brain-Code arbeitest (typischerweise auf einem feature-Branch):

1. Auf dem feature-Branch arbeiten, lokal testen mit `BRAIN_DATABASE_URL=… pnpm --filter @paperclipai/brain test`.
2. Branch nach `master` mergen.
3. Im Runtime-Worktree pullen und neu bauen:
   ```bash
   cd "~/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip/.worktrees/brain-runtime"
   git pull
   pnpm install
   pnpm --filter @paperclipai/brain build
   pnpm --filter @whitestag/paperclip-plugin-brain build
   ```
4. Brain-Services und Plugin-Worker neu laden:
   ```bash
   # Brain-Services
   launchctl bootout "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-mcp.plist
   launchctl bootout "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
   launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-mcp.plist
   launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist

   # Plugin-Worker
   pnpm paperclipai plugin disable whitestag.brain
   pnpm paperclipai plugin enable  whitestag.brain
   ```
5. Falls sich am DB-Schema etwas geändert hat: `BRAIN_DATABASE_URL=… pnpm --filter @paperclipai/brain migrate` ausführen, **vorher backup** mit `pg_dump paperclip_brain > brain-backup-$(date +%F).sql`.

---

## 9. Die wichtigsten Tokens und IDs auf einen Blick

| Was | Wert |
|---|---|
| Bearer-Token (Paperclip → MCP) | `93eb2e6b0ac4b082c371302bf81848acfd05a14deadc45363d4301a58e864830` |
| Bearer-Token (Claude Code → MCP) | `e9542b32839660a1270c2d22ccc95787955817c15e844534bd35413632631a16` |
| MCP-Endpoint | `http://localhost:7777` |
| Brain-DB | `postgres://walterschoenenbroecher.de@localhost:5432/paperclip_brain` |
| Plugin-ID | `ad56c135-cc4a-4e52-8475-11121c938ddc` |
| Plugin-Key | `whitestag.brain` |
| Vault-Pfad | `/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault` |
| Embedding-Modell | `text-embedding-bge-m3` (LM Studio, Port 1234) |

> **Sicherheit**: Die zwei Tokens sind die einzige Authentifizierung zwischen Clients und MCP-Server. Wer sie hat, kann das Brain im Rahmen der konfigurierten ACL benutzen. Tokens **nicht** ins Git committen — sie stehen ausschließlich in der installierten plist-Kopie unter `~/Library/LaunchAgents/com.whitestag.brain-mcp.plist` und in der Plugin-Config in `plugin_config.config_json`.

---

## 10. Troubleshooting

| Symptom | Ursache | Lösung |
|---|---|---|
| Agent gibt zurück „I have no access to vault tools" | Plugin-Worker konnte Config nicht lesen oder Bearer-Token falsch | Plugin reload (siehe 8.4), `plugin_logs`-Tabelle in der Paperclip-DB prüfen |
| `vault.search` liefert leeres Array, obwohl Notizen da sind | ACL fehlt für den anfragenden Agent | Siehe 3 — ACL-Zeile anlegen |
| LM Studio zeigt keine Aktivität, obwohl Indexer läuft | Alle Files sind unverändert (SHA-256 unchanged) → kein Re-Embed nötig | Normal. Erst neue/geänderte Notizen triggern Embeddings. |
| YAML-Parse-Errors im Indexer-Log | Vault-Notizen mit kaputtem Frontmatter (oft alte OneNote-Imports mit `\,` oder `\.`) | Dateien manuell reparieren oder ignorieren — die fehlerhaften Notizen werden einfach übersprungen, der Rest läuft normal weiter. |
| Brain-Service crashed in Loop | Falscher Pfad in plist (z.B. nach Worktree-Move) oder fehlender LM-Studio-Embedding-Endpoint | `~/.whitestag-logs/brain-*.err.log` lesen, Pfad in `~/Library/LaunchAgents/com.whitestag.brain-*.plist` korrigieren, neu laden. |
| Suche dauert > 1 s | DB-Index-Statistik veraltet oder LM Studio überlastet | `psql -d paperclip_brain -c "VACUUM ANALYZE brain.chunks;"`; LM Studio neu starten. |

---

Bei Fragen → Spec liegt unter `docs/superpowers/specs/2026-04-20-obsidian-paperclip-brain-design.md`.
