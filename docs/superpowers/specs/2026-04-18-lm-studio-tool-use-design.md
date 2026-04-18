# LM Studio Adapter Tool-Use — Design Spec

## Ziel

Den bestehenden LM Studio Adapter um einen vollständigen Agent-Loop mit Tool-Use erweitern, damit Paperclip-Agenten mit lokalen LLMs nicht nur denken, sondern auch handeln können: Paperclip-API aufrufen, Dateien lesen/schreiben, Shell-Befehle und Git-Operationen ausführen.

## Entscheidungen

| Punkt | Entscheidung |
|-------|-------------|
| Ansatz | Eigener Tool-Loop im Adapter (kein CLI-Wrapping, kein MCP) |
| Tool-Standard | OpenAI Function Calling (tools[] Parameter) |
| Streaming | Hybrid: Request-Response für Tool-Iterationen, Streaming für finale Antwort |
| Max Iterationen | 25 per Default, konfigurierbar pro Agent |
| Tool-Umfang | Voller Agent-Stack: Paperclip-API + Dateisystem + Shell + Git |
| Sicherheit | cwd-Sandbox, Shell-Timeout, Run-ID-Audit-Trail |

## Architektur

### Agent-Loop

```
Heartbeat startet
  │
  ├─ System-Prompt aufbauen
  │   ├─ Agent-Instructions (aus context.agentInstructions oder AGENTS.md)
  │   ├─ Paperclip-Skill (Heartbeat-Prozedur, API-Referenz)
  │   └─ Agent-Identität (Name, Rolle, Company)
  │
  ├─ User-Prompt aufbauen
  │   ├─ Wake-Payload (Issue, Reason, Kommentare)
  │   └─ Prompt-Template (falls konfiguriert)
  │
  ├─ LOOP (max 25 Iterationen):
  │   │
  │   ├─ POST {url}/v1/chat/completions
  │   │   Body: { model, messages, tools, tool_choice: "auto", stream: false }
  │   │
  │   ├─ Antwort parsen
  │   │   ├─ tool_calls vorhanden?
  │   │   │   ├─ JA:
  │   │   │   │   ├─ Assistant-Message (mit tool_calls) an messages anhängen
  │   │   │   │   ├─ Jeden tool_call ausführen
  │   │   │   │   ├─ Tool-Ergebnisse als role:"tool" an messages anhängen
  │   │   │   │   ├─ Tool-Events via onLog() in die UI streamen
  │   │   │   │   └─ Weiter im Loop
  │   │   │   │
  │   │   │   └─ NEIN (finale Textantwort):
  │   │   │       ├─ Text via onLog("stdout", ...) Token für Token streamen
  │   │   │       └─ EXIT Loop
  │   │   │
  │   │   └─ Kein Content und keine tool_calls → EXIT mit Fehler
  │   │
  │   └─ Iteration zählen, bei Max → EXIT mit Warnung
  │
  └─ AdapterExecutionResult zurückgeben
      ├─ exitCode: 0 (Erfolg) oder 1 (Fehler/Timeout)
      ├─ model, provider: "lmstudio"
      ├─ summary: Letzte Textantwort (gekürzt)
      └─ usage: Token-Counts aus allen LLM-Calls summiert
```

### Streaming-Strategie (Hybrid)

Während des Tool-Loops wird `stream: false` genutzt — der Adapter wartet auf die vollständige Antwort, prüft ob tool_calls vorhanden sind, und führt sie aus. Das ist zuverlässiger als SSE-Streams mit Function Calls zu parsen.

Für die **finale Antwort** (letzter LLM-Call ohne tool_calls) wird ein separater Request mit `stream: true` gemacht, damit die Antwort Token für Token in der UI erscheint.

Während des Tool-Loops werden Fortschrittsmeldungen via `onLog()` gestreamt:

```
[tool_call] paperclip_checkout_issue {"issueId": "WHI-5"}
[tool_result] Successfully checked out WHI-5
[tool_call] fs_write_file {"path": "konzept.md", "content": "..."}
[tool_result] File written: konzept.md (2.4 KB)
```

## Dateistruktur

Erweiterung des bestehenden `paperclip-adapter-lmstudio/`:

```
src/
├── server/
│   ├── execute.ts            # ERWEITERT: Agent-Loop mit Tool-Handling
│   ├── tools.ts              # NEU: Tool-Definitionen (OpenAI Function Schema)
│   ├── tool-executor.ts      # NEU: Dispatcher — routet tool_call zum richtigen Handler
│   ├── paperclip-tools.ts    # NEU: Paperclip-API Tool-Handler
│   ├── fs-tools.ts           # NEU: Dateisystem Tool-Handler
│   ├── shell-tools.ts        # NEU: Shell/Git Tool-Handler
│   ├── models.ts             # BESTEHEND: Model Discovery
│   ├── test.ts               # BESTEHEND: Health Check
│   └── index.ts              # ERWEITERT: getConfigSchema() mit maxIterations
├── ui-parser.ts              # ERWEITERT: Tool-Events parsen
└── index.ts                  # BESTEHEND: Entry Point
```

## Tool-Definitionen (tools.ts)

18 Tools in 3 Kategorien, alle als OpenAI Function Definitions:

### Paperclip-API Tools (8)

| Tool | Beschreibung | HTTP-Methode | Endpoint |
|------|-------------|-------------|----------|
| `paperclip_get_identity` | Eigene Agent-Identität abrufen | GET | /api/agents/me |
| `paperclip_get_inbox` | Kompakte Aufgabenliste | GET | /api/agents/me/inbox-lite |
| `paperclip_checkout_issue` | Aufgabe beanspruchen | POST | /api/issues/{id}/checkout |
| `paperclip_update_issue` | Status/Kommentar/Priorität ändern | PATCH | /api/issues/{id} |
| `paperclip_add_comment` | Kommentar hinzufügen | POST | /api/issues/{id}/comments |
| `paperclip_get_issue_context` | Kompakter Issue-Kontext | GET | /api/issues/{id}/heartbeat-context |
| `paperclip_get_comments` | Kommentar-Thread laden | GET | /api/issues/{id}/comments |
| `paperclip_create_subtask` | Neue Unteraufgabe erstellen | POST | /api/companies/{id}/issues |

Alle Paperclip-API-Calls nutzen:
- `Authorization: Bearer {authToken}` (injiziert vom Server)
- `X-Paperclip-Run-Id: {runId}` (Audit-Trail, nur bei Mutationen)
- API-URL aus `PAPERCLIP_API_URL` Environment-Variable oder Fallback auf `http://localhost:3100`

### Dateisystem-Tools (5)

| Tool | Beschreibung | Parameter |
|------|-------------|-----------|
| `fs_read_file` | Datei lesen | path, offset?, limit? |
| `fs_write_file` | Datei schreiben/erstellen | path, content |
| `fs_list_directory` | Verzeichnisinhalt auflisten | path |
| `fs_glob` | Dateien per Glob-Pattern suchen | pattern, path? |
| `fs_grep` | In Dateien suchen (Text/Regex) | pattern, path?, glob? |

Alle Pfade werden relativ zum Agent-`cwd` aufgelöst. Zugriff außerhalb des `cwd` wird blockiert (Path-Traversal-Schutz).

### Shell & Git Tools (5)

| Tool | Beschreibung | Parameter |
|------|-------------|-----------|
| `shell_exec` | Shell-Befehl ausführen | command, timeout? (Default: 30s, Max: 120s) |
| `git_status` | Git-Status anzeigen | — |
| `git_diff` | Änderungen anzeigen | ref? |
| `git_commit` | Dateien stagen + committen | files, message |
| `git_log` | Commit-Historie anzeigen | count? (Default: 10) |

Shell-Befehle werden im Agent-`cwd` ausgeführt mit Timeout-Schutz.

## Sicherheit

### Path-Traversal-Schutz

Alle Dateisystem-Tools lösen Pfade relativ zum `cwd` auf und prüfen, dass der aufgelöste absolute Pfad innerhalb des `cwd` liegt:

```typescript
function safePath(cwd: string, relativePath: string): string {
  const resolved = path.resolve(cwd, relativePath);
  if (!resolved.startsWith(path.resolve(cwd))) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return resolved;
}
```

### Shell-Sicherheit

- Timeout: Default 30s, Maximum 120s, konfigurierbar
- Ausführung via `child_process.exec` mit `{ cwd, timeout, maxBuffer }`
- Kein interaktiver Modus (stdin wird nicht weitergeleitet)

### API-Sicherheit

- Auth-Token ist kurzlebig (vom Paperclip-Server injiziert)
- Run-ID wird bei allen Mutationen mitgeschickt
- Agent kann nur auf seine eigenen Issues/Company zugreifen (Server-seitig enforced)

### Iteration-Limit

- Default: 25, konfigurierbar via `maxIterations` in adapterConfig
- Bei Erreichen: Loop wird beendet, Status-Kommentar auf dem Issue ("Max iterations reached")

## UI-Parser (Erweiterung)

Der bestehende `createStdoutParser()` wird erweitert, um strukturierte Tool-Events zu erkennen:

### Output-Format (via onLog)

Der Adapter streamt strukturierte JSON-Lines via `onLog("stdout", ...)`:

```
{"kind":"assistant","text":"Ich checke die Aufgabe aus..."}
{"kind":"tool_call","name":"paperclip_checkout_issue","input":{"issueId":"WHI-5"},"toolUseId":"call_1"}
{"kind":"tool_result","toolUseId":"call_1","content":"Successfully checked out WHI-5","isError":false}
{"kind":"assistant","text":"Aufgabe ausgecheckt. Jetzt erstelle ich das Konzept..."}
{"kind":"tool_call","name":"fs_write_file","input":{"path":"konzept.md","content":"# Markenbildung..."},"toolUseId":"call_2"}
{"kind":"tool_result","toolUseId":"call_2","content":"File written: konzept.md (1.2 KB)","isError":false}
```

### Parser-Logik

```typescript
function parseLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // Versuche JSON zu parsen
  try {
    const event = JSON.parse(trimmed);
    if (event.kind) return [{ ...event, ts }];
  } catch {
    // Kein JSON — als Text behandeln
  }

  return [{ kind: "assistant", ts, text: trimmed, delta: true }];
}
```

## Config-Schema (Erweiterung)

Neues Feld im bestehenden Schema:

```json
{
  "key": "maxIterations",
  "label": "Max Tool-Iterationen",
  "type": "number",
  "default": 25,
  "hint": "Maximale Anzahl Tool-Aufrufe pro Heartbeat (Sicherheitslimit)"
}
```

## Prompt-Aufbau

### System-Prompt

```
You are {agent.name}, a Paperclip AI agent.
Role: {agent.role}
Company: {agent.companyId}

{agent instructions from AGENTS.md if available}

{Paperclip skill content — heartbeat procedure, API reference, comment style}

You have access to the following tool categories:
- Paperclip API: manage issues, comments, subtasks
- File System: read, write, search files
- Shell: execute commands, git operations

Follow the Paperclip heartbeat procedure. Always checkout before working.
Always update issue status and comment before exiting.
```

### User-Prompt

Aufgebaut aus `context.paperclipWake`:
- Wake-Reason und Issue-Details
- Issue-Beschreibung
- Aktuelle Kommentare
- Prompt-Template (falls konfiguriert)

## Nicht im Scope

- MCP-Integration (kann später ergänzt werden)
- Websuche (kein zuverlässiges Tool dafür ohne externe API)
- Bild-/Datei-Upload zu Issues (Attachment-API nicht als Tool)
- Session-Persistenz über Heartbeats hinweg (Paperclip managed den Kontext)
- Approval-Workflow-Tools (erstmal manuell)
