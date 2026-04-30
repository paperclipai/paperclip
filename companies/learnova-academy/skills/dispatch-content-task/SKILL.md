---
name: dispatch-content-task
description: >
  Chief Content's dispatch skill — receive a CEO-triaged content ticket, decide
  which workers to engage (author + reviewer always; +slide-audio +voice if
  course chapter), set DOD, dispatch. Use when Chief Content's heartbeat fires
  with new content tickets queued.
---

# Dispatch Content Task

You receive tickets from CEO; you dispatch to your team with clear DOD; you don't write.

## Scope

- One CEO ticket → one or more worker tickets
- Author → Reviewer chain always required
- Optional Slide+Audio + Voice for full courses
- Set explicit DOD (word count, RunPromptCell count, KnowledgeCheck count, source count)

## Inputs

- CEO-dispatched Paperclip ticket with `assignee: chief-content`
- Daily brief at `vault/research/_daily/<date>.md`
- Per-vendor research notes (for grounding)

## Workflow

### 1. Classify ticket type

| Type | Path |
|---|---|
| Blog (200-1500 words) | author + reviewer |
| Course delta | author + reviewer |
| New chapter (1500-5000 words) | author + reviewer + slide-audio + voice |
| New course outline | author + reviewer (chapters dispatched after outline approval) |

### 2. Pick the source notes pointer

Look up `vault/research/<vendor>/<date>.md` and `vault/research/_daily/<date>.md`. Pin to ticket so Author doesn't re-search.

### 3. Set DOD per ticket type

**Blog:**
- 800±200 words
- ≥3 source citations
- ≥2 RunPromptCell or KnowledgeCheck
- 1 internal wikilink

**Chapter:**
- 2000±500 words
- ≥6 source citations
- ≥4 RunPromptCell + ≥3 KnowledgeChecks
- ≥3 internal wikilinks

**Outline:**
- 4-8 chapter titles + 2-line each
- Learning objectives per chapter
- Total course duration estimate

### 4. Capacity check

Read your team's current load via `GET /api/companies/.../tasks?assignee=<slug>&status=in_progress`. If Author is at 3+ tickets → defer non-hot, comment back to CEO.

### 5. Dispatch Author ticket

```yaml
title: "<Author content type>: <ticket summary>"
assignee: content-author
status: ready-to-author
deadline: <ISO>
budget_estimate: $<USD>
success_criteria:
  - <DOD bullet 1>
  - <DOD bullet 2>
context:
  - source: vault/research/_daily/<date>.md
  - related_courses: [<slug>, ...]
  - vendor_tag: anthropic | openai | google | community
  - content_type: article | pdf | interactive | video
```

Save via `POST /api/companies/learnova-academy/tasks`.

### 6. Pre-create downstream tickets (status: pending-handoff)

- Reviewer ticket (status: pending-handoff; activates when Author flips to awaiting-g0)
- Slide+Audio ticket (status: pending-handoff; activates when Reviewer PASSes)
- Voice ticket (status: pending-handoff; activates after Slide+Audio ships scripts)

This creates the audit trail upfront.

### 7. Comment on CEO ticket

```
✅ Dispatched · KOE-<id>
- @content-author drafting (deadline <ISO>)
- @content-reviewer queued for G0
- @slide-audio-producer queued post-G0 (chapter only)
- @voice-producer queued post-slide-audio (chapter only)
Budget: $<sum>
```

## Output

1-N Paperclip tickets created + CEO comment.

## Notes

- Don't pre-write the draft. That defeats the chain.
- Author + Reviewer are ALWAYS both required. Don't dispatch Author without queuing Reviewer.
- For HOT vendor blogs, deadline = same day; cap = $1.50 across both agents.
- For chapters, deadline = +3 days; cap = $4 across all 4 agents.

## Escalation

- Author at 3+ tickets and ticket is HOT → ask CEO whether to delay or pull a chapter from another track
- Source notes for the topic missing → block; ping chief-research same heartbeat
