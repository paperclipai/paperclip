# Voice-Echo → WHITESTAG-CEO (Telegram-Bot) — Design

**Datum:** 2026-07-21
**Status:** Design abgestimmt, wartet auf Review vor Plan
**Ziel:** Ein dedizierter Telegram-Bot, den nur Walter bedienen darf. Walter
spricht (oder tippt) unterwegs eine Aufgabe ein; der Bot transkribiert sie
lokal, zeigt sie zur Bestätigung und legt sie als neues Paperclip-Issue beim
WHITESTAG-CEO an.

## Abgestimmte Entscheidungen

| Frage | Entscheidung |
|---|---|
| Kanal | **Bestehender, ungenutzter Bot `@whitestag_jarvis_bot`** (Anzeigename „J.A.R.V.I.S.") — eigener CEO-Bot, NICHT Luna |
| Web-Seite / Cloudflare | **Entfällt komplett** — durch Telegram ersetzt |
| Zielformat | **Neues Issue**, dem CEO-Agenten zugewiesen |
| Ziel-CEO | **WHITESTAG-CEO** (fest verdrahtet) |
| Speech-to-Text | **Lokales Whisper** (whisper.cpp, bereits via Homebrew installiert) |
| Whisper-Betrieb | **On-demand `whisper-cli`** pro Aufnahme — kein dauerwarmer Server (RAM-Contention mit LM Studio) |
| Telegram-Anbindung | **Long-Polling (`getUpdates`)** — KEIN Webhook, KEINE offene URL/kein Tunnel |
| Zugangsschutz | **Allowlist auf Walters Telegram-User-ID** — jede andere ID wird ignoriert |
| Bestätigung | **Inline-Buttons** [✅ An CEO senden] / [❌ Verwerfen] vor dem Anlegen |
| Eingabearten | **Sprachnachricht** (→ Whisper) und **Textnachricht** (→ direkt) |

## Architektur

```
Telegram-App (Handy) ── nur Walters User-ID erlaubt ──►  Telegram-Server
                                                              ▲
                                                              │ Long-Polling getUpdates
                                                              │ (Mac holt aktiv ab, nichts exponiert)
                                                              ▼
Lokaler Bot-Dienst (Python, launchd, ~/.paperclip/scripts/voice-echo-bot)
  │  1. Update empfangen → Absender-ID gegen Allowlist prüfen (sonst ignorieren)
  │  2a. Voice → getFile → OGG/Opus laden → ffmpeg → 16 kHz mono WAV → whisper-cli -l de
  │  2b. Text → direkt übernehmen
  │  3. Bot antwortet: „📝 <Transkript>"  + Inline-Buttons [✅ Senden] [❌ Verwerfen]
  │  4. Callback ✅ → POST /companies/<WHITESTAG>/issues (assignee = CEO)
  │  5. Bot bestätigt: „✅ Issue #<id> an CEO gesendet" (+ Link)
  ▼
Paperclip-CEO erhält neues Issue
```

## Komponenten

### 1. Bot-Dienst — Python (Muster wie `~/.paperclip/scripts/bild-service`)
Ein Long-Polling-Loop (kein Web-Framework nötig):
- `getUpdates` mit `offset`/`timeout` (Long-Poll), verarbeitet Updates sequenziell.
- **Allowlist-Gate:** `update.message.from.id` bzw. `callback_query.from.id` muss
  Walters `TELEGRAM_ALLOWED_USER_ID` entsprechen; sonst still verwerfen (kein Reply).
- **Voice-Handler:** `getFile` → Datei-Download → `ffmpeg -i in.oga -ar 16000 -ac 1 out.wav`
  → `whisper-cli -m <model> -l de -f out.wav -nt` (stdout Text) → Transkript.
- **Text-Handler:** Nachrichtentext direkt als Kandidat.
- **Bestätigung:** `sendMessage` mit Transkript + `reply_markup` Inline-Keyboard
  (`callback_data` referenziert den zwischengespeicherten Text, s. u.).
- **Callback-Handler:** ✅ → Issue anlegen; ❌ → verwerfen, kurze Bestätigung.
- **Titel-Ableitung:** erster Satz / erste ~80 Zeichen des Textes; Volltext = description.

**Kandidaten-Zwischenspeicher:** Da `callback_data` auf 64 Byte begrenzt ist, wird
der Transkript-Text NICHT in `callback_data` gepackt, sondern serverseitig unter
einem kurzen Key (z. B. `msg:<chat_id>:<message_id>`) im Prozess-Speicher gehalten;
`callback_data` trägt nur `send:<key>` / `drop:<key>`. Ein einfacher In-Memory-Dict
mit TTL/Größenlimit reicht (Einzelnutzer, geringe Frequenz).

### 2. Whisper-Modell
- Aktuell nur `for-tests-ggml-tiny.bin` vorhanden (unbrauchbar für echtes Deutsch).
- **Bereitstellen:** `ggml-large-v3-turbo.bin` (~1,6 GB, schnell, gutes Deutsch) nach
  `~/.paperclip/models/whisper/`.
- On-demand geladen; Prozess endet nach Transkription → RAM wieder frei.

### 3. Paperclip-Anbindung
- Endpoint: `POST /companies/:companyId/issues` (existiert, `createIssueSchema`,
  `applyCreateIssueStatusDefault` setzt Status-Default).
- Felder: `title`, `description` (= Volltext), `assigneeAgentId` = WHITESTAG-CEO.
- WHITESTAG-`companyId` und CEO-`agentId` werden beim Setup einmal über die API
  aufgelöst und in die `.env` geschrieben (nicht hartkodiert).

### 4. Konfiguration (`.env`, Muster wie `eeg-companion.env`)
`TELEGRAM_BOT_TOKEN` (neuer Bot vom BotFather), `TELEGRAM_ALLOWED_USER_ID`,
`PAPERCLIP_BASE_URL` (http://127.0.0.1:3100), `PAPERCLIP_TOKEN` (Service-/Board-Token,
Muster wie Deliverable-Watcher), `WHITESTAG_COMPANY_ID`, `CEO_AGENT_ID`,
`WHISPER_MODEL` (Pfad zum ggml-Modell).

### 5. Betrieb
- launchd-Dienst (KeepAlive), z. B. `de.whitestag.voice-echo-bot`.
- Logs nach `~/.paperclip/logs/voice-echo-bot.log`.
- launchd kann `CloudStorage/SynologyDrive` nicht lesen (bekannt) → Skript + Modell
  liegen unter `~/.paperclip/…`, nicht im SynologyDrive-Repo.
- **Kein Konflikt mit Luna-Bot:** eigener Token, eigener Long-Poll-Consumer. (Ein
  Bot-Token darf nur EINEN aktiven getUpdates/Webhook-Consumer haben — daher
  zwingend ein NEUER Bot, nicht Luna.)

## Fehlerbehandlung
- Fremde User-ID → Update still ignorieren (kein Reply, Log-Eintrag).
- Leeres/zu kurzes Audio → Bot antwortet „Nichts erkannt, bitte erneut."
- whisper-/ffmpeg-Fehler → Bot antwortet „Transkription fehlgeschlagen" + Log.
- Paperclip-Fehler (401 Token abgelaufen / 5xx) → Bot meldet Fehler; Transkript
  bleibt im Kandidaten-Speicher, Nutzer kann erneut ✅ drücken (kein Datenverlust).
- Token-Ablauf (Paperclip): dokumentierter Renew-Weg (analog Board-Token-Autorenew).
- getUpdates-Netzfehler → Backoff-Retry-Schleife, Dienst bricht nicht ab.

## Testing
- Unit-Tests (pytest), Telegram- und Paperclip-Calls gemockt:
  - Allowlist-Gate lässt nur die erlaubte User-ID durch.
  - Titel-Ableitung aus Transkript.
  - `/send`-Pfad baut korrekten Paperclip-Payload.
  - Callback ✅/❌ steuert Anlegen/Verwerfen korrekt.
  - `/transcribe`-Pfad mit Fixture-WAV (whisper gemockt oder Tiny-Modell auf `jfk.wav`).
- Manueller E2E-Smoke: Sprachnachricht an den Bot → Transkript + Buttons → ✅ →
  Issue erscheint beim WHITESTAG-CEO.

## Bewusst NICHT im Scope (YAGNI)
- Keine Web-Seite, kein Cloudflare-Tunnel/Access.
- Keine CEO-Auswahl / Multi-Company (nur WHITESTAG).
- Kein KI-Titel/LLM-Nachbearbeitung (reiner Bestätigungs-Schritt).
- Keine Audio-Archivierung am Issue (nur Text).
- Kein Rückkanal CEO → Telegram (später denkbar, jetzt nicht).

## Setup-Voraussetzungen / offene Punkte für den Plan
- **Bot existiert bereits:** `@whitestag_jarvis_bot` (Anzeigename „J.A.R.V.I.S."), von Walter
  angelegt, bisher ungenutzt. Kein neuer Bot nötig.
- **Token aus BotFather holen:** Das Token ist NIRGENDS auf dem Mac gespeichert (gesamtes
  Home durchsucht). Walter holt es in Telegram über `@BotFather → /mybots →
  @whitestag_jarvis_bot → API Token` (ggf. „Revoke current token" für ein frisches).
- **Walters Telegram-User-ID ermitteln** (z. B. via @userinfobot) für die Allowlist.
- Modell-Download-Weg + Pfad festlegen.
- Service-Token beschaffen (bestehenden wiederverwenden vs. neuen anlegen).
- launchd-Plist-Name (`de.whitestag.voice-echo-bot`).
