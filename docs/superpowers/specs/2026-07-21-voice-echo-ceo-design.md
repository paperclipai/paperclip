# Voice-Echo → WHITESTAG-CEO — Design

**Datum:** 2026-07-21
**Status:** Design abgestimmt, wartet auf Review vor Plan
**Ziel:** Eine geschützte Web-URL, auf der Walter unterwegs (Handy) eine Aufgabe
einspricht, das Transkript kurz kontrolliert und per Knopfdruck als neues
Paperclip-Issue an den WHITESTAG-CEO schickt.

## Abgestimmte Entscheidungen

| Frage | Entscheidung |
|---|---|
| Zielformat | **Neues Issue**, dem CEO-Agenten zugewiesen |
| Ziel-CEO | **WHITESTAG-CEO** (fest verdrahtet, keine Auswahl im UI) |
| Speech-to-Text | **Lokales Whisper** (whisper.cpp, bereits via Homebrew installiert) |
| Whisper-Betrieb | **On-demand `whisper-cli`** pro Aufnahme — NICHT dauerwarmer `whisper-server` (RAM-Contention mit LM Studio) |
| Zugangsschutz | **Cloudflare Access** (E-Mail-Einmalcode) vor der Seite |
| Exposition | **cloudflared named tunnel** auf einer whitestag-Subdomain (z. B. `echo.whitestag.ai`) |
| Aufnahme-Flow | **Mit Kontroll-Schritt**: Aufnehmen → Transkript anzeigen → korrigieren → Senden |

## Architektur

```
Handy-Browser (https://echo.whitestag.ai)
  │  1. Mic-Button → MediaRecorder nimmt Audio auf (webm/opus)
  │  2. Stop → POST /transcribe  (multipart audio)
  ▼
Cloudflare Access (E-Mail-OTP)  ──►  cloudflared named tunnel
  ▼
Lokaler Mini-Server (Python, launchd, z. B. Port 8790)
  │  3. Audio → ffmpeg → 16 kHz mono WAV → whisper-cli (Sprache: de)
  │  4. Transkript JSON zurück ans Handy
  │  5. Nutzer kontrolliert/korrigiert Text, klickt „Senden"
  │  6. POST /send  → Paperclip: POST /companies/<WHITESTAG>/issues
  │                    (title = erste Zeile/gekürzt, description = Transkript,
  │                     assigneeAgentId = WHITESTAG-CEO)
  ▼
Paperclip-CEO erhält neues Issue
```

## Komponenten

### 1. Frontend — `index.html` (eine self-contained Seite)
- Ein großer **Mic-Button** (Aufnahme starten/stoppen, Statusanzeige „höre zu…").
- Nutzt `navigator.mediaDevices.getUserMedia` + `MediaRecorder`.
- Nach Stop: Audio-Blob per `fetch` an `/transcribe`, Spinner.
- Zeigt Transkript in einem **editierbaren Textfeld** (Kontroll-Schritt).
- **„Senden an CEO"-Button** → `POST /send` mit (ggf. korrigiertem) Text.
- Erfolgs-/Fehlermeldung mit Link/ID des erzeugten Issues.
- Kein externer Asset-Load (CSP-freundlich, funktioniert hinter Access).

### 2. Backend — Python-Mini-Server (Muster wie `~/.paperclip/scripts/bild-service`)
Endpunkte:
- `GET /` → liefert `index.html`.
- `POST /transcribe` → nimmt Audio, transkodiert via `ffmpeg`, ruft
  `whisper-cli -m <model> -l de -f <wav> -otxt`/stdout, gibt `{ "text": ... }` zurück.
  Fehler (kein Audio, whisper-Fehler) → 4xx/5xx mit Klartext.
- `POST /send` → nimmt `{ "text": ... }`, baut Titel (erste ~80 Zeichen / erster Satz),
  ruft Paperclip-API, gibt `{ "issueId": ..., "url": ... }` zurück.
- Health: `GET /healthz`.

Konfiguration über Env/`.env` (Muster wie `eeg-companion.env`):
`PAPERCLIP_BASE_URL` (http://127.0.0.1:3100), `PAPERCLIP_TOKEN` (Service-/Board-Token,
Muster wie Deliverable-Watcher-Token), `WHITESTAG_COMPANY_ID`, `CEO_AGENT_ID`,
`WHISPER_MODEL` (Pfad zum ggml-Modell), `PORT`.

### 3. Whisper-Modell
- Aktuell nur `for-tests-ggml-tiny.bin` vorhanden (unbrauchbar für echtes Deutsch).
- **Bereitstellen:** `ggml-large-v3-turbo.bin` (~1,6 GB, schnell, gutes Deutsch) via
  `whisper.cpp`-Download-Skript nach `~/.paperclip/models/whisper/`.
- On-demand geladen; nach Transkription gibt der Prozess RAM wieder frei.

### 4. Exposition — cloudflared named tunnel
- Named Tunnel (`cloudflared tunnel create voice-echo`), DNS-Route auf
  `echo.whitestag.ai` → `http://127.0.0.1:<PORT>`.
- Läuft als launchd-Dienst (KeepAlive), analog zu bestehenden Diensten.
- **Cloudflare Access**-Policy vor dem Hostname: erlaubte E-Mail(s)
  (whitestagvr@gmail.com / ws@whitestag.ai), Einmalcode.

### 5. Persistenz / Betrieb
- Backend als launchd-Dienst (KeepAlive), Logs nach `~/.paperclip/logs/voice-echo.log`.
- launchd kann `CloudStorage/SynologyDrive` nicht lesen (bekannt) → Skript + Model
  liegen unter `~/.paperclip/…`, nicht im SynologyDrive-Repo.

## Datenfluss / Issue-Erzeugung
- Endpoint: `POST /companies/:companyId/issues` (existiert, `createIssueSchema`).
- Felder: `title`, `description` (= volles Transkript), `assigneeAgentId` = CEO,
  Status-Default greift automatisch (`applyCreateIssueStatusDefault`).
- WHITESTAG-`companyId` und CEO-`agentId` werden beim Setup einmal über die API
  aufgelöst und in die `.env` geschrieben (nicht hartkodiert im Code).

## Fehlerbehandlung
- Mikro-Zugriff verweigert → klare UI-Meldung.
- Leeres/zu kurzes Audio → „Nichts erkannt, bitte erneut."
- whisper-Fehler / ffmpeg fehlt → 500 + Log, UI zeigt „Transkription fehlgeschlagen".
- Paperclip-Fehler (401 Token abgelaufen / 5xx) → UI zeigt Fehler, Text bleibt im Feld
  erhalten (kein Datenverlust), erneut senden möglich.
- Token-Ablauf: dokumentierter Renew-Weg (analog Board-Token-Autorenew).

## Testing
- Backend-Unit-Tests (pytest): Titel-Ableitung aus Transkript, `/send` baut korrekten
  Paperclip-Payload (Paperclip-Call gemockt), `/transcribe` mit Fixture-WAV
  (whisper gemockt oder Tiny-Modell auf `jfk.wav`).
- Manueller E2E-Smoke: Aufnahme am Handy → Transkript → Issue erscheint beim CEO.

## Bewusst NICHT im Scope (YAGNI)
- Keine CEO-Auswahl / Multi-Company (nur WHITESTAG).
- Kein KI-Titel/LLM-Nachbearbeitung (reiner Kontroll-Schritt).
- Keine Audio-Archivierung am Issue (nur Text).
- Keine Offline-PWA / native App.

## Offene Punkte für den Plan
- Genauer Modell-Download-Weg + Pfad.
- Service-Token-Beschaffung (bestehenden wiederverwenden vs. neuen anlegen).
- launchd-Plist-Namen (`de.whitestag.voice-echo`, `de.whitestag.voice-echo-tunnel`).
- Ist `echo.whitestag.ai` in Cloudflare als Zone verfügbar? (Domain-Check beim Setup.)
