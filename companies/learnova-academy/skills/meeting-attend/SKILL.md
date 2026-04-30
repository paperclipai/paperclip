---
name: meeting-attend
description: >
  Meeting Attendee's primary skill — join a Microsoft Teams meeting via Recall.ai
  Web Bot, transcribe in real-time, decide when to speak, inject Kokoro-TTS audio
  on need, write a structured meeting summary to vault/meetings/, and create
  Paperclip child tickets for every action item. Use when a Teams meeting URL is
  posted to /meetings on the FastAPI service.
---

# Meeting Attend

Join, listen, contribute usefully, file tickets. Run via the FastAPI service at `services/meeting-attendee/`.

## Scope

- One meeting per skill invocation
- One vault summary per meeting
- N tickets per meeting (1 per action item)
- Optional voice contributions (avg 0-2 per meeting)

## Inputs

- Recall.ai API key (`RECALL_API_KEY` from `.env.koenig`)
- ngrok public URL (`MEETING_BOT_PUBLIC_URL` — e.g. `https://meeting-bot.vardaan.ngrok-free.app`)
- Teams meeting URL (POST body)
- Org context (loaded at meeting start — see Workflow §1)
- Anthropic API key for Sonnet 4.6 decision loop (subscription-billed via claude_local)
- Kokoro local TTS service running at `localhost:8888`

## Workflow

### 1. Load org context (on `on_meeting_started`)

```python
context = {
    "company_md": read("companies/learnova-academy/COMPANY.md"),
    "culture_md": read("companies/learnova-academy/CULTURE.md"),
    "by_date": read_last_n("vault/_index/by-date.md", days=7),
    "retros": read_last_n("vault/retrospectives/_recent/", weeks=4),
    "meetings": read_last_n("vault/meetings/_recent/", count=8),
    "eod_digests": read_last_n("vault/decisions/eod-*.md", count=3),
    "agents": GET("/api/companies/<id>/agents"),
    "seed_topics": read_glob("companies/learnova-academy/seed-topics-*.yaml")[-1],
}
```

This becomes your system-prompt addendum for every Sonnet decision call.

### 2. Buffer transcript (on `/webhook/transcript`)

Recall sends utterance chunks every 1-3s via webhook. Append to a sliding 5-10s buffer keyed by speaker. When buffer flushes (silence or end-of-utterance), pass to decision loop.

### 3. Decide: silent / speak / log (Sonnet 4.6 call per buffer)

System prompt template:

```
You are the Meeting Attendee bot for Koenig AI Academy.

Org context: <org_context>

The following utterance was just spoken by <speaker>:
"<utterance>"

Recent meeting context (last 60 seconds):
<recent_buffer>

Decide:
1. "silent" — default; no contribution needed
2. "speak" — direct address to bot, OR topic stalled 3+ turns AND you have context
3. "log" — note an action item or decision in your private buffer for end-of-meeting summary

If "speak", produce a 2-sentence-max reply. Reference vault facts where relevant.
If "log", produce a brief note describing what to capture (decision text, action item with proposed assignee).

Output JSON: {"action": "silent|speak|log", "text": "...", "reason": "..."}
```

Confidentiality keyword filter (PRE-decision): if utterance contains "salary", "performance review", "termination", "legal", "lawsuit", "personnel issue", or similar — output `{"action": "silent", "reason": "confidentiality"}` immediately and DO NOT log the utterance to your private buffer.

### 4. If "speak": synthesize + inject

```python
mp3 = await kokoro_tts(reply_text)  # local; <800ms typical
await recall_inject_audio(meeting_id, mp3)
```

Log the contribution to your private buffer (timestamp + text + reason).

### 5. If "log": append to decisions / action_items / quotes buffers

Track separately:
- `decisions[]` — clear yes/no agreements
- `action_items[]` — `{description, proposed_assignee, due_date_hint, priority_hint}`
- `key_quotes[]` — verbatim lines worth preserving (3-5 max per meeting)

### 6. On `on_meeting_end`: write summary + create tickets

Write `vault/meetings/<YYYY-MM-DD>-<slug>.md`:

```markdown
---
date: 2026-05-01
attendees: [Vardaan Koenig, ...]
duration_min: 47
meeting_type: weekly-content-sync
decisions: [...]
action_items_count: 5
tickets_created: [KOE-201, KOE-202, KOE-203, KOE-204, KOE-205]
bot_interventions: 1
cost_usd: 0.78
---

# <slug> — <date>

<2-3 paragraph summary>

## Decisions
- ...

## Action items
- KOE-201 → @chief-content: <description>
- ...

## Key quotes
- "..." — <Speaker>, <timestamp>

## Bot interventions
- 14:22 · "I'll file that as a ticket for chief-content. Should we treat it as high-stakes?"
  Reason: <reason from decision call>
```

For each action_item, create a Paperclip child ticket via `POST /api/companies/<id>/issues`:

```json
{
  "title": "<derived from action item>",
  "description": "<context including meeting URL, speaker, timestamp, full quote>",
  "assigneeAgentSlug": "<chief-...>",
  "metadata": {
    "source": "meeting-attendee",
    "meeting_id": "<id>",
    "meeting_vault_path": "vault/meetings/<date>-<slug>.md",
    "high_stakes": <inferred>
  }
}
```

Confidential meeting handling: if any utterance triggered confidentiality during the meeting, the ENTIRE meeting becomes confidential. Write only `vault/meetings/_audit/<date>-<slug>-confidential.md` with one line: `Confidential meeting attended; no transcript or summary produced.`

### 7. Bot leaves the meeting

```python
await recall_leave(meeting_id)
```

## Output

A finished `vault/meetings/<date>-<slug>.md` (or audit note) + N Paperclip child tickets + a heartbeat comment on the parent meeting ticket.

## Notes

- Per-meeting cap **$1.50**. Most meetings land $0.50-$1.20.
- Monthly cap **$50**. Watch dog enforces.
- Sub-2-second latency requires Recall voice-to-voice (~$2/hr); we use Shape B (transcript stream + on-demand audio) at 3-5s round-trip, which is fine for "useful note-taker" persona.
- Native Teams bot-recording banner fires automatically when bot joins as participant. India = no all-party-consent rule. EU users: bot inject a 3-sec consent MP3 via `automatic_audio_output.in_call_recording` (see Recall docs).

## Escalation

- Recall API persistent failure → write to `vault/meetings/_audit/<date>-recall-down.md` + ping CEO via emergency channel
- Sonnet API persistent failure → stay silent for the meeting; still capture transcript via Recall built-in; produce summary via Sonnet retry post-meeting
- Cost > $2.00 mid-meeting → break in with "Bot heads-up: cost is exceeding budget; consider wrapping or extending budget" (only voice contribution allowed regardless of speak-criteria)

## Privacy

- Never store confidential meetings in vault — only the 1-line audit note
- Never share meeting content cross-team without an explicit ticket reference
- Recall.ai is HIPAA / GDPR / SOC 2 compliant per their docs (verify per meeting type)
- ngrok URL is public; the FastAPI service authenticates Recall webhooks via the `RECALL_WORKSPACE_VERIFICATION_SECRET` HMAC signature
