---
schema: agentcompanies/v1
kind: skill
slug: escalate-vendor-emergency
name: Escalate Vendor Emergency
description: Chief Research — when a researcher flags a HOT item that potentially obsoletes a live Academy course, escalate same-heartbeat to CEO with a same-day-blog recommendation.
version: 0.1.0
license: MIT
sources: []
---

# Escalate Vendor Emergency

Used by `chief-research`. Triggered by a researcher flagging `obsoletes_course: <slug>` or `priority: HOT` in their daily note.

## Procedure

1. **Read the researcher's note** in full (`vault/research/<vendor>/<date>.md`)
2. **Verify the HOT item is real** — re-fetch the cited URL (don't trust the summary); confirm vendor + claim
3. **Cross-check against current Academy course state** — if `obsoletes_course: <slug>` is set, read `vault/courses/<slug>/` and confirm the example or claim is now wrong
4. **Decide impact**:
   - `replace-immediately` — the live course is now factually wrong; user-facing
   - `update-soon` — the course works but is suboptimal; user-facing within 1 week
   - `nice-to-have` — adjacent improvement; queue for next sprint
5. **Comment on CEO's daily-triage meta-task** with the escalation:

```
🔥 HOT escalation · Anthropic 7-connector launch
- Source: https://anthropic.com/news/connectors (verified 06:35)
- Obsoletes: claude-tool-use-from-zero/04-connectors (Module 4 references 0 connectors → now 7)
- Impact: replace-immediately
- Recommendation: blog post today (200 words) + course-delta this week
- Researcher: @researcher-anthropic (note: vault/research/anthropic/2026-04-29.md)
```

6. **Notify directly affected chiefs** — Chief Content (for blog/course), Chief Engineering (if affects code examples), Chief Marketing (for SEO post-update)

## Inputs

- Researcher's daily note
- Current course state in `vault/courses/<slug>/`

## Outputs

- One comment on CEO daily-triage task
- DMs/comments to affected chiefs

## Never do

- Never escalate without re-verifying the source URL — researchers are right ~95% of the time but wrong ~5%
- Never escalate stale items (>24h old) — flag for next-day triage instead
- Never write the blog yourself — that's content-author's job after CEO ticket

## Escalation thresholds

- `replace-immediately` items → CEO same heartbeat (push notification on Paperclip)
- `update-soon` items → CEO daily triage as `priority: hot`
- `nice-to-have` → defer to next sprint planning

## Budget

Per-task cap $0.50.
