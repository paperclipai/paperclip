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
2. **Pull what shipped** — list Paperclip tickets that flipped to `published` today + the vault path of each (course/blog)
3. **Pull what's blocked** — tickets in `blocked` or `awaiting-g4` for >24h
4. **Write the digest** to `vault/decisions/eod-<date>.md`:

```markdown
---
date: 2026-04-29
ceo: ceo
total_spend_usd: 4.20
total_tickets_completed: 7
total_tickets_in_flight: 4
total_blocked: 1
---

# EOD · 2026-04-29

## Shipped today (3)
- 📝 Blog: "Anthropic shipped 7 connectors today" → academy.kspl.tech/blog/anthropic-7-connectors (G4 by Vardaan 16:42)
- 📚 Course delta: claude-tool-use-from-zero Module 4 updated for 7 connectors (G4 16:55)
- 🛠️ Bug fix: lesson-page reading-time pill formatting (PR #234 merged)

## In flight (4)
- 🛠️ KOE-119: Add SkillGraph component to lessons (Executor; 60% complete, ETA Wed)
- ✍️ KOE-118: Course outline "Stripe + Claude" (Author drafting; ETA Tue)
- 📝 KOE-117: Blog "MCP from first principles" (G0 review with @content-reviewer)
- 📈 KOE-116: SEO audit of Lesson PDF page (seo-optimizer)

## Blocked (1)
- 🚧 KOE-115: Voice Producer can't reach OmniVoice API (rate-limited?) — escalating to Chief Content

## Costs (today)
- Total: $4.20 (within $25 daily target)
- Top: chief-engineering $1.20 / executor $0.90 / content-author $0.60
- All agents within per-task caps
- 0 budget alerts

## Health
- All 19 agents nominal
- Vault: 12 files written today (4 research, 3 daily/synth, 2 courses, 2 blogs, 1 decision)

## For your G4 queue (1)
- 📝 Blog "MCP from first principles" — pending after G0 → expect Tue morning
```

5. **Send to all 3 channels**:
   - **Email** to `vardaan97@gmail.com` via Resend (subject: `KAA EOD · <date> · 3 shipped, 1 blocked, $4.20`)
   - **Slack/Teams DM** to Vardaan (Phase 3 — for now log)
   - **Paperclip queue** — flip an `eod-digest-<date>` task to `delivered` with link to vault file

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
