# Chatverlauf — Cloudflare-Umstellung, Tool-Calls, V3-Fixes

**Datum:** 2026-04-21
**Projekt:** Paperclip CEO — Voice & Telegram Bridge
**Ausgangslage:** Umstellung von ngrok auf Cloudflare abgeschlossen. Offen: Telegram-Webhook, n8n-Konfig, Tool-Calls stabilisieren.

## 1. Cloudflare-Umstellung (ngrok → n8n.whitestag.ai)

**Drei Stellen angepasst:**

1. **Telegram Webhook neu registrieren** via `setWebhook`-Call auf die neue URL. Wichtig: kein Doppelslash (`n8n.whitestag.ai//webhook/...`), kein fehlender Doppelpunkt im Bot-Token. Korrekter curl:
   ```bash
   curl "https://api.telegram.org/bot8490463765:AAFYCb.../setWebhook?url=https://n8n.whitestag.ai/webhook/30937b26-e0eb-4e2b-9105-a0dbf51acfe7"
   ```
2. **n8n-Env-Vars** in `~/Desktop/n8n.sh`: `WEBHOOK_URL=https://n8n.whitestag.ai`, `N8N_EDITOR_BASE_URL=https://n8n.whitestag.ai`
3. **Credentials:** Keine URL-Referenzen darin, aber Hardcoded-URLs in HTTP-Request-Nodes prüfen

## 2. Luna V10 vs. Paperclip V2 Webhook-Konflikt

Beide Workflows hatten dieselbe Telegram Trigger `webhookId` (V2 war Kopie von V10). n8n erlaubt nur einen aktiven Workflow pro Webhook-Pfad.

**Fix:** Luna V10 deaktiviert, V2 aktiviert. Ein Telegram-Bot kann ohnehin nur eine Webhook-URL haben — beide parallel aktiv war nie sinnvoll.

## 3. n8n-Startup-Script dokumentiert

Walter startet alle lokalen Tools idempotent via `~/Desktop/n8n.sh`:
- Startet: Postgres, n8n, Audio Player, Voice Agent, ComfyUI, CCC-Film, Paperclip, Cannabis-GUI
- PIDs in `~/.whitestag-pids/`, Logs in `~/.whitestag-logs/`
- Prüft PID-Files vor Start → läuft ein Dienst schon, wird er übersprungen
- Für einzelnen Restart: `kill $(cat ~/.whitestag-pids/<dienst>.pid) && ~/Desktop/n8n.sh`

**Memory gesetzt:** `reference_n8n_startup.md`

## 4. Tool-Calls stabilisieren — der lange Weg

### Erstes Symptom: `TOOL_CALLS<SPECIAL_32>list_tasks{}`
Mistral-Small-3.2-24B emittierte Tool-Calls im Mistral-Nativformat (`<SPECIAL_32>` = Mistrals `[TOOL_CALLS]`-Token). LM Studio parste sie nicht in OpenAI-kompatibles `tool_calls`-JSON.

### Llama 3.3 70B versucht — blockiert
Guardrails bei ~61 GB Memory-Bedarf. Walter hat 128 GB, aber nur 0.3 GB „frei" — Rest aufgeteilt in Active (52 GB), Inactive (52 GB, cache), Wired (19 GB). Ein LM-Studio-Worker-Node belegte allein 17.87 GB, obwohl Modelle im UI „rausgenommen" waren.

### Lösung: Qwen 2.5 32B
Saubere OpenAI-Tool-Calls, ~20 GB VRAM, keine Guardrail-Probleme. Model in V3 umgestellt auf `qwen2.5-32b-instruct-mlx`.

## 5. V3-Fixes (2026-04-20 / 2026-04-21)

### Fix 1: `PG Upsert Telegram User` — „invalid syntax"
Ursache: Regex `.replace(/\'/g, "\'\'")` mit Backslash-Single-Quote-Escape löste im n8n-Expression-Parser einen Fehler aus.

Fix: Umgestellt auf `.split("'").join("''")` (kein Regex, keine Escape-Probleme) und in IIFE gekapselt.

### Fix 2: `Telegram Send Text` — „can't parse entities"
Ursache: n8n Telegram-Node typeVersion 1 **defaultet parse_mode auf Markdown**, wenn nichts gesetzt ist. Qwens Output enthielt Markdown-Chars (`**`, `_`), die Telegrams Parser zerbrachen.

Falscher erster Fix: `parse_mode: ""` (empty string) überschreibt den Default nicht.

Korrekter Fix:
- `text: {{$json.assistantTextEscaped}}` (HTML-escaped, war schon im Code-Node vorhanden)
- `additionalFields.parse_mode: "HTML"` (explizit)

## 6. Luna-Identität im System-Prompt

Symptom: Agent meinte er heiße „Walter_Assistent" (Model-Hallucination, da Name im Prompt nicht definiert).

Fix: Neuer `# IDENTITÄT`-Block im AI-Agent-System-Prompt:
```
Du heißt **Luna**. Du bist Walters persönliche Assistentin.
Wenn Walter fragt wie du heißt: „Ich bin Luna."
Niemals „Walter_Assistent", niemals „Assistent", niemals „KI-Modell".
```

Restrisiko: Alte Chat-Memory-Einträge (`paperclip_chat_memory` Tabelle) könnten den falschen Namen reinforcen. Falls nötig:
```sql
DELETE FROM paperclip_chat_memory WHERE session_id = 'telegram:8311805232';
```

## 7. Geplante Erweiterungen (TODOs gemerkt)

Gespeichert in `project_paperclip_voice_todos.md`, in Prio-Reihenfolge:

1. **Shared-Secret am Webhook** — jetzt öffentlich über Cloudflare, Security!
2. **Abendbericht 18:00** — Schedule Trigger + list_tasks + Format → Telegram
3. **Push-Events Paperclip → Telegram** — Realtime statt Polling
4. **Dedizierter Messenger-Agent** — statt CEO-Key missbrauchen
5. **Windows-SuperWhisper-Setup** — nie getestet

## Geänderte Dateien

- `Paperclip CEO - Voice & Telegram V3.json` — Workflow-Update (Qwen-Modell, SQL-Fix, Parse-Mode, Luna-Identität)
- Memory-Dateien:
  - `reference_n8n_startup.md` (neu)
  - `project_paperclip_voice_todos.md` (neu)

## Stand Ende der Session

✅ Cloudflare-Umstellung durch
✅ n8n läuft mit neuer URL
✅ Luna V10 deaktiviert, V3 aktiv
✅ Qwen 2.5 32B mit sauberen Tool-Calls
✅ PG Upsert + Telegram Parse-Mode gefixt
✅ Luna-Identität im Prompt
⏳ TODOs für V4 gemerkt
