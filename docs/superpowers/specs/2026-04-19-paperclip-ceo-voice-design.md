# Paperclip CEO — Voice & Telegram Bridge (V1)

**Datum:** 2026-04-19
**Autor:** Walter + Claude (Opus 4.7)
**Status:** Entwurf — zur Freigabe

## 1. Zweck

Walter will Aufgaben an seinen Paperclip-CEO-Agenten per Sprache und Text steuern — über Telegram (unterwegs) und SuperWhisper auf Mac/Windows (am Schreibtisch). V1 ist der Outbound-Kanal (Walter → CEO). Der Inbound-Kanal (CEO → Telegram-Push bei Task-Events) folgt in V2.

## 2. Scope

### In V1
- Telegram-Text und -Voice als Eingang
- SuperWhisper-Webhook für Mac und Windows (identischer Endpoint)
- AI-Agent versteht natürliche Sprache und ruft 4 Paperclip-Tools: `create_task`, `list_tasks`, `get_task`, `comment_task`
- Antwort synchron über den Eingangskanal (Telegram-Text/Voice oder Webhook-JSON)
- Postgres-Memory für Gesprächskontext (getrennt von Luna)

### Nicht in V1
- Push-Events von Paperclip nach Telegram (V2)
- Tägliche Zusammenfassung (V2)
- Status-Update-Tool (YAGNI — CEO steuert Status selbst)
- Dedizierter Messenger-Agent (V2 — V1 nutzt CEO-Key)
- Tailscale/Cloudflare-Tunnel (V1 bleibt LAN-only)

## 3. Architektur

```
┌─────────────────┐  ┌────────────────────┐
│ Telegram Trigger│  │ Webhook            │
│ (Text + Voice)  │  │ POST /paperclip/   │
│                 │  │      command       │
└────────┬────────┘  └──────────┬─────────┘
         │                      │
         │ STT bei Voice        │
         ▼                      ▼
       ┌──────────────────────────────┐
       │ Normalize + Filter (Walter)  │
       │ source / chatId / userText   │
       └──────────────┬───────────────┘
                      ▼
       ┌──────────────────────────────┐
       │ AI Agent (LM Studio Mistral) │
       │ + paperclip_chat_memory      │
       │ + 4 Paperclip-Tools          │
       └──────────────┬───────────────┘
                      ▼
       ┌──────────────────────────────┐
       │ Response-Router              │
       │ telegram → Text/Voice-Reply  │
       │ mac/windows → Webhook-JSON   │
       └──────────────────────────────┘
```

**Datei:** `Paperclip CEO – Voice & Telegram V1.json` (separate Workflow-Datei, Luna V10 bleibt unangetastet).

## 4. Eingänge

### 4.1 Telegram
- Trigger: `n8n-nodes-base.telegramTrigger` (update: message)
- Credentials: `Telegram account` (aus Luna wiederverwendet)
- User-Filter: Walter + Clara (IDs `8311805232`, `1220010628`)
- Normalize-Code baugleich zu Luna: extrahiert `chatId`, `messageId`, `userText`, `voiceFileId`, `inputType`, `username`
- Voice-Pfad: Telegram Get Voice File → ElevenLabs STT (`scribe_v1`) → Merge → `userText`
- `source = "telegram"`

### 4.2 SuperWhisper Webhook
- Trigger: `n8n-nodes-base.webhook`, Pfad `paperclip/command`, Methode `POST`, `responseMode: responseNode`
- Body-Schema: `{ text: string, source: "mac" | "windows" }`
- Normalize setzt: `chatId = $env.WALTER_TG_CHAT_ID` (für optional Telegram-Echo), `userText = $json.body.text`, `source = $json.body.source`, `inputType = "voice"`, `voiceFileId = ""` (leer = keine Audio-Antwort nötig)
- Kein Auth-Header in V1 (LAN-only, TCP-zugriff ist die Schutzschicht). Shared-Secret kann in V2 ergänzt werden.

## 5. Agent

- **Node:** `@n8n/n8n-nodes-langchain.agent` (Typ-Version 3)
- **LLM:** `@n8n/n8n-nodes-langchain.lmChatOpenAi` → `http://127.0.0.1:1234/v1` (LM Studio, Modell `mistral-small-3.2-24b-instruct-2506`, Credential `LM Studio M4 Max`)
- **Memory:** `@n8n/n8n-nodes-langchain.memoryPostgresChat`, Tabelle `paperclip_chat_memory`, Context-Window 100, session-key = `={{ $json.source + ':' + $json.chatId }}`
- **System-Prompt** (Kurzform, Finalversion in der Implementation):
  > Du bist die Telegram- und Voice-Brücke zwischen Walter und seinem CEO-Agenten in Paperclip.
  > Verstehe Walters Anweisung und führe sie via Paperclip-Tools aus. Antworte kurz auf Deutsch.
  > Regeln:
  > - Neue Tasks immer dem CEO-Agenten zuweisen (`assigneeAgentId = "506c873e-3a40-4483-9a45-0eb0fa1554bb"`).
  > - Bei Mehrdeutigkeit höflich zurückfragen, nicht raten.
  > - Bei Listen-Anfragen: max. 5 Tasks zeigen, je Task ID + Titel + Status.
  > - Keine Meta-Sätze. Kein "Ich werde jetzt …", sondern Ergebnis nennen.
- **Tools** (jeweils HTTP-Request-Tool mit Paperclip-Credential):

| Tool | Methode | URL | Body / Query |
|---|---|---|---|
| `create_task` | POST | `http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/issues` | `{ "title": "{title}", "description": "{description}", "status": "todo", "priority": "medium", "assigneeAgentId": "506c873e-3a40-4483-9a45-0eb0fa1554bb" }` |
| `list_tasks` | GET | `http://127.0.0.1:3100/api/companies/9cebf3cf-.../issues` | `?assigneeAgentId=506c873e-…&status=todo,in_progress,in_review,blocked` |
| `get_task` | GET | `http://127.0.0.1:3100/api/issues/{issueId}` | — |
| `comment_task` | POST | `http://127.0.0.1:3100/api/issues/{issueId}/comments` | `{ "body": "{body}" }` + Header `X-Paperclip-Run-Id: 7e8b9d2f-4a5c-4b6e-9d1f-0e2f4a6b8c10` (siehe §7.1) |

Parameter werden vom AI-Agent-LLM via `$fromAI('name', 'description', 'string')` gefüllt. URL-Parameter (z.B. `{issueId}`) werden per String-Concat im Expression-Modus gesetzt.

## 6. Response-Router

```
AI Agent output → Extract assistantText → IF source:
  "telegram" + voiceFileId not empty → ElevenLabs TTS → Send Voice
  "telegram" + text only             → Send Telegram Text
  "mac" | "windows"                  → Respond to Webhook JSON
                                       (optional: zusätzlich Telegram-Echo an WALTER_TG_CHAT_ID)
```

## 7. Auth & Credentials

- **n8n-Credential "Paperclip API"**: `httpHeaderAuth`, Header `Authorization: Bearer <KEY>`
- Key-Erzeugung einmalig:
  ```
  pnpm paperclipai agent local-cli 506c873e-3a40-4483-9a45-0eb0fa1554bb \
    --company-id 9cebf3cf-efe8-4597-a400-f06488900a87
  ```
- Der Output enthält `export PAPERCLIP_API_KEY=…` — dieser Wert wandert in den n8n-Credential.
- Wiederverwendung: `Telegram account`, `LM Studio M4 Max`, `ElevenLabs`, `Postgres Memory` — alle schon in Luna vorhanden.

### 7.1 Bridge-Run für mutierende Endpoints

Paperclip verlangt bei Issue-Mutationen (Comments, PATCH, Checkout) den Header `X-Paperclip-Run-Id` als **Foreign Key** gegen die `heartbeat_runs`-Tabelle. n8n ist kein echter Agent-Run, deshalb legen wir einmalig einen "Bridge-Run" an, den alle mutierenden Tools nutzen:

```sql
INSERT INTO heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at, finished_at)
VALUES (
  '7e8b9d2f-4a5c-4b6e-9d1f-0e2f4a6b8c10',
  '9cebf3cf-efe8-4597-a400-f06488900a87',
  '506c873e-3a40-4483-9a45-0eb0fa1554bb',
  'external_bridge',
  'completed',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;
```

Diese UUID wird im `comment_task`-Tool als fester Header `X-Paperclip-Run-Id` gesetzt. Alle Comments via Bridge sind in Paperclip-UI dadurch als zu diesem Run gehörig markiert — sauberes Audit. In V2, wenn wir einen echten Messenger-Agent haben, kann pro Call ein frischer Run erzeugt werden (`POST /api/heartbeat-runs`).

## 8. Datenbank

Neue Tabelle `paperclip_chat_memory` (Schema wie `tg_chat_memory` aus Luna, damit das LangChain-Postgres-Memory-Node funktioniert). Session-Key setzt sich aus `source + ':' + chatId` zusammen.

Migrations-SQL:
```sql
CREATE TABLE paperclip_chat_memory (
  id         bigserial PRIMARY KEY,
  session_id text        NOT NULL,
  role       text        NOT NULL,
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON paperclip_chat_memory (session_id, created_at DESC);
```

Das exakte Schema hängt davon ab, was der LangChain-Node erwartet — wird in der Implementation geprüft und angepasst.

## 9. Environment-Variablen

Auf dem Mac-n8n ergänzen:
- `WALTER_TG_CHAT_ID` — Walters Telegram-Chat-ID (für Echo bei Mac/Windows-Eingang, optional)
- `TELEGRAM_BOT_TOKEN` — falls noch nicht vorhanden (aus Luna bekannt)

## 10. Netz

- n8n-Bind: `0.0.0.0:5678` (bestätigt: `Test-NetConnection` aus Windows erfolgreich)
- Mac LAN-IP: `192.168.2.191` (statische DHCP-Reservierung empfohlen)
- SuperWhisper Webhook-URL auf beiden Geräten: `http://192.168.2.191:5678/webhook/paperclip/command`

## 11. Erfolgs-Kriterien

V1 ist erfolgreich, wenn:
1. "Telegram-Text → neuer Paperclip-Task": Walter schreibt "leg Task X an", der CEO-Agent sieht ihn in Paperclip, Walter bekommt Bestätigung mit Task-ID zurück
2. "Telegram-Voice → neuer Task": gleicher Flow, aber STT davor, Antwort als Sprachnachricht
3. "Telegram → Liste offene Tasks": Walter fragt "Was ist offen?", bekommt max. 5 Tasks mit ID/Titel/Status
4. "Telegram → Kommentar anhängen": Walter sagt "Zu WHI-3: XYZ", der Kommentar landet am Task
5. "SuperWhisper Mac → gleicher Flow": identische Ergebnisse für alle 4 Fälle über den Webhook
6. Gesprächskontext bleibt innerhalb einer Session erhalten (Rückfragen funktionieren)

## 12. Offene Punkte für V2

- Push-Kanal von Paperclip nach Telegram (wie löst der CEO den Webhook aus? Routine? Adapter-Hook?)
- Tägliche Zusammenfassung (Cron-Trigger in n8n, holt `list_tasks` + formatiert)
- Umstellung von CEO-Key auf dedizierten Messenger-Agent
- Shared-Secret-Header für den Mac/Windows-Webhook
- Windows-SuperWhisper-Setup-Anleitung (V1 setzt "funktioniert identisch zum Mac" voraus, nicht getestet)
