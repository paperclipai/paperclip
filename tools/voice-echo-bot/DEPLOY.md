# Deploy: Voice-Echo Jarvis-Bot

Telegram-Bot `@whitestag_jarvis_bot`: Sprachnachricht → lokales Whisper → Bestätigung → Issue an den WHITESTAG-CEO. Läuft als launchd-Dienst aus `~/.paperclip/scripts/` (launchd kann SynologyDrive nicht lesen).

## Voraussetzungen
- `~/.paperclip/voice-echo-bot.env` — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, `WHITESTAG_COMPANY_ID`, `CEO_AGENT_ID`, `WHISPER_MODEL` (Rechte 600)
- `~/.paperclip/models/whisper/ggml-large-v3-turbo.bin`
- `~/.paperclip/auth.json` (Paperclip-Board-Token, auto-renewt)
- Homebrew: `whisper-cli`, `ffmpeg`

## ⚠️ VOR DEM DEPLOY LESEN — Live-Stand weicht ab

**Der laufende `bot.py` ist NICHT die Repo-Version.** Stand 2026-07-29:
Live ~23 KB, Repo ~12 KB. Der Live-Bot importiert `jarvis_brain` gar nicht
(er trägt `SYSTEM_PROMPT`, `LOOKUP_RE`, `ISSUE_RE` und `parse_control` inline)
und enthält zusätzlich einen Präfix-Dispatcher für `academy_bridge` und
`seo_gate` — beides gibt es im Repo nicht.

**Das `rsync` unten überschreibt diesen Stand.** Folge: academy-auto und die
seo-geo-Freigabe fallen still aus (keine Fehlermeldung, die Module bleiben als
verwaiste Dateien liegen, weil ohne `--delete` kopiert wird).

Vor jedem Deploy deshalb prüfen:

```bash
diff -rq tools/voice-echo-bot ~/.paperclip/scripts/voice-echo-bot \
  --exclude=venv --exclude=__pycache__ --exclude='test_*'
```

Erscheinen Unterschiede, die nicht von der eigenen aktuellen Änderung stammen:
**stoppen** und die beiden Versionen erst zusammenführen. Einzelne geteilte
Module (`llm.py`, `vault_client.py`, `web_search.py`, …) lassen sich gezielt
per `cp` nachziehen, ohne `bot.py` anzutasten.

## Deploy / Update
```bash
mkdir -p ~/.paperclip/scripts/voice-echo-bot ~/.paperclip/logs
# Alle Module ausser den Tests — llm/tts/vault_client etc. gehoeren dazu.
# ACHTUNG: ueberschreibt den abweichenden Live-bot.py, siehe Warnung oben.
rsync -a --exclude 'test_*.py' --exclude '__pycache__' \
   tools/voice-echo-bot/*.py ~/.paperclip/scripts/voice-echo-bot/
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
- **Chat-Modell:** `google/gemma-4-12b` (klein, lokal auf der Studio resident), Fallback `gemma-4-31b-it-mlx`. Bewusst NICHT das grosse 31b als Primärmodell: es lag per LM Link auf dem MacBook und riss beim JIT-Kaltstart (33,8 GB) regelmässig den Timeout → HTTP 400 am RAM-Guardrail. Überschreibbar per `CHAT_MODEL` in der env.
- **Kein Auftragsverlust:** Scheitert das LLM endgültig (2 Versuche Primärmodell + 1 Fallback), legt der Bot den Wortlaut trotzdem als Issue beim CEO an (`_file_unparsed`) und nennt dir die Nummer. Nur wenn auch die Issue-Anlage scheitert, meldet er „NICHT angekommen".

## Rückkanal + Mehrmandanten (Feature 2)

**Mandanten-Tabelle:** `~/.paperclip/voice-echo-tenants.json` (600) — Telegram-ID → {company_id, ceo_agent_id}. Aktuell: Walter `8311805232` → WHITESTAG/CEO, Clara `1220010628` → Clara Sound/Büroleitung. Neue Person: Zeile ergänzen, sie drückt `/start` beim Bot.

**Dedup-State:** `~/.paperclip/voice-echo-state.json` — verhindert Doppel-Pushes; Erststart markiert Bestand still als „seen".

**Decision-Label `entscheidung-noetig`:**
- WHITESTAG: `77196d1b-6d7c-45ac-a89f-08424b48ac72`
- Clara Sound: `4441d371-3ec6-4437-ad03-2e3bc139ae11`
- Bot löst die ID zur Laufzeit per Name auf (`resolve_label_id`), IDs hier nur zur Referenz.

**CEO-Instruktion (setzt das Label bei Entscheidungsbedarf):**
- WHITESTAG-CEO: durable in `~/.paperclip/scripts/agents-instructions/roles/ceo.role.md` (Abschnitt „Entscheidungen an Walter"); via Generator übernommen:
  ```bash
  cd ~/.paperclip/scripts/agents-instructions
  export PCP_API=http://localhost:3100 PCP_CID=9cebf3cf-efe8-4597-a400-f06488900a87
  export PCP_TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
  python3 build-agents-md.py --dry-run   # Umfang prüfen (nur CEO ändert sich)
  python3 build-agents-md.py --backup --apply   # ggf. 2× (eventual consistency)
  ```
- Clara-Büroleitung: NICHT im WHITESTAG-Generator → direkt via API-Bundle geschrieben
  (`PUT /api/agents/64ad7d03-…/instructions-bundle/file` mit `{"path":"AGENTS.md","content":…}`),
  Abschnitt „Entscheidungen an Clara".

**Rückkanal-Verhalten:** Bot pollt je Mandant alle ~60 s: Top-Level-Issue neu `done` → „✅ Erledigt"-Push; Issue trägt `entscheidung-noetig` → „🟠 Entscheidung benötigt"-Push. Nutzer antwortet per Telegram-**Reply** (Sprache/Text) → Kommentar ans Issue (`resume:true`).
