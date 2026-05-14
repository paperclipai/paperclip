# Spracheingabe Mac + PC — SuperWhisper-Modes für Paperclip, Luna und Diktieren

**Datum:** 2026-04-20
**Autor:** Walter + Claude (Opus 4.7)
**Status:** Entwurf — zur Freigabe
**Bezug:** Schließt die offene Frontend-Seite zu [2026-04-19 Paperclip CEO — Voice & Telegram Bridge](2026-04-19-paperclip-ceo-voice-design.md). Der dortige Endpoint `POST /paperclip/command` ist bereits live; dieser Entwurf beschreibt, wie Mac und Windows-PC diesen Endpoint (und Luna) per Hotkey und Spracheingabe bedienen.

## 1. Zweck

Walter will auf Mac und Windows drei Sprach-Funktionen per Hotkey nutzen:
1. **Diktieren** (in beliebige App, z.B. TextEdit, Mail, Obsidian)
2. **Paperclip CEO** — Sprachbefehl an den CEO-Bridge-Workflow
3. **Luna** — Sprachbefehl an die Luna-Konversations-Bridge

Ziel: Ein durchgängiges, datenschutzfreundliches Sprach-Frontend auf beiden Arbeitsgeräten. Transkription und LLM-Cleanup laufen lokal pro Gerät. Die Webhook-Ziele liegen im Mac-LAN (n8n `192.168.2.191:5678`).

## 2. Scope

### In V1
- Drei native SuperWhisper-Modes pro Gerät (Diktieren, Paperclip, Luna)
- STT-Modell: Whisper Large v3 (Deutsch)
- LM Studio Cleanup pro Gerät lokal
- Webhook-Modes für Paperclip und Luna (bestehende Endpoints)
- Paste-Mode für Diktieren (SuperWhisper-Default)
- Guide `docs/guides/superwhisper-setup.md` als Einrichtungs-Checkliste (ersetzt den bestehenden `superwhisper-paperclip.md`)

### Nicht in V1
- Wake-Word ("Hey Paperclip") — Hotkey bleibt zuverlässiger
- Desktop-TTS für Antworten — Notifications reichen
- iPhone/iPad-Integration — eigenes Projekt (Shortcuts-App)
- Automatisches Vocabulary-Sync zwischen Mac und Windows — manuell pro Gerät
- Monitoring der Mode-Nutzung (Analytics) — YAGNI

## 3. Architektur

**Gleiche Architektur auf Mac und Windows — Zielendpoints teilweise unterschiedlich.**

```
┌────────────────────────────────────────┐
│  SuperWhisper (Mac oder Windows)       │
│                                        │
│  Hotkey 1 ──► Diktier-Mode             │
│  Hotkey 2 ──► Paperclip-Mode           │
│  Hotkey 3 ──► Luna-Mode                │
│                                        │
│  Jeder Mode:                           │
│   1) STT (Whisper Large v3, Deutsch)   │
│   2) LM Studio Cleanup (lokal)         │
│   3) Output:                           │
│      - Diktieren → Paste am Cursor     │
│      - Paperclip → POST Webhook        │
│      - Luna → POST Webhook             │
│   4) Response-Anzeige (Notification)   │
└────────────────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────┐
    │  LM Studio lokal             │
    │  Mac:  Gemma 4 26B a4b       │
    │  Win:  Qwen3.6 35B a3b       │
    │  Endpoint: 127.0.0.1:1234    │
    └──────────────────────────────┘
                     │
                     ▼ (nur Paperclip/Luna)
    ┌──────────────────────────────┐
    │  n8n auf dem Mac             │
    │  192.168.2.191:5678          │
    │  - /webhook/paperclip/command│
    │  - /webhook/luna/voice       │
    └──────────────────────────────┘
```

## 4. Mode-Konfiguration

Alle drei Modes nutzen Whisper Large v3 mit fest eingestellter Sprache Deutsch, Temperatur 0.1 und Max Tokens 500 beim Cleanup-LLM. Fallback bei LLM-Ausfall: Rohtext weiterverarbeiten, nicht scheitern.

### Mode 1 — Diktieren

| Feld | Mac | Windows |
|---|---|---|
| Hotkey | `Fn` | `Win+Alt+Space` |
| Output Type | Paste am Cursor | Paste am Cursor |
| Cleanup-Prompt | siehe unten | siehe unten |
| Vocabulary | Allgemein | Allgemein |

Cleanup-Prompt:
> Entferne Füllwörter (äh, ähm, ja also), setze korrekte Interpunktion und Großschreibung. Behalte Stil und Inhalt exakt bei. Gib NUR den gesäuberten Text zurück, keine Kommentare.

### Mode 2 — Paperclip CEO

| Feld | Mac | Windows |
|---|---|---|
| Hotkey | `⌘⇧P` | `Ctrl⇧P` |
| Output Type | Webhook POST | Webhook POST |
| Webhook URL | `http://192.168.2.191:5678/webhook/paperclip/command` | `http://192.168.2.191:5678/webhook/paperclip/command` |
| Request Body | `{"text":"{{llmOutput}}","source":"mac"}` | `{"text":"{{llmOutput}}","source":"windows"}` |
| Response Display | macOS-Notification | Windows-Toast |
| Vocabulary | siehe §5 | siehe §5 |

Cleanup-Prompt:
> Wandle diesen Sprachbefehl in einen klaren, knappen Imperativsatz für einen Projekt-Assistenten um. Behalte alle Fachbegriffe und Task-IDs (WHI-X) exakt. Keine Höflichkeitsfloskeln. NUR den umformulierten Befehl zurückgeben.

### Mode 3 — Luna

| Feld | Mac | Windows |
|---|---|---|
| Hotkey | `⌘⇧L` | `Ctrl⇧L` |
| Output Type | Webhook POST | Webhook POST |
| Webhook URL | `http://192.168.2.191:5678/webhook/luna/voice` | `http://192.168.2.191:5678/webhook/luna/voice` |
| Request Body | `{"text":"{{llmOutput}}","chatId":"<WALTER_TG_CHAT_ID>","source":"superwhisper"}` | dto. |

`<WALTER_TG_CHAT_ID>` ist Walters Telegram-User-ID (bereits in Luna V10 im User-Filter hinterlegt). Wert wird bei der Mode-Konfiguration aus der Luna-n8n-Credential übernommen und fix in die Body-Vorlage eingetragen.
| Response Display | macOS-Notification | Windows-Toast |
| Vocabulary | siehe §5 | siehe §5 |

Cleanup-Prompt:
> Bereinige Füllwörter und Interpunktion, behalte konversationellen Ton. NUR den gesäuberten Text zurückgeben.

## 5. Custom Vocabulary

**Gemeinsam (alle Modes):**
`WHITESTAG, Paperclip, DSGVO, AVV, DSFA, BTU, Cottbus, Lausitz, n8n, LM Studio, ElevenLabs, Obsidian, Nextcloud, Postgres, Mistika VR, Krpano, Present4D, ComfyUI, Walter, Clara, Schönenbröcher`

**Zusätzlich in Paperclip-Mode:**
`CEO, CTO, CMO, CPO, CRO, VP Engineering, WHI` (Aussprache "WHI-14" = "vau-ha-eins-vier")

**Zusätzlich in Luna-Mode:**
`Luna`

## 6. LM Studio pro Gerät

### Mac (M4 Max, 128GB)
- **Modell:** Gemma 4 26B a4b (MoE, ~4B aktive Parameter)
- Begründung: MoE schnell (~0.5–1s Cleanup), Gemma-Reihe in Deutsch zuverlässiger als Qwen für Text-Cleaning, kleiner Footprint gegenüber Dense-32B.
- **Endpoint:** `http://127.0.0.1:1234/v1` (bleibt auf Loopback gebunden)

### Windows
- **Modell:** Qwen3.6 35B a3b (MoE, ~3B aktive Parameter)
- Begründung: Einziges verfügbares Modell auf dem Windows-Gerät; glücklicherweise MoE und für Cleanup gut geeignet.
- **Endpoint:** `http://127.0.0.1:1234/v1`

**Keine Netz-Öffnung nötig:** Jedes Gerät spricht mit seinem **eigenen** lokalen LM Studio, nicht cross-device. Entfällt die Notwendigkeit, LM Studio auf `0.0.0.0` zu binden — kleiner Angriffsvektor weniger.

## 7. Netz & Datenfluss

| Richtung | Protokoll | Ziel |
|---|---|---|
| Mac-SuperWhisper → LM Studio | HTTP | `127.0.0.1:1234` (lokal) |
| Windows-SuperWhisper → LM Studio | HTTP | `127.0.0.1:1234` (lokal) |
| Mac-SuperWhisper → n8n | HTTP | `127.0.0.1:5678` (lokal) |
| Windows-SuperWhisper → n8n | HTTP | `192.168.2.191:5678` (LAN) |
| n8n → Paperclip-API | HTTP | `127.0.0.1:3100` (lokal auf Mac) |
| n8n → Luna-LLM / Memory | HTTP / Postgres | lokal auf Mac |

**LAN-Voraussetzung (Windows):** Bereits verifiziert — `Test-NetConnection 192.168.2.191 -Port 5678 → TcpTestSucceeded: True`, Ping <1ms.

## 8. Latenz-Budget

| Mode | STT | Cleanup | Webhook+Agent | Gesamt |
|---|---|---|---|---|
| Diktieren | ~1s | ~0.5–1s | — | **~1.5–2s** |
| Paperclip | ~1s | ~0.5–1s | ~2–4s | **~3.5–6s** |
| Luna | ~1s | ~0.5–1s | ~2–4s | **~3.5–6s** |

Akzeptanzkriterium: ≤3s für Diktieren, ≤7s für Paperclip/Luna.

## 9. Installation & Verifizierung

**Reihenfolge pro Gerät (Mac zuerst, dann Windows):**

**Mac:**
1. SuperWhisper installieren (superwhisper.com), Whisper Large v3 laden
2. LM Studio prüfen: Gemma 4 26B a4b geladen, Server aktiv (`curl http://127.0.0.1:1234/v1/models`)
3. n8n prüfen: Workflow V3 aktiv (`curl -X POST http://127.0.0.1:5678/webhook/paperclip/command -d '{"text":"test","source":"mac"}' -H "Content-Type: application/json"`)
4. Drei Modes anlegen gemäß §4
5. Smoke-Tests pro Mode (siehe §10)

**Windows:**
6. SuperWhisper für Windows installieren — **Risiko:** Windows-Version muss Custom-Webhook-Modes und AI-Actions unterstützen. Erst Trial prüfen, dann Kauf.
7. Whisper-Modell laden
8. LM Studio installieren, Qwen3.6 35B a3b laden, auf `127.0.0.1:1234`
9. Netz-Check zu Mac-n8n (bereits OK)
10. Drei Modes analog zu Mac
11. Smoke-Tests pro Mode

## 10. Akzeptanzkriterien

V1 gilt als erfolgreich, wenn:
- [ ] Diktier-Mode schreibt gesäuberten Text am Cursor auf Mac und Windows
- [ ] Paperclip-Mode legt einen Test-Task an und Notification zeigt Task-ID
- [ ] Paperclip-Mode kann offene Tasks abfragen ("Was ist offen?")
- [ ] Luna-Mode antwortet konversationell (Notification zeigt Luna-Antwort)
- [ ] Cleanup sichtbar wirksam — Füllwörter entfernt, Interpunktion gesetzt
- [ ] Latenz innerhalb Budget (§8)
- [ ] Vocabulary verhindert offensichtliche Transkriptions-Fehler ("WHITESTAG", "WHI-X")

## 11. Fallback-Plan für Windows-Parität

Falls SuperWhisper für Windows Custom-Webhooks oder AI-Actions **nicht** unterstützt, in dieser Reihenfolge prüfen:

- **B1:** Wispr Flow (ähnliches Tool, Webhook-Support bestätigt)
- **B2:** Eigenes PowerShell-Skript mit Windows Speech-API für Diktieren + kleines Tool für Paperclip/Luna-Webhooks
- **B3:** Windows postet Rohtext direkt an n8n; Cleanup wird in n8n über Mac-LM-Studio erledigt (Umweg, aber funktional)

Entscheidung erst **nach Install-Verifizierung auf Windows**, nicht präventiv. Plan-Dokument hält Verifizierung als eigenen Schritt vor.

## 12. Kosten

- **SuperWhisper Mac:** Free-Tier für Test, dann ~$8.49/Monat oder ~$150 Lifetime
- **SuperWhisper Windows:** dto., Lizenzpolitik (ein vs. zwei Lizenzen für zwei Geräte) im Plan verifizieren
- **LM Studio:** kostenlos, Modelle bereits lokal vorhanden
- **n8n, Postgres:** bestehende lokale Installation, kein Extra-Aufwand

## 13. Wartung

- Vocabulary-Update ~1x/Monat pro Gerät (neue Eigennamen, Kundenbegriffe)
- Cleanup-Prompts nur ändern, wenn ein Mode systematisch daneben liegt
- Modell-Upgrades (Gemma 5, Qwen 4) parallel testen, nicht auf Verdacht wechseln
- Backup der Mode-Konfiguration: SuperWhisper exportiert Modes als JSON — nach Einrichtung in `docs/guides/superwhisper-modes-backup/` ablegen

## 14. Out-of-scope / Later

- Automatisches Mode-Config-Sync Mac↔Windows via Git/iCloud
- Dritter Mode für Obsidian-Markdown-Notizen mit spezieller Markdown-Formatierung
- TTS-Readback der Agent-Antwort am Desktop
- Wake-Word mit Picovoice Porcupine
- iPhone/Apple-Watch-Integration

---

**Offene Details erst in der Implementierung zu klären:**
- Exakter Menüpfad für "AI Action" in SuperWhisper Mac vs. Windows (Screenshots/Guide)
- Ob SuperWhisper den `{{llmOutput}}`-Platzhalter genau so heißt oder anders (z.B. `{{cleaned}}`, `{{text}}`) — beim Anlegen verifizieren
- Rate-Limit auf n8n-Seite (falls Hotkey-Spam) — nur nachrüsten, wenn tatsächlich Problem
