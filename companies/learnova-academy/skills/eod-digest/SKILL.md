---
schema: agentcompanies/v1
kind: skill
slug: eod-digest
name: EOD Digest
description: CEO's 18:00 IST routine — pull today's tickets, costs, what shipped, what's blocked; write a 1-screen digest for Vardaan via email + Slack/Teams + Paperclip queue.
version: 0.1.0
license: MIT
sources: []
---

# EOD Digest

Used by `ceo`. Runs once daily at 18:00 IST.

## Procedure

1. **Pull today's data** via Paperclip API:
   - `GET /api/companies/learnova-academy/tasks?date=<today>` — all today's tickets (created, in-progress, completed, blocked)
   - `GET /api/costs/summary?period=today` — today's spend by agent + total
   - `GET /api/companies/learnova-academy/agents` — current health/pause status
2. **Pull what shipped** — list Paperclip tickets where `metadata.publish_state=published` today + the vault path of each (course/blog)
3. **Pull what's blocked** — tickets in `blocked` status OR `metadata.publish_state=awaiting-g4` for >24h (KOE-101: "awaiting-g4" lives in metadata, not status enum)
4. **URL strategy (mobile-safe; LOCKED 2026-04-30 evening V3-6):**
   - **Published items** → `https://academy.kspl.tech/blog/<slug>` or `/learn/<slug>` (production live URL — works everywhere, including mobile)
   - **Drafts in G3 review (high-stakes)** → Vercel preview deploy URL `https://academy-pr-<n>.vercel.app/...` (auto-expires 7 days; mobile-safe)
   - **Paperclip dashboard** → `https://paperclip.kspl.tech/issues/<id>` (Cloudflare Tunnel, when V3-9 lands) OR ngrok URL in interim. **Never use `localhost:3100` in emails — breaks on mobile.**

5. **Per-publish summary block** (one block per item shipped today):

```
🚀 NEW POST PUBLISHED — https://academy.kspl.tech/blog/<slug>

Title: <title>
Author: <human author> (drafted by <agent slug>; reviewed by <reviewer slug>)
Length: <word count> words; <citation count> inline citations; <runprompt count> RunPromptCells; <kc count> KnowledgeChecks
Reviewer feedback: <count> BLOCKs resolved (<short summaries>)
Total time: <draft duration> draft + <review duration> review + <publish duration> publish
```

6. **Write the digest** to `vault/decisions/eod-<date>.md`:

```markdown
---
date: 2026-04-30
ceo: ceo
total_spend_usd: 0.62
total_tickets_completed: 1
total_tickets_in_flight: 3
total_blocked: 0
---

# EOD · 2026-04-30

## Shipped today (1)

🚀 NEW POST — https://academy.kspl.tech/blog/anthropic-creative-connectors
- Title: "Anthropic's 9 creative connectors — what each one unlocks"
- Author: Vardaan Koenig (drafted by blog-author; reviewed by content-reviewer)
- Length: 1,140 words; 7 citations; 1 RunPromptCell; 1 KnowledgeCheck
- Reviewer feedback: 2 BLOCKs resolved (URL 404 → swapped; missing KnowledgeCheck → added)
- Total time: 1h 12m draft + 24m review + 8m publish (total 1h 44m)

## In flight (3)
- KOE-119: Course "MCP from First Principles to Production" — chapter 2 drafting (ETA tomorrow)
- KOE-118: Blog "Cursor 3.2 vs Claude Code workflow" — G0 review (@content-reviewer)
- KOE-117: Blog "OpenAI on AWS Bedrock — the real tradeoffs" — drafting (ETA today)

## Blocked (0)
None

## Costs (today)
- Total: $0.62 (OpenRouter pay-as-you-go; subscription work uncounted)
- Top: blog-author $0.34 / content-reviewer $0.18 / 4 researchers $0.10
- All agents within per-task caps; 0 budget alerts

## Health
- All 23 agents nominal
- Vault: 14 files (4 research, 1 daily brief, 1 retro, 8 work product)
- 🔥 vendor moves to seed: 3 (see https://academy.kspl.tech/research/_daily/2026-04-30 once that route lands)

## For your G4 queue (0)
None — auto-publish flow active per V2.6 policy. G4 only fires on `high_stakes:true` tickets.
```

7. **Send to all channels:**
   - **Email** to `vardaan97@gmail.com` via Resend (subject: `KAA EOD · <date> · <N> shipped, <M> blocked, $<spend>`)
   - **Slack/Discord webhook** (when V3-9 lands; for now skip)
   - **Paperclip queue** — flip an `eod-digest-<date>` task to `delivered` with link to the vault file path

## Inputs

- Live Paperclip task + cost data
- Vault writes from today

## Outputs

- One markdown file in `vault/decisions/eod-<date>.md`
- One email to Vardaan
- One Paperclip task entry

## Never do

- Never include tasks that are >24h old in "shipped today"
- Never report cost as 0 if API returns null (probably means data lag — flag it)
- Never auto-G4 anything — that's the human's call

## Escalation thresholds

- Daily spend >$30 (above $25 target) → flag in digest "⚠️ over target by $X"
- 2+ agents paused → flag "⚠️ 2 agents need attention"
- 0 tickets shipped → flag "⚠️ no shipments today" (rare; suggests systemic issue)

## Budget

Per-task cap $1. Most data pulls are free; reasoning is small.
