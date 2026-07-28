# Wake-Word-Satellit „Hey Jarvis" — Deploy (Mac Studio)

Freihändiger Sprachzugang zu Jarvis: „Hey Jarvis, …" -> Antwort laut über den
HomePod „Homepod Studio". Läuft als **LaunchAgent** (nicht Daemon) in Walters
GUI-Session — nur so bekommt der Prozess Mikrofon-Zugriff.

## Voraussetzungen (einmalig)

- Homebrew-Tools: `brew install switchaudio-osx ffmpeg whisper-cpp`
  (`SwitchAudioSource`, `ffmpeg`, `whisper-cli`).
- Der HomePod muss in **Systemeinstellungen -> Ton -> Ausgabe** als
  `Homepod Studio` erscheinen (AirPlay). Heißt er anders, `HOMEPOD_DEVICE`
  in `sat_config.py` anpassen und neu deployen.
- `~/.paperclip/voice-echo-bot.env` existiert bereits (vom Telegram-Jarvis) mit
  `WHISPER_MODEL`, `ELEVENLABS_API_KEY`, `CHAT_MODEL`. Der Satellit nutzt sie.

## Deploy

```bash
cd "…/Paperclip/tools/wake-satellite"
./deploy.sh
```

Das Skript kopiert Satellit + geteilte Module + Wake-Modell nach
`~/.paperclip/scripts/wake-satellite/`, baut das venv, prüft die
Modell-Ladbarkeit und installiert den LaunchAgent.

### macOS-Hinweis zum tflite-Backend

`openwakeword` braucht ein tflite-Backend. Auf macOS liefert `tensorflow`
(in `requirements.txt`) das mit. Falls die Modell-Prüfung im Deploy fehlschlägt,
im venv `pip install tensorflow` nachziehen und `deploy.sh` erneut laufen lassen.

## Mikrofon-Freigabe (Pflicht, manuell)

Ein launchd-Prozess kann den Berechtigungsdialog nicht auslösen. Einmalig:

1. `~/.paperclip/scripts/wake-satellite/venv/bin/python3` in
   **Systemeinstellungen -> Datenschutz & Sicherheit -> Mikrofon** hinzufügen
   und aktivieren. (Ggf. den Ordner via Finder „Gehe zu" öffnen und die Binärdatei
   dorthin ziehen.)
2. Ohne Freigabe protokolliert der Satellit einen klaren Fehler statt still zu
   crashen — im Log sichtbar.

## Start / Stop / Logs

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.whitestag.wake-satellite.plist
launchctl kickstart -k gui/$(id -u)/de.whitestag.wake-satellite     # Neustart
launchctl bootout   gui/$(id -u)/de.whitestag.wake-satellite        # Stop
tail -f ~/.paperclip/logs/wake-satellite.log
```

## Bekannte Grenzen (Phase 1)

- Nur Jarvis. Luna folgt in Phase 2 (eigener Zugang zu ihrem n8n-Gehirn).
- Während der HomePod spricht, ist die Wake-Erkennung aus; das 6-s-Nachfrage-
  Fenster startet erst nach der Wiedergabe. Restliches Echo dämpft der Cooldown.
- Deploy-Lücke Repo <-> Live ist ansage-pflichtig: nach Code-Änderung erneut
  `./deploy.sh` + `kickstart -k`.
