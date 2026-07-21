# Deploy: Voice-Echo Jarvis-Bot

Telegram-Bot `@whitestag_jarvis_bot`: Sprachnachricht → lokales Whisper → Bestätigung → Issue an den WHITESTAG-CEO. Läuft als launchd-Dienst aus `~/.paperclip/scripts/` (launchd kann SynologyDrive nicht lesen).

## Voraussetzungen
- `~/.paperclip/voice-echo-bot.env` — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, `WHITESTAG_COMPANY_ID`, `CEO_AGENT_ID`, `WHISPER_MODEL` (Rechte 600)
- `~/.paperclip/models/whisper/ggml-large-v3-turbo.bin`
- `~/.paperclip/auth.json` (Paperclip-Board-Token, auto-renewt)
- Homebrew: `whisper-cli`, `ffmpeg`

## Deploy / Update
```bash
mkdir -p ~/.paperclip/scripts/voice-echo-bot ~/.paperclip/logs
cp tools/voice-echo-bot/{config,telegram_api,transcribe,paperclip_client,bot}.py \
   ~/.paperclip/scripts/voice-echo-bot/
sed "s|__HOME__|$HOME|g" tools/voice-echo-bot/de.whitestag.voice-echo-bot.plist \
   > ~/Library/LaunchAgents/de.whitestag.voice-echo-bot.plist
launchctl bootout gui/$(id -u)/de.whitestag.voice-echo-bot 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.whitestag.voice-echo-bot.plist
launchctl kickstart -k gui/$(id -u)/de.whitestag.voice-echo-bot
```

## Status / Logs
```bash
launchctl print gui/$(id -u)/de.whitestag.voice-echo-bot | grep -E "state =|pid ="
tail -f ~/.paperclip/logs/voice-echo-bot.log
```

## Bedienung
In Telegram an `@whitestag_jarvis_bot` eine Sprach- oder Textnachricht senden → Bot zeigt das Transkript + Buttons **[✅ An CEO senden] [❌ Verwerfen]** → ✅ legt das Issue beim CEO an. Nur die in `TELEGRAM_ALLOWED_USER_ID` hinterlegte Person wird bedient; alle anderen werden ignoriert.

## Hinweise
- **Nur EIN Long-Poll-Consumer je Bot-Token.** Nicht parallel woanders `getUpdates`/Webhook auf denselben Token laufen lassen (Luna ist ein anderer Bot/Token — kein Konflikt).
- Whisper läuft on-demand (Modell wird pro Aufnahme geladen, RAM danach frei) — bewusst kein Dauer-Server wegen RAM-Contention mit LM Studio.
