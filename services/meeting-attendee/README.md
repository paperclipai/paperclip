# Meeting Attendee Service

FastAPI service that drives the `meeting-attendee` Paperclip agent. Joins Microsoft Teams meetings via Recall.ai, listens, occasionally speaks via Kokoro TTS, and produces vault summaries + Paperclip tickets.

## Setup (Vardaan, ~15 min, attended)

1. **Recall.ai dashboard** (https://us-east-1.recall.ai/dashboard):
   - Create API key → copy to `koenig-ai-org/.env.koenig` as `RECALL_API_KEY=<key>`
   - Note the workspace verification secret → copy as `RECALL_WORKSPACE_VERIFICATION_SECRET=<secret>`
   - Set `RECALL_REGION=us-east-1`

2. **ngrok signup** (https://ngrok.com — free tier):
   - Reserve a static domain (free tier allows 1)
   - Set `MEETING_BOT_PUBLIC_URL=https://<your-static-domain>.ngrok-free.app` in `.env.koenig`

3. **Install dependencies:**
   ```bash
   cd services/meeting-attendee
   uv venv && uv pip install -r requirements.txt
   ```

4. **Start the service:**
   ```bash
   source .venv/bin/activate
   uvicorn main:app --port 8200
   ```

5. **Expose via ngrok** (in another terminal):
   ```bash
   ngrok http 8200 --domain <your-static-domain>.ngrok-free.app
   ```

6. **Verify:** `curl https://<your-static-domain>.ngrok-free.app/health` should return `{"status": "ok"}`.

7. **Configure Kokoro TTS** (already running locally per V1):
   - Default `KOKORO_TTS_URL=http://localhost:8888` (no change needed)

## Usage

To have the bot join a Teams meeting:

```bash
curl -X POST https://<ngrok-domain>/meetings \
  -H 'Content-Type: application/json' \
  -d '{"teams_url": "https://teams.microsoft.com/l/meetup-join/...", "meeting_type": "weekly-content-sync"}'
```

The bot joins the meeting (lands in lobby; host admits), transcribes, decides when to speak, and on meeting end produces:
- `vault/meetings/<date>-meeting-<id>.md` summary
- N Paperclip child tickets (1 per action item) routed to the right chief

## Architecture

```
Teams meeting URL  →  POST /meetings (this service)
                          │
                          ▼
                     Recall.ai API: create bot + join
                          │
              [bot joins as participant]
                          │
                          ▼
                Recall transcribes (recallai_streaming)
                          │
        every 1-3s ──────► /webhook/transcript (this service)
                          │
                          ▼
                  Buffer 5-10s utterance
                          │
                          ▼
                  Confidentiality keyword filter
                          │
                          ▼
                  Sonnet 4.6: silent / speak / log
                          │
              speak ─────►  Kokoro TTS → mp3 → Recall /output_audio/
              log  ─────►  Append to decisions / action_items / quotes
                          │
                  on meeting end ─────► /webhook/meeting-end (this service)
                          │
                          ▼
              Write vault/meetings/<date>-<slug>.md
              Create Paperclip child tickets
              Bot leaves the meeting
```

## Privacy + safety

- **Confidential keyword filter**: salary, termination, performance review, lawsuit, harassment, etc. → entire meeting becomes confidential; only a 1-line audit note in `vault/meetings/_audit/` is written. No transcript, no tickets.
- **Native Teams banner**: fires automatically when bot joins as participant (Microsoft handles).
- **HMAC webhook verification**: every webhook must include `X-Recall-Signature` matching `RECALL_WORKSPACE_VERIFICATION_SECRET`.
- **No auto-join**: bot only joins meetings explicitly POSTed via `/meetings` — no calendar polling.

## Cost (per Recall.ai pricing as of April 2026)

- Recall bot: $0.50 / hour
- Recall built-in transcription (recallai_streaming): $0.15 / hour
- Kokoro TTS: free (local)
- Sonnet 4.6 decision loop: ~$0.30-0.60 per meeting (depends on utterance volume)
- Audio injection: $0.15 per mp3

Per-meeting cap **$1.50** in the agent SOUL. Watchdog enforces. Free tier covers 5 hours; budget kicks in after.

## What's NOT done in V3.0

- **Sub-2-second voice-to-voice mode** — would use Recall's voice-to-voice feature (~$2/hr) for natural-feeling conversation. V3.0 uses Shape B (transcript stream + on-demand audio inject) at 3-5s round-trip, fine for "useful note-taker" persona.
- **AssemblyAI Universal-2 STT fallback** — V3.0 uses Recall built-in transcription. If Indian-English / Hinglish accuracy is poor, swap to AssemblyAI in V3.1.
- **Calendar auto-join** — V3.0 is opt-in only (manual POST). Calendar integration would be a future V3.2.
- **Bypass-lobby** — V3.0 bot lands in the lobby; host admits manually. Bypass requires signed-in bot (Azure AD app registration) — defer.

## Operational notes

- The launchd plist `com.koenig.meeting-attendee.plist` (TODO V3.4-cron) starts the service at boot.
- The agent's `meeting-attendee` Paperclip definition is at `companies/learnova-academy/agents/meeting-attendee/`.
- The skill at `companies/learnova-academy/skills/meeting-attend/SKILL.md` documents the procedure.
- The Recall API key + verification secret + ngrok URL come from `.env.koenig`.
