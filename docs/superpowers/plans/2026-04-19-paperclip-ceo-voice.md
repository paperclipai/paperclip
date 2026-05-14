# Paperclip CEO — Voice & Telegram Bridge V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Einen n8n-Workflow bauen, mit dem Walter per Telegram (Text/Voice) und SuperWhisper-Webhook (Mac/Windows) seinem Paperclip-CEO-Agenten Aufgaben geben und Tasks abfragen kann. Antwort synchron über den Eingangskanal.

**Architecture:** Neuer n8n-Workflow `Paperclip CEO – Voice & Telegram V1.json` mit zwei Triggern (Telegram + Webhook `/paperclip/command`), einem LangChain-AI-Agent auf LM Studio Mistral 24b mit 4 HTTP-Tools gegen die Paperclip-REST-API, separater Postgres-Chat-Memory-Tabelle, und einem Response-Router der zwischen Telegram-Text, Telegram-Voice (TTS) und Webhook-JSON entscheidet.

**Tech Stack:** n8n (self-hosted), LangChain-Agent-Node, LM Studio (Mistral Small 3.2 24b), ElevenLabs STT/TTS, PostgreSQL, Paperclip REST API auf 127.0.0.1:3100, SuperWhisper (Mac + Windows) für Voice-Input.

**Spec-Referenz:** [docs/superpowers/specs/2026-04-19-paperclip-ceo-voice-design.md](../specs/2026-04-19-paperclip-ceo-voice-design.md)

**Arbeitsverzeichnis:** Plan wird direkt auf `master` ausgeführt — additiv, keine Änderungen an bestehenden Dateien (Luna V10 bleibt unberührt). Ein Worktree wäre Overkill für neue Dateien.

---

## Datei-Struktur

**Neu anzulegen:**
- `Paperclip CEO - Voice & Telegram V1.json` — n8n-Workflow-Export (Projekt-Root, analog zu Luna)
- `paperclip_chat_memory.sql` — einmalige Migration für die Memory-Tabelle (Projekt-Root)
- `docs/guides/superwhisper-paperclip.md` — Kurz-Setup-Anleitung für SuperWhisper-Mode auf Mac & Windows

**Nicht zu ändern:**
- `Luna Voice + Telegram V10.json` — bleibt unangetastet

---

## Vorbereitung (einmalig, vor Task 1)

Diese Schritte erfordern Walters Umgebung und werden interaktiv bestätigt, nicht automatisiert:

- [ ] **V-1: CEO-Agent API-Key erzeugen**

  ```bash
  cd "/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip"
  pnpm paperclipai agent local-cli 506c873e-3a40-4483-9a45-0eb0fa1554bb \
    --company-id 9cebf3cf-efe8-4597-a400-f06488900a87
  ```

  Erwartete Ausgabe: mehrere `export`-Zeilen, darunter `export PAPERCLIP_API_KEY=eyJ…`. Den Wert von `PAPERCLIP_API_KEY` notieren (wird in Task 5 in n8n als Credential hinterlegt).

- [ ] **V-2: Walters Telegram-Chat-ID ermitteln**

  In der existierenden Luna-Postgres-Tabelle `tg_chat_users` ist die Chat-ID schon persistiert. Schnell-Abfrage:

  ```bash
  psql "postgres://<luna-connstr>" -c "SELECT chat_id, first_name FROM tg_chat_users;"
  ```

  Alternativ: Luna einmal antexten, n8n-Log zeigt `chatId`. Wert notieren für `.env`-Eintrag in V-4.

- [ ] **V-3: n8n-Bind auf LAN prüfen**

  ```bash
  lsof -i :5678 | head -5
  ```

  Erwartet: `node` lauscht auf `*:5678` (nicht `localhost:5678`). Falls nur localhost: n8n-Config `N8N_HOST=0.0.0.0` setzen und neu starten. (Test aus Windows vom 19.04.2026 bestätigte bereits `TcpTestSucceeded: True`, Bind scheint korrekt.)

- [ ] **V-4: Env-Vars für n8n setzen**

  In der n8n-Startumgebung ergänzen (je nach Start-Methode — PM2/launchd/docker — die jeweilige Config):

  ```
  WALTER_TG_CHAT_ID=<Wert aus V-2>
  ```

  `TELEGRAM_BOT_TOKEN` existiert bereits (aus Luna).

---

## Task 1: Memory-Tabelle anlegen

**Files:**
- Create: `paperclip_chat_memory.sql`

- [ ] **Step 1: SQL-Datei schreiben**

```sql
-- paperclip_chat_memory.sql
-- Chat-Memory für den Paperclip CEO Voice & Telegram Workflow (V1)
-- Separate Tabelle, damit Luna-Memory (tg_chat_memory) nicht vermischt wird.

CREATE TABLE IF NOT EXISTS paperclip_chat_memory (
  id         bigserial PRIMARY KEY,
  session_id text        NOT NULL,
  role       text        NOT NULL,
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paperclip_chat_memory_session_idx
  ON paperclip_chat_memory (session_id, created_at DESC);
```

- [ ] **Step 2: Migration ausführen**

Gegen die gleiche Postgres-Instanz, die auch Luna's `tg_chat_memory` hostet (Credential `Postgres Memory` in n8n):

```bash
psql "<connection-string-from-n8n-Postgres-Memory-credential>" \
  -f paperclip_chat_memory.sql
```

Erwartet: `CREATE TABLE` + `CREATE INDEX`. Bei Wiederholung: `NOTICE: relation already exists, skipping`.

- [ ] **Step 3: Tabelle verifizieren**

```bash
psql "<connstr>" -c "\d paperclip_chat_memory"
```

Erwartet: Spalten `id`, `session_id`, `role`, `content`, `created_at` mit korrekten Typen, plus Primary Key und Session-Index.

- [ ] **Step 4: Commit**

```bash
git add paperclip_chat_memory.sql
git commit -m "feat(paperclip-ceo-bridge): add chat memory table migration"
```

---

## Task 2: Workflow-Skelett aus Luna ableiten

**Files:**
- Create: `Paperclip CEO - Voice & Telegram V1.json`

Statt einen leeren Workflow zu bauen, kopieren wir Luna als Ausgangspunkt und strippen die nicht benötigten Teile. Das spart 80% der Verdrahtung (STT, TTS, User-Filter, Merge-Patterns sind schon korrekt konfiguriert).

- [ ] **Step 1: Luna-Datei kopieren**

```bash
cp "Luna Voice + Telegram V10.json" "Paperclip CEO - Voice & Telegram V1.json"
```

- [ ] **Step 2: `name`- und `id`-Felder anpassen**

In der neuen Datei:
- `"name": "Luna Voice + Telegram V10"` → `"name": "Paperclip CEO - Voice & Telegram V1"`
- `"id": "yAkktsDiwjZMpLZv"` → `"id": ""` (n8n vergibt beim Import eine neue ID)
- `"versionId": "…"` → `"versionId": ""`

- [ ] **Step 3: Workflow in n8n importieren**

Im n8n-UI: Workflows → Import from File → `Paperclip CEO - Voice & Telegram V1.json`.
Erwartet: Neuer Workflow erscheint, deaktiviert, mit allen Luna-Nodes. Telegram-/Postgres-/LM-Studio-/ElevenLabs-Credentials sollten automatisch gemappt werden (gleiche IDs).

- [ ] **Step 4: Sanity-Check**

Workflow-Canvas laden. Erwartet: Alle Nodes sichtbar, keine roten Fehler-Marker auf Credentials. Falls ein Node rot ist: Credential manuell re-selektieren (gleicher Name wie in Luna).

- [ ] **Step 5: Commit**

```bash
git add "Paperclip CEO - Voice & Telegram V1.json"
git commit -m "feat(paperclip-ceo-bridge): scaffold workflow from Luna V10"
```

---

## Task 3: Webhook-Pfad umbiegen und Body-Schema anpassen

**Files:**
- Modify: `Paperclip CEO - Voice & Telegram V1.json` (Nodes "Webhook (Luna Voice)" + "Normalize Webhook Input")

Luna's Webhook hört auf `luna/voice` und erwartet `{ chatId, text, username, messageId }`. Wir ändern auf `paperclip/command` mit `{ text, source }`.

- [ ] **Step 1: Webhook-Path ändern (n8n-UI)**

Node "Webhook (Luna Voice)":
- `path`: `luna/voice` → `paperclip/command`
- Node umbenennen: "Webhook (Luna Voice)" → "Webhook (Paperclip Command)"
- Übrige Parameter unverändert (POST, `responseNode`).

- [ ] **Step 2: Normalize-Input anpassen**

Node "Normalize Webhook Input" → Values komplett ersetzen:

```json
{
  "number": [
    {
      "name": "chatId",
      "value": "={{ Number($env.WALTER_TG_CHAT_ID ?? 0) }}"
    }
  ],
  "string": [
    {
      "name": "source",
      "value": "={{ $json.body?.source ?? 'mac' }}"
    },
    {
      "name": "inputType",
      "value": "voice"
    },
    {
      "name": "userText",
      "value": "={{ $json.body?.text ?? '' }}"
    },
    {
      "name": "voiceFileId",
      "value": ""
    },
    {
      "name": "username",
      "value": "Walter"
    }
  ]
}
```

- [ ] **Step 3: IF-Source-Node vorbereiten**

Node "IF Source is Luna?" → umbenennen "IF Source is Webhook?" und die Condition ändern:
- `leftValue`: `={{ $json.source }}`
- `rightValue`: `luna` → `mac,windows` (Operator bleibt equals — wir checken gleich unten besser)
- Besser: Operator `contains` mit `rightValue: mac` und zweite Bedingung `contains: windows`, Combinator `or`. Oder noch einfacher: `rightValue: telegram`, Operator `notEquals` — dann ist der "true"-Zweig = Webhook-Response.

Zur Klarheit gehe den letzteren Weg (Bedingung: "is NOT telegram"):
- `leftValue`: `={{ $json.source }}`
- `rightValue`: `telegram`
- `operator`: `notEquals`

- [ ] **Step 4: Manueller Workflow-Test (ohne Agent)**

Workflow deaktiviert lassen. In n8n-UI: Auf "Webhook (Paperclip Command)" klicken → "Test workflow" (listen mode). Aus Terminal:

```bash
curl -X POST http://127.0.0.1:5678/webhook-test/paperclip/command \
  -H "Content-Type: application/json" \
  -d '{"text":"Hallo CEO","source":"mac"}'
```

Erwartet: Workflow startet, "Normalize Webhook Input" setzt `userText="Hallo CEO"`, `source="mac"`, `voiceFileId=""`. Weiterer Fluss führt durch LM-Studio-Check und scheitert später am noch nicht konfigurierten Agent — das ist OK für diesen Test.

- [ ] **Step 5: Workflow-JSON aus n8n exportieren**

n8n-UI: Workflow → Download → `Paperclip CEO - Voice & Telegram V1.json` im Projekt-Root ersetzen.

- [ ] **Step 6: Commit**

```bash
git add "Paperclip CEO - Voice & Telegram V1.json"
git commit -m "feat(paperclip-ceo-bridge): rename webhook to paperclip/command"
```

---

## Task 4: Agent-Konfiguration auf Paperclip-Persona umstellen

**Files:**
- Modify: `Paperclip CEO - Voice & Telegram V1.json` (Node "AI Agent", Node "Postgres Chat Memory")

- [ ] **Step 1: System-Prompt des AI-Agent ersetzen**

Node "AI Agent" → `options.systemMessage` → Inhalt ersetzen:

```
# ROLLE
Du bist die Telegram- und Voice-Brücke zwischen Walter und seinem CEO-Agenten in Paperclip.
Dein Job: Walters Anweisungen in Paperclip-Aktionen umsetzen.

# REGELN
- Antworte NUR auf Deutsch.
- Gib NUR die finale Antwort aus, keine Meta-Sätze ("Ich werde jetzt ..." ist verboten).
- Bei "Task anlegen" / "Aufgabe für den CEO" etc. → Tool `create_task` aufrufen.
  Assignee ist IMMER der CEO-Agent (Agent-ID "506c873e-3a40-4483-9a45-0eb0fa1554bb").
- Bei "Was ist offen?" / "Status?" / "Was macht der CEO?" → Tool `list_tasks`, max. 5 ausgeben mit Identifier + Titel + Status.
- Bei "Zu WHI-X: ..." / "Kommentiere Task Y" → erst `get_task` um die Issue-ID zu finden, dann `comment_task`.
- Bei Mehrdeutigkeit: höflich einmal zurückfragen statt zu raten.
- Format bei Task-Anlage-Bestätigung: "Task angelegt: {identifier} — {titel}"
```

- [ ] **Step 2: Postgres-Chat-Memory auf neue Tabelle zeigen**

Node "Postgres Chat Memory" — das LangChain-Node verwaltet die Tabelle implizit über ein Parameter-Feld. Im Node-Editor:
- `tableName`: `paperclip_chat_memory` (falls Parameter sichtbar)
- `sessionIdType`: `customKey` (oder gleichwertig)
- `sessionKey`: `={{ $json.source + ':' + $json.chatId }}` (im Node "Edit Fields" bereits so gesetzt, wird durch das `sessionId`-Feld propagiert)

Wenn der Node keine direkte `tableName`-Option hat, sondern die Standard-Tabelle `n8n_chat_histories` nutzt: Workflow-Datei öffnen und im Node-JSON explizit `tableName` in `parameters` eintragen:

```json
"parameters": {
  "contextWindowLength": 100,
  "tableName": "paperclip_chat_memory",
  "sessionIdType": "customKey",
  "sessionKey": "={{ $json.sessionId }}"
}
```

- [ ] **Step 3: Test-Anfrage ohne Tools**

Workflow in n8n starten (aktivieren oder Test-Mode). Curl:

```bash
curl -X POST http://127.0.0.1:5678/webhook-test/paperclip/command \
  -H "Content-Type: application/json" \
  -d '{"text":"Hallo, wer bist du?","source":"mac"}'
```

Erwartet: Agent antwortet deutsch, kurz, beschreibt sich als Brücke zum CEO. Response-JSON enthält `assistantText` mit deutscher Antwort. Postgres-Check:

```bash
psql "<connstr>" -c "SELECT session_id, role, LEFT(content, 50) FROM paperclip_chat_memory ORDER BY created_at DESC LIMIT 4;"
```

Erwartet: Zwei Zeilen (user + assistant) mit `session_id = 'mac:<chatId>'`.

- [ ] **Step 4: Export & Commit**

```bash
git add "Paperclip CEO - Voice & Telegram V1.json"
git commit -m "feat(paperclip-ceo-bridge): configure agent persona and memory"
```

---

## Task 5: Paperclip-Credential in n8n anlegen

**Files:** keine (nur n8n-UI-Konfiguration)

- [ ] **Step 1: Neue Credential "Paperclip API" anlegen**

n8n-UI → Credentials → New → Type `Header Auth`:
- Name: `Paperclip API`
- Header Name: `Authorization`
- Header Value: `Bearer <PAPERCLIP_API_KEY aus V-1>`

Speichern.

- [ ] **Step 2: Verifizieren mit curl (ohne n8n)**

```bash
curl -s -H "Authorization: Bearer <KEY>" \
  http://127.0.0.1:3100/api/agents/me | head -c 300
```

Erwartet: JSON mit `id`, `companyId`, `role`. Falls `401`: Key stimmt nicht, V-1 wiederholen.

Kein Commit — Credentials sind nicht im JSON-Export enthalten (nur als ID-Referenz).

---

## Task 6: Tool `create_task` hinzufügen

**Files:**
- Modify: `Paperclip CEO - Voice & Telegram V1.json` (neuer Node + Verbindung zum AI Agent)

Die 4 Tools werden als `@n8n/n8n-nodes-langchain.toolHttpRequest` angelegt (HTTP-Tool für den Agent). Jedes Tool hat einen Namen, eine Description für das LLM, eine HTTP-Config und ein Parameter-Schema.

- [ ] **Step 1: Node "create_task" hinzufügen**

n8n-Canvas → neuen Node vom Typ `HTTP Request Tool` (unter "Tools" für AI Agent) einfügen. Parameter:

- **Name** (intern): `create_task`
- **Description** (für LLM): `Legt einen neuen Task im Paperclip-Board an. Assignee ist immer der CEO-Agent. Nutze diese Funktion, wenn Walter eine neue Aufgabe erteilen will. Titel kurz und prägnant, Description optional mit Kontext.`
- **Method**: `POST`
- **URL**: `http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/issues`
- **Authentication**: Generic Credential Type → `Header Auth` → `Paperclip API`
- **Send Body**: JSON
- **Body Parameters** (`specifyBodyFromAI`-Modus wo möglich):

  ```json
  {
    "title": "{title}",
    "description": "{description}",
    "status": "todo",
    "priority": "medium",
    "assigneeAgentId": "506c873e-3a40-4483-9a45-0eb0fa1554bb"
  }
  ```

  Felder `{title}` und `{description}` werden vom Agent-LLM dynamisch gefüllt. In n8n LangChain-Tool-Nodes: `parameters.placeholderDefinitions` bzw. für Tool-HTTP `toolDescription` nutzen — exakte Syntax je nach n8n-Version, im UI über "Use AI to fill parameters" aktivieren.

- **Response Handling**: `Response Format: JSON` (Default).

- [ ] **Step 2: Node mit AI Agent verbinden**

Node-Output (Typ `ai_tool`) → Input des Nodes "AI Agent" (Slot `ai_tool`).

- [ ] **Step 3: Manueller Test**

Test-Curl:

```bash
curl -X POST http://127.0.0.1:5678/webhook-test/paperclip/command \
  -H "Content-Type: application/json" \
  -d '{"text":"Leg dem CEO bitte einen Test-Task an: Plan-Dokument lesen.","source":"mac"}'
```

Erwartet:
1. Agent entscheidet sich für `create_task`-Tool.
2. HTTP POST erfolgt gegen Paperclip.
3. Paperclip antwortet mit `{ identifier: "WHI-5", ... }` (oder nächster freier Counter).
4. Agent-Antwort im curl-Response: `Task angelegt: WHI-5 — Plan-Dokument lesen`.

Verifizieren in Paperclip UI: `http://127.0.0.1:3100` → WHITESTAG-Board → neuer Task sichtbar, zugewiesen an CEO.

- [ ] **Step 4: Export & Commit**

```bash
git add "Paperclip CEO - Voice & Telegram V1.json"
git commit -m "feat(paperclip-ceo-bridge): add create_task tool"
```

---

## Task 7: Tool `list_tasks` hinzufügen

**Files:**
- Modify: `Paperclip CEO - Voice & Telegram V1.json`

- [ ] **Step 1: Node "list_tasks" hinzufügen**

Neuer HTTP Request Tool:
- **Name**: `list_tasks`
- **Description**: `Listet offene Tasks des CEO-Agenten auf. Nutze diese Funktion, wenn Walter nach Status, offenen Aufgaben oder dem aktuellen Stand fragt. Gibt maximal die neuesten Issues zurück — formatiere die Antwort mit Identifier, Titel und Status, maximal 5 Einträge.`
- **Method**: `GET`
- **URL**: `http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/issues`
- **Query Parameters**:
  - `assigneeAgentId`: `506c873e-3a40-4483-9a45-0eb0fa1554bb`
  - `status`: `todo,in_progress,in_review,blocked`
- **Authentication**: `Paperclip API` (wie oben).

- [ ] **Step 2: Test**

```bash
curl -X POST http://127.0.0.1:5678/webhook-test/paperclip/command \
  -H "Content-Type: application/json" \
  -d '{"text":"Was hat der CEO gerade offen?","source":"mac"}'
```

Erwartet: Agent ruft `list_tasks`, bekommt Array, antwortet mit max. 5 Tasks im Format "WHI-1 — Projekte definieren (in_progress)", etc.

- [ ] **Step 3: Commit**

```bash
git add "Paperclip CEO - Voice & Telegram V1.json"
git commit -m "feat(paperclip-ceo-bridge): add list_tasks tool"
```

---

## Task 8: Tool `get_task` hinzufügen

**Files:**
- Modify: `Paperclip CEO - Voice & Telegram V1.json`

- [ ] **Step 1: Node "get_task" hinzufügen**

- **Name**: `get_task`
- **Description**: `Lädt Detailinformationen zu einem Paperclip-Task inklusive Ancestor-Kontext. Nutze diese Funktion, wenn Walter nach einem bestimmten Task fragt ("Wie steht's mit WHI-3?"). Parameter issueId ist entweder eine UUID oder ein Identifier wie "WHI-3".`
- **Method**: `GET`
- **URL**: `http://127.0.0.1:3100/api/issues/{issueId}` — `{issueId}` als AI-Parameter.

- [ ] **Step 2: Test**

```bash
curl -X POST http://127.0.0.1:5678/webhook-test/paperclip/command \
  -H "Content-Type: application/json" \
  -d '{"text":"Wie steht es mit WHI-1?","source":"mac"}'
```

Erwartet: Agent ruft `get_task` mit `issueId="WHI-1"`, fasst Titel + Status + letzten Comment zusammen.

Falls Paperclip bei Identifier-Zugriff mit UUID-Erwartung antwortet (`404`), im Agent-Prompt explizit anweisen: "Nutze erst `list_tasks` um die UUID zu finden, dann `get_task`." — anpassen in Task 4's System-Prompt.

- [ ] **Step 3: Commit**

```bash
git add "Paperclip CEO - Voice & Telegram V1.json"
git commit -m "feat(paperclip-ceo-bridge): add get_task tool"
```

---

## Task 9: Tool `comment_task` hinzufügen

**Files:**
- Modify: `Paperclip CEO - Voice & Telegram V1.json`

- [ ] **Step 1: Node "comment_task" hinzufügen**

- **Name**: `comment_task`
- **Description**: `Schreibt einen Kommentar an einen Paperclip-Task. Nutze diese Funktion, wenn Walter einem bestehenden Task Kontext, Anweisungen oder Feedback hinzufügen will ("Sag dem CEO zu WHI-2 dass ..."). Parameter issueId = UUID oder Identifier. Parameter body = Kommentartext in Markdown.`
- **Method**: `POST`
- **URL**: `http://127.0.0.1:3100/api/issues/{issueId}/comments`
- **Body** (JSON):

  ```json
  { "body": "{body}" }
  ```

- [ ] **Step 2: Test**

```bash
curl -X POST http://127.0.0.1:5678/webhook-test/paperclip/command \
  -H "Content-Type: application/json" \
  -d '{"text":"Zu dem Test-Task: Bitte bis morgen Abend erledigen.","source":"mac"}'
```

Erwartet: Agent kontextualisiert "Test-Task" über Memory zur zuletzt angelegten Issue, ruft `comment_task`, bestätigt: "Kommentar hinterlegt an WHI-5." In der Paperclip-UI sichtbar.

- [ ] **Step 3: Commit**

```bash
git add "Paperclip CEO - Voice & Telegram V1.json"
git commit -m "feat(paperclip-ceo-bridge): add comment_task tool"
```

---

## Task 10: End-to-End-Test Telegram-Text

**Files:** keine Änderungen — Verifizierung mit echter Telegram-App.

- [ ] **Step 1: Workflow aktivieren**

n8n-UI → Workflow aktivieren (Schalter oben rechts).

- [ ] **Step 2: Test-Nachrichten an Telegram-Bot**

Aus Walters Telegram-App an den Bot:

1. `Leg einen Task an: SuperWhisper-Mode fertig einrichten.` → erwarte: "Task angelegt: WHI-N — SuperWhisper-Mode fertig einrichten"
2. `Was ist offen?` → erwarte: Liste mit max. 5 Tasks
3. `Zu dem letzten Task: bis Freitag erledigen.` → erwarte: "Kommentar hinterlegt"
4. `Wie steht's mit WHI-1?` → erwarte: Zusammenfassung von WHI-1

Erfolgs-Kriterium: Alle 4 Interaktionen funktionieren. In Paperclip UI entsprechende Tasks/Kommentare sichtbar.

- [ ] **Step 3: Troubleshooting-Log**

Falls ein Schritt fehlschlägt: n8n-Executions-Log öffnen, den Run anschauen, den Fehler-Node identifizieren. Typische Fehler:
- `401` von Paperclip → Credential-Header prüfen
- Agent ruft falsches Tool → Description schärfen
- Memory-Verlust zwischen Nachrichten → `sessionKey` in Postgres-Memory prüfen

---

## Task 11: End-to-End-Test Telegram-Voice

**Files:** keine Änderungen.

- [ ] **Step 1: Sprach-Nachricht senden**

Aus Telegram-App: Mikrofon-Taste gedrückt halten, sprechen: "Leg mir bitte einen Task an: n8n-Workflow für Paperclip testen.", loslassen, senden.

- [ ] **Step 2: Erwartetes Verhalten**

1. Telegram-Trigger erkennt `voice.file_id`.
2. ElevenLabs STT transkribiert.
3. Agent ruft `create_task`.
4. Antwort kommt als **Voice-Nachricht** (TTS) zurück: "Task angelegt …".

Erfolgs-Kriterium: Sprachnachricht mit deutschem CEO-Voice-Bestätigung im Chat.

---

## Task 12: End-to-End-Test SuperWhisper-Webhook (Mac)

**Files:**
- Create: `docs/guides/superwhisper-paperclip.md`

- [ ] **Step 1: SuperWhisper-Mode auf Mac einrichten**

SuperWhisper → Settings → Modes → "+ New Mode":
- Name: `Paperclip CEO`
- Hotkey: `⌘⇧P`
- Language: `German`
- Output: `Custom URL (Webhook)`
- URL: `http://192.168.2.191:5678/webhook/paperclip/command`
- Method: `POST`
- Body: `{"text": "{{transcript}}", "source": "mac"}`
- Display response: `Notification with body text`

- [ ] **Step 2: Test**

Hotkey drücken, sprechen: "Frag mal den CEO, was gerade alles offen ist.", loslassen.

Erwartet: macOS-Benachrichtigung mit Liste offener Tasks erscheint. In n8n-Execution-Log: entsprechender Run sichtbar.

- [ ] **Step 3: Setup-Guide schreiben**

```markdown
# SuperWhisper → Paperclip CEO Setup

Kurzanleitung für den SuperWhisper-Mode, der Sprachbefehle an den
Paperclip-CEO-Agenten sendet — identisch nutzbar auf Mac und Windows.

## Voraussetzungen
- n8n läuft auf dem Mac, Workflow "Paperclip CEO - Voice & Telegram V1" aktiv
- LAN-Zugang zum Mac (IP 192.168.2.191)
- SuperWhisper installiert (Mac oder Windows)

## Mode-Konfiguration
- Name: Paperclip CEO
- Hotkey: ⌘⇧P (Mac) / Ctrl⇧P (Windows)
- Sprache: Deutsch
- Output-Typ: Custom Webhook (POST)
- URL: `http://192.168.2.191:5678/webhook/paperclip/command`
- Body:
  ```json
  {"text": "{{transcript}}", "source": "mac"}
  ```
  (auf Windows: `"source": "windows"`)
- Response-Anzeige: macOS-Notification / Windows-Toast mit Response-Body

## Custom Vocabulary (pro Mode empfohlen)
- WHITESTAG, Paperclip, DSGVO, AVV, CEO, WHI

## Test
Hotkey drücken, sagen: "Was ist offen?" — Notification mit Task-Liste
sollte innerhalb von ~3 Sekunden erscheinen.
```

- [ ] **Step 4: Commit**

```bash
git add docs/guides/superwhisper-paperclip.md
git commit -m "docs(paperclip-ceo-bridge): add SuperWhisper setup guide"
```

---

## Task 13: Memory-Persistenz testen

**Files:** keine.

- [ ] **Step 1: Multi-Turn-Konversation über Telegram-Text**

1. `Leg einen Task an: Speicher-Test.` → erwarte Task-Anlage
2. `Wie war die ID davon?` → erwarte: Agent erinnert sich an die gerade erzeugte Identifier und nennt sie
3. `Kommentiere den mit: Dies ist ein Kommentar aus dem Memory-Test.` → erwarte: Kommentar landet am richtigen Task (über Memory auflösen)

- [ ] **Step 2: Postgres-Verifikation**

```bash
psql "<connstr>" -c "SELECT session_id, role, LEFT(content, 60), created_at
  FROM paperclip_chat_memory
  WHERE session_id LIKE 'telegram:%'
  ORDER BY created_at DESC LIMIT 10;"
```

Erwartet: Alternierend `user`/`assistant`-Rollen, alle mit gleichem `session_id`.

- [ ] **Step 3: Cross-Channel-Isolation prüfen**

Aus SuperWhisper: "Was haben wir gerade besprochen?" — Agent sollte **nicht** auf den Telegram-Verlauf zurückgreifen, sondern eine leere/neutrale Antwort geben (verschiedene `sessionId`s).

---

## Task 14: Finaler Export und Workflow-Commit

**Files:**
- Modify: `Paperclip CEO - Voice & Telegram V1.json` (finaler n8n-Export)

- [ ] **Step 1: Finalen Export aus n8n ziehen**

n8n-UI → Workflow → Download JSON. Datei auf Projekt-Root ersetzen.

- [ ] **Step 2: JSON-Sanity**

```bash
jq '.name, .nodes | length' "Paperclip CEO - Voice & Telegram V1.json"
```

Erwartet: Name `"Paperclip CEO - Voice & Telegram V1"`, ca. 30+ Nodes.

- [ ] **Step 3: Commit**

```bash
git add "Paperclip CEO - Voice & Telegram V1.json"
git commit -m "feat(paperclip-ceo-bridge): V1 final export after end-to-end tests"
```

- [ ] **Step 4: Abschluss-Memo**

In der Session: kurz bestätigen, dass V1-Scope erfüllt ist. V2-Themen (Event-Push, Tagessummary, Messenger-Agent-Hire, Shared-Secret) bleiben in der Spec unter "Offene Punkte für V2" und warten auf eigenen Brainstorm-/Plan-Zyklus.

---

## Self-Review-Ergebnis

**Spec-Coverage:**
- §4.1 Telegram-Eingang → Task 2 (Luna-Skelett erbt das unverändert)
- §4.2 Webhook → Task 3
- §5 Agent/LLM/Memory → Task 4
- §5 Tools → Tasks 6–9
- §6 Response-Router → Task 2 (unverändert aus Luna) + Task 3 (IF-Condition)
- §7 Auth → V-1 + Task 5
- §8 DB → Task 1
- §9 Env-Vars → V-4
- §10 Netz → V-3
- §11 Erfolgs-Kriterien 1–6 → Tasks 10, 11, 12, 13 decken alle 6 ab

**Placeholder-Scan:** keine "TBD/TODO/implement later". Zwei bewusste Unschärfen dokumentiert: (a) n8n-Tool-Parameter-Syntax ("exakte Syntax je nach n8n-Version") — begründet durch API-Drift des Nodes; (b) potenzieller `404`-Fallback bei `get_task` mit Identifier statt UUID — als Troubleshooting-Hinweis, nicht als Placeholder.

**Typ-Konsistenz:** Tool-Namen (`create_task`, `list_tasks`, `get_task`, `comment_task`) sind in System-Prompt, Tool-Nodes und Test-Erwartungen identisch. `session_id`-Schema `source:chatId` ist in Task 4 Step 2 und Task 13 Step 2 konsistent.
