# Design: Wake-Word-Satellit „Hey Jarvis" (Phase 1)

**Datum:** 2026-07-28
**Status:** Design abgestimmt, bereit für Implementierungsplan
**Branch:** `feat/wake-word-jarvis-satellite`

## Ziel

Walter soll seinen CEO-Agenten **Jarvis** freihändig per Sprache ansprechen
können: „Hey Jarvis, …" — der Satellit hört, transkribiert, lässt Jarvis'
bestehendes Gehirn antworten und spielt die Antwort **laut über den HomePod**
(„Homepod Studio") ab. Kein Griff zum Telefon, kein Aufnahme-Knopf.

Luna (Sekretärin, lebt in n8n) folgt in **Phase 2** und ist hier bewusst
außen vor.

## Scope-Entscheidungen (abgestimmt)

- **Nur Jarvis** in Phase 1. Sein Antwort-Gehirn existiert bereits lokal im
  `voice-echo-bot` (LM-Studio/gemma + Persona + Werkzeuge). Luna hat kein
  lokales Gehirn → separate Phase.
- **Host:** Mac Studio (zentraler Always-on-Rechner mit LM Studio).
- **Mikrofon:** eingebautes/angeschlossenes Mikro am Studio.
- **Ausgabe:** AirPlay an den HomePod mit Gerätenamen **„Homepod Studio"**.
- **Mandant fest:** Der Satellit ist physisch Walter am Studio → Tenant fest
  `Walter / WHITESTAG` (company `9cebf3cf-…`, ceo_agent `506c873e-…`). Keine
  Telegram-User-ID-Auflösung nötig.
- **Konversation:** pro Runde ein Wake-Word, **plus** ein **6-Sekunden-
  Nachfrage-Fenster** ohne erneutes Wake-Word (siehe Ablauf).

## Wiederverwendung: ein Jarvis, zwei Eingänge

Der Telegram-Jarvis (`tools/voice-echo-bot/bot.py`) läuft live und stabil.
Seine Antwort-Logik wird **nicht dupliziert**, sondern in ein gemeinsames
Modul herausgelöst:

- **`jarvis_brain.py`** (neu, im `voice-echo-bot`-Paket): kapselt
  System-Prompt, `parse_control` (LOOKUP/ISSUE/Chat) und die
  Werkzeug-Ausführung (Vault-Lookup via `vault_client`, Issue-Anlage via
  `paperclip_client`) als reine Funktion:
  `respond(text, tenant, cfg) -> antwort_text`.
- **`bot.py`** ruft künftig `jarvis_brain.respond(...)` in `_handle_chat`.
  Verhalten bleibt identisch — die bestehenden `bot`-Tests pinnen das.
- Der **Satellit** ruft dieselbe Funktion. Kein Persona-/Werkzeug-Drift.

Damit teilt sich Jarvis' Gehirn zwischen Telegram und Sprache; Erweiterungen
(neue Werkzeuge, Prompt-Feinschliff) wirken automatisch auf beiden Kanälen.

## Wake-Word-Runtime

`openwakeword` lädt die vorhandenen Modelle direkt. Für Jarvis:
`hey_jarvis_v0.1.tflite` (via `tflite-runtime`). Neue echte Abhängigkeiten
(numpy, sounddevice/PortAudio, openwakeword, tflite-runtime) → **eigenes
venv** unter `~/.paperclip/scripts/wake-satellite/venv`, getrennt vom
stdlib-only Telegram-Bot.

Das Modell wird beim Deploy neben den Satelliten kopiert
(`~/.paperclip/scripts/wake-satellite/models/hey_jarvis_v0.1.tflite`); die
Luna-Modelle (`Hey_luna_*.tflite/.onnx`) werden für Phase 2 mitgelegt, aber
noch nicht aktiviert.

## Architektur / Ablauf

Neuer Prozess `~/.paperclip/scripts/wake-satellite/satellite.py`, Quelle im
Repo unter `tools/wake-satellite/`. Schleife:

```
Mikrofon (sounddevice, 16 kHz mono, 80-ms-Frames)
  → openwakeword prüft laufend "hey_jarvis"
  → Score über Schwelle → Earcon-Beep ("ich höre") + Wake-Detection PAUSE
  → Aufnahme bis Stille (VAD/Energie, max ~12 s) → temp .wav
  → transcribe.py (whisper.cpp, deutsch)            [wiederverwendet]
  → leerer/zu-kurzer Text? → freundlicher Hinweis, Runde zu
  → jarvis_brain.respond(text, tenant, cfg)         [gemeinsames Gehirn]
  → tts.py (ElevenLabs, Format=mp3)                 [wiederverwendet + Param]
  → playback: SwitchAudioSource → "Homepod Studio", afplay, zurückschalten
  → NACHFRAGE-FENSTER: bis zu 6 s auf Sprachbeginn lauschen (ohne Wake-Word)
       • Sprache erkannt → zurück zu "Aufnahme bis Stille" (nächste Antwort)
       • 6 s still → Runde zu
  → Cooldown, dann Wake-Detection wieder AN
```

### Komponenten (je klein, testbar, klare Schnittstelle)

- **`wake.py`** — openwakeword-Wrapper. Rein: Audio-Frame (bytes/np.array).
  Raus: `(wort, score)` oder `None`. Kennt Modellpfad + Schwelle. Keine
  Mikro-/IO-Kenntnis.
- **`capture.py`** — Mikrofon-Stream + zwei Aufnahme-Modi:
  `record_until_silence(max_sec)` (nach Wake-Word) und
  `wait_for_speech(window_sec)` (Nachfrage-Fenster, liefert True/False bzw.
  startet direkt Aufnahme). Energie-/VAD-basiert.
- **`playback.py`** — AirPlay-Routing zum HomePod + `afplay`.
  `play(path, device="Homepod Studio")`. Merkt sich vorheriges Ausgabegerät,
  schaltet danach zurück; bei jedem Fehler (Gerät weg, SwitchAudioSource
  fehlt) **Fallback auf Standard-Ausgabe**, nie harter Abbruch.
- **`earcon.py`** (klein) — kurzer „ich höre"-Ton (vorgefertigte wav, lokal
  über Standardausgabe oder HomePod).
- **`satellite.py`** — die Schleife; verdrahtet `wake`, `capture`,
  `transcribe`, `jarvis_brain`, `tts`, `playback`. Hält Tenant + Config.
- **`config.py`** (Satellit-eigen) — Modellpfad, Schwelle, HomePod-Name,
  Nachfrage-Fenster (6 s), Max-Aufnahme, Cooldown, Whisper-Modellpfad,
  ElevenLabs-Key (aus `~/.paperclip/voice-echo-bot.env` wiederverwendet).

`transcribe.py`, `tts.py`, `jarvis_brain.py`, `vault_client.py`,
`paperclip_client.py` werden aus dem `voice-echo-bot`-Paket importiert bzw.
mit-deployt (gemeinsame Quelle, keine Kopie im Repo).

## Bekannte Stolpersteine (im Plan zu adressieren)

1. **Mikrofon-Rechte (TCC).** Ein launchd-*Daemon* bekommt kein Mikrofon
   (analog SynologyDrive-EPERM). → **LaunchAgent** in Walters GUI-Session
   (`~/Library/LaunchAgents/de.whitestag.wake-satellite.plist`). Das
   Python-Binary muss **einmalig** in Systemeinstellungen → Datenschutz →
   Mikrofon freigegeben werden. Ohne Freigabe: klare Fehlermeldung im Log,
   kein stiller Crashloop.
2. **Selbst-Trigger / Echo.** HomePod-Ausgabe kann das Studio-Mikro
   erreichen. → Wake-Detection ist **während Wiedergabe + kurzem Cooldown
   aus**; das Nachfrage-Fenster startet erst nach Ende der Wiedergabe.
3. **Audioformat.** ElevenLabs liefert für Telegram Opus/OGG; `afplay`/
   AirPlay mögen **mp3**. → `tts.synthesize(..., output_format=...)` bekommt
   einen Parameter; Telegram bleibt Opus, HomePod nutzt mp3. Standardwert
   erhält bestehendes Verhalten (Opus) → keine Regression am Telegram-Bot.

## Deployment

- **Quelle:** `tools/wake-satellite/` im Repo (+ Refactor in
  `tools/voice-echo-bot/`).
- **Live:** `~/.paperclip/scripts/wake-satellite/` (Deploy-Skript kopiert
  Satellit **und** die geteilten voice-echo-bot-Module + das Wake-Modell;
  legt/aktualisiert venv). Deploy-Lücke (Repo↔Live) ist Ansage-pflichtig.
- **Autostart:** LaunchAgent `de.whitestag.wake-satellite`, `RunAtLoad` +
  `KeepAlive`, Logs nach `~/.paperclip/logs/wake-satellite.log`.
- **DEPLOY.md** im Satelliten-Ordner: venv-Aufbau, Mikrofon-Freigabe,
  `SwitchAudioSource`-Install (brew), LaunchAgent laden.

## Tests (TDD, Hardware gemockt)

- **`wake`** — Frame → Detektion; Score über/unter Schwelle; Wortauswahl.
- **`capture`** — `record_until_silence` endet bei Stille / bei Max-Dauer;
  `wait_for_speech` liefert Treffer bzw. Timeout mit synthetischen Frames.
- **`playback`** — Routing-Kommandos (SwitchAudioSource/afplay) gemockt;
  Rückschalten; Fallback bei Fehler; nie Exception nach außen.
- **`jarvis_brain`** — aus `bot.py` gezogene Logik (LOOKUP/ISSUE/Chat +
  Werkzeug-Ausführung) mit gemocktem LLM/Vault/Paperclip; **bestehende
  `bot`-Tests bleiben grün** (Verhalten unverändert).
- **`satellite`** — Schleife end-to-end mit gemockten Bausteinen: Wake →
  Aufnahme → Transkript → Antwort → Playback → Nachfrage-Fenster (Treffer
  und Timeout).
- Reale Mikro-/HomePod-Hardware bleibt außen vor.

## Bewusst NICHT in Phase 1 (YAGNI)

- Luna per Sprache (Phase 2, eigener Zugang zu ihrem n8n-Gehirn).
- Mandantenauflösung / mehrere Sprecher.
- Dauerhaftes Freihand-Gespräch über das 6-s-Fenster hinaus.
- Barge-in (Jarvis mitten im Sprechen unterbrechen).
- Handy/Satelliten-Hardware im Raum.

## Phase 2 (Vorschau, nicht Teil dieses Plans)

Luna: Zugang zu ihrem echten n8n-Gehirn (favorisiert: HTTP-/Webhook-Eingang
in Lunas Workflow, POST Text → echte Sekretärin-Antwort), Wake-Word
`Hey_luna_*.tflite` im selben Satelliten, Dispatch nach erkanntem Wort.
