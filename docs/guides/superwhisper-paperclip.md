# SuperWhisper → Paperclip CEO Setup

Kurzanleitung für den SuperWhisper-Mode, der Sprachbefehle per Hotkey an den
Paperclip-CEO-Agenten sendet. Identisch nutzbar auf Mac und Windows.

## Voraussetzungen

- n8n läuft auf dem Mac, Workflow "Paperclip CEO - Voice & Telegram V1" **aktiv**
- LAN-Zugang zum Mac (IP `192.168.2.191`)
- SuperWhisper installiert (Mac oder Windows)
- Whisper-Modell geladen (Large v3 empfohlen für Deutsch)

## Mode-Konfiguration

In SuperWhisper: **Settings → Modes → + New Mode**.

| Feld | Wert |
|---|---|
| Name | Paperclip CEO |
| Hotkey | ⌘⇧P (Mac) / Ctrl⇧P (Windows) — oder dein Favorit |
| Language | German |
| Model | Whisper Large v3 |
| Output Type | Custom Webhook (POST) |
| Webhook URL | `http://192.168.2.191:5678/webhook/paperclip/command` |
| Webhook Method | POST |
| Content-Type | application/json |
| Request Body | siehe unten |
| Response Display | macOS-Notification / Windows-Toast mit Response-Body |

### Request Body

Auf Mac:
```json
{"text": "{{transcript}}", "source": "mac"}
```

Auf Windows:
```json
{"text": "{{transcript}}", "source": "windows"}
```

`{{transcript}}` ist SuperWhispers Platzhalter für den transkribierten Text.

## Custom Vocabulary

Pro Mode unter "Vocabulary" folgende Eigennamen ergänzen (bessere STT-Genauigkeit):

- WHITESTAG, Paperclip, DSGVO, AVV, CEO, CTO, CMO, CPO
- WHI (als Task-Prefix, z.B. "WHI-14")
- Walter, Clara, n8n, ElevenLabs, Mistika VR

## Test

1. Hotkey drücken, warten bis der Indikator "listening" zeigt
2. Sprechen: "Was hat der CEO gerade offen?"
3. Hotkey erneut drücken
4. Notification sollte innerhalb ~3 Sekunden mit der Antwort vom CEO-Bridge erscheinen

## Typische Befehle

- **Task anlegen**: "Leg einen Task an: \<Titel\>. \<Optionale Beschreibung\>"
- **Status abfragen**: "Was ist offen?" / "Was macht der CEO gerade?"
- **Task prüfen**: "Wie steht es mit WHI-14?"
- **Kommentar**: "Zu WHI-14: \<Anweisung oder Feedback\>"

Der Agent hat Memory, also kannst du nach einer Task-Anlage auch sagen:
"Kommentiere den mit: \<Text\>" — die Bridge löst "den" auf die zuletzt
erwähnte Task-ID auf.

## Troubleshooting

- **Keine Reaktion**: n8n-Workflow aktiv? LAN-IP noch `192.168.2.191`? (`ipconfig getifaddr en0` auf Mac)
- **Fehler-Toast**: n8n-Executions-Log öffnen, letzten Run anschauen, roten Node identifizieren
- **Falsche Eigennamen**: Vocabulary-Liste ergänzen, Modell ggf. auf Large v3 stellen
- **Windows erreicht Mac nicht**: `Test-NetConnection 192.168.2.191 -Port 5678` in PowerShell — `TcpTestSucceeded: True` erwartet

## Telegram-Nutzung

Wenn der ngrok/Cloudflare-Tunnel wieder läuft, kannst du denselben Agenten
auch per Telegram-Text oder -Voice-Nachricht an den Luna-/Paperclip-Bot
steuern. Die Logik ist identisch, nur der Eingang ändert sich.
