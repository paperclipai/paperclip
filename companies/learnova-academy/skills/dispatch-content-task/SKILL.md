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


## 2026-05-01 ADDENDUM — explicit content spec on dispatch (LOCKED)

When you (chief-content or chief-marketing) dispatch a content ticket, the description MUST include a structured **Content Spec** block so the author knows exactly what to write — no guessing. The Reviewer's G0 gate checks the draft against this spec, so missing fields = downstream rework.

### Required Content Spec fields

```yaml
content_spec:
  content_type: blog | course | course-chapter
  word_target: 2400               # number; for blogs default 2200-2800; for chapters 1200-2500
  word_floor: 1800                # G0 BLOCKs below this
  word_ceiling: 3500              # G0 BLOCKs above this (rescope as course chapter)
  is_news_flash: false            # true → 800-1500w lane allowed
  primary_query: "anthropic claude security beta devsecops"
  contrarian_angle: "The scanner isn't the product — the partner ecosystem is."
  required_sources: 3             # minimum URLs to cite
  required_research_wikilinks: 2  # links to vault/research/_daily and vault/research/<vendor>
  required_glossary_wikilinks: 3  # links to /glossary/<term>
  required_runprompt_cells: 2     # for blog OR chapter
  required_knowledge_checks: 1    # 1 per 1000 words for chapters
  vendor_tag: anthropic
  level: Builder                  # for course chapters
  hero_image: auto:nano-banana-2
  inline_images:
    - "auto:nano-banana-2 — concept diagram for the section after first H2"
  related_courses: [claude-tool-use-from-zero]   # for funnel CTAs
  research_grounding:
    daily_brief: vault/research/_daily/2026-05-01.md
    vendor_note: vault/research/anthropic/2026-05-01.md
    must_cite: true               # author MUST [[wikilink]] both
```

### Why every field

- `word_target/floor/ceiling` — locks the new length policy (1,800-3,500w). G0 hard-blocks under 1,800 (unless `is_news_flash`) or over 3,500.
- `primary_query` — the SEO target. Author writes for this query; seo-optimizer audits against it post-G0.
- `contrarian_angle` — required for blog-author per their SOUL ("Contrarian angles or it didn't earn the post"). If chief-content can't articulate one, the topic isn't blog-worthy yet — punt to research-editor for a deeper take.
- `required_sources` / `required_research_wikilinks` — the new mandatory grounding. Reviewer G0 blocks otherwise.
- `hero_image` / `inline_images` — sentinels picked up by the new `image-gen-on-pass` skill auto-fired on G0 PASS.
- `research_grounding` — explicit pointers, no hunting. Author reads these before drafting.

### When fields are missing or vague

- If you (chief-content) can't fill `contrarian_angle`, escalate the ticket back to research-editor for a sharper take. Don't hand a generic ticket to blog-author — that's how April's 3.0-quality drafts happened.
- If `required_sources < 3`, add a deep-dive request to chief-research first. Authors don't scrape the web (per the new mandatory-grounding rule).

### Example

```yaml
title: "Blog · Claude Security Beta — partner moat angle"
parent: KOEA-265
assignee: blog-author
content_spec:
  content_type: blog
  word_target: 2400
  word_floor: 1800
  word_ceiling: 3500
  is_news_flash: false
  primary_query: "anthropic claude security beta devsecops"
  contrarian_angle: "The scanner isn't the product — the partner ecosystem is."
  required_sources: 4
  required_research_wikilinks: 2
  required_glossary_wikilinks: 3
  required_runprompt_cells: 2
  vendor_tag: anthropic
  hero_image: auto:nano-banana-2
  research_grounding:
    daily_brief: vault/research/_daily/2026-05-01.md
    vendor_note: vault/research/anthropic/2026-05-01.md
    must_cite: true
```

This spec is what blog-author reads at heartbeat. Without it, the author has to guess — and you saw April's quality variance.
