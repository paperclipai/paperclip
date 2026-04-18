# paperclip-adapter-lmstudio

Paperclip-Adapter für LM Studio (OpenAI-kompatible lokale LLMs) mit vollständigem Tool-Use.

## Was ist das?

Der Adapter verbindet Paperclip-Agenten mit lokalen LLMs in LM Studio und implementiert einen vollständigen Agent-Loop mit Tool-Use:

- **18 Tools** über Paperclip-API, Dateisystem und Shell/Git
- **OpenAI Function Calling** Standard (funktioniert mit allen LM Studio Modellen die Function Calling unterstützen)
- **Hybrid-Streaming:** Tool-Iterationen als Request-Response, finale Antwort als Token-Stream
- **Sicherheit:** Path-Traversal-Schutz, Shell-Timeouts, Run-ID-Audit-Trail

## Voraussetzungen

- Node.js 18+
- LM Studio läuft und die API ist aktiviert (Default: http://localhost:1234)
- Mindestens ein Modell in LM Studio geladen das Function Calling unterstützt (z.B. Gemma, Qwen, Llama)

## Installation

```bash
cd paperclip-adapter-lmstudio
pnpm install
pnpm build
```

Registrierung in `~/.paperclip/adapter-plugins.json`:

```json
[
  {
    "packageName": "paperclip-adapter-lmstudio",
    "localPath": "/absoluter/pfad/zu/paperclip-adapter-lmstudio",
    "type": "lmstudio_local",
    "installedAt": "2026-04-18T00:00:00.000Z"
  }
]
```

Paperclip-Server neu starten.

## Konfiguration (pro Agent)

| Feld | Typ | Default | Beschreibung |
|------|-----|---------|-------------|
| `url` | text | `http://localhost:1234` | LM Studio Server-URL |
| `defaultModel` | select | — | Modell (Dropdown mit geladenen Modellen) |
| `timeoutMs` | number | `120000` | Timeout für einzelne LLM-Calls (ms) |
| `streamingEnabled` | boolean | `true` | Token-Streaming aktivieren |
| `maxIterations` | number | `25` | Max. Tool-Aufrufe pro Heartbeat |

## Verfügbare Tools

**Paperclip-API (8):** `paperclip_get_identity`, `paperclip_get_inbox`, `paperclip_checkout_issue`, `paperclip_update_issue`, `paperclip_add_comment`, `paperclip_get_issue_context`, `paperclip_get_comments`, `paperclip_create_subtask`

**Dateisystem (5):** `fs_read_file`, `fs_write_file`, `fs_list_directory`, `fs_glob`, `fs_grep`

**Shell & Git (5):** `shell_exec`, `git_status`, `git_diff`, `git_commit`, `git_log`

## Tests

```bash
pnpm test
```

## Modell-Empfehlungen

Tool-Use erfordert Function Calling. Getestete Modelle:

- **gemma-4-31b-it** — solide Tool-Use, empfohlen für Haupt-Agents
- **qwen/qwen3-14b** — schnell, Tool-Use funktioniert
- **qwen2.5-32b-instruct** — sehr gute Tool-Use-Genauigkeit

Modelle ohne Function Calling Support produzieren oft Kauderwelsch — vorher mit einem simplen API-Call testen.

## Troubleshooting

- **Agent antwortet nicht / hängt:** Timeout prüfen, bei 70B+ Modellen auf 300s+ erhöhen
- **Tool-Calls werden ignoriert:** Modell-Kompatibilität prüfen (muss Function Calling können)
- **Max iterations reached:** `maxIterations` erhöhen oder Aufgaben kleiner machen
