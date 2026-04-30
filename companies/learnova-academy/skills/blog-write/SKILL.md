---
name: blog-write
description: >
  Blog Author's primary skill — write a 800-1500 word blog post with a falsifiable
  lead claim, contrarian angle, ≥5 inline citations, 1 RunPromptCell, 1
  KnowledgeCheck, and a course funnel link. Use when ticket lands assigned
  to @blog-author with type blog | course-delta-supporting-blog.
---

# Blog Write

Write blog posts that earn traffic + AI-search citations + course click-throughs.

## Scope

- One blog ticket → one markdown draft in `vault/blogs/<date>-<slug>/draft.md`
- 800-1500 words (HARD bounds; reject ticket if scope demands more)
- Specific structure (see Workflow §3) — NOT free-form prose
- Hand off to @content-reviewer at status `awaiting-g0`

## Inputs

- Paperclip ticket with: angle, runnable_example, sources_required, vendor_tag, primary_query
- Today's daily brief at `vault/research/_daily/<date>.md`
- Per-vendor research notes at `vault/research/<vendor>/<date>.md`
- The list of related courses to link from `src/lib/fixtures.ts` courses array

## Workflow

### 1. Confirm the topic warrants a blog

Reject (escalate to chief-content) if:
- Scope is clearly multi-chapter (this is a course)
- No contrarian angle exists (post adds nothing beyond the press release)
- Topic doesn't fit any of: (a) ranks Google, (b) AI-search citation, (c) funnels to a course

### 2. Read research notes + verify primary sources

```bash
ls vault/research/_daily/$(date +%Y-%m-%d).md
ls vault/research/<vendor>/$(date +%Y-%m-%d).md
```

Pin 3-5 primary-source URLs. Verify each returns 200 with WebFetch before drafting.

### 3. Draft body using the strict structure

```markdown
---
date: 2026-04-30
author: blog-author
ticket: KOE-N
vendor_tag: <anthropic|openai|google|community>
content_type: article
status: draft-for-review
reading_time_min: 5
primary_query: "<exact search phrase this targets>"
contrarian_angle: "<the non-obvious claim>"
sources:
  - https://...
whats_new:
  - <single sharp claim — used in og:image + meta description>
learning_objectives:
  - <observable takeaway>
  - <observable takeaway>
---

# <Answer-first H1: How to / Why X / What X means for Y>

<Lead paragraph — 50-100 words. Answers the primary_query directly.
Includes the falsifiable claim. Cites primary source.>

<Contrarian-angle paragraph — "Most takes on this miss that..." or
"The press-release version says X; the engineering reality is Y because Z.">

## <Answer-first H2 — first answer in first sentence>

<2-3 paragraphs. Each leads with answer; supports with evidence + citation.>

## <Answer-first H2>

<Same pattern. Include 1 RunPromptCell here for "show me, don't tell me".>

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="<concrete prompt that demonstrates the post's core point>"
  expectedOutput="<2-3 line description of what the model will return>"
/>

## <Answer-first H2>

<KnowledgeCheck
  question="<single question that validates comprehension>"
  options={["A", "B", "C", "D"]}
  correctIdx={N}
  explanation="<why the right answer is right + 1-line tie-back to the post's claim>"
/>

## What to do next

<2-3 sentences. Specific, actionable.>

For deeper dive on this topic, our course [[course/<slug>]] walks through <specific outcome>.
```

### 4. Citation verification (pre-handoff)

For each cited URL, run WebFetch to confirm:
- HTTP 200
- Page content actually supports the claim being cited

If any URL fails, swap source from researcher's notes or flag in ticket as TODO.

### 5. Word count + structure check (self-check)

```bash
wc -w vault/blogs/<date>-<slug>/draft.md
```

Expected: 800-1500 words (excluding frontmatter). Outside this range = revise before handoff.

### 6. Hand off to G0

```yaml
status: awaiting-g0
assignee: @content-reviewer
```

Comment on ticket:
```
14:22 ✅ Blog draft ready · vault/blogs/<date>-<slug>/draft.md
- 1,140 words; 1 RunPromptCell, 1 KnowledgeCheck
- Primary query: "<...>"
- Contrarian angle: "<...>"
- Cited 7 sources (all verified live <HH:MM>)
- Funnel link: [[course/<slug>]]
- Status: awaiting-g0 → @content-reviewer
```

## Output

A finished, citation-rich blog draft + Paperclip ticket flip + comment.

## Notes

- Per-task cap **$1**. Most blogs land at ~$0.40-0.60 on Sonnet 4.6.
- HARD word bounds: 800-1500. Reject tickets that demand more (course-delta or new-course instead).
- ≤15 words verbatim from any single source. Paraphrase + cite.
- One contrarian angle per piece. Force-fit doesn't work; if you can't find one organically, flag the topic.

## Escalation

- Source URL is dead → swap from researcher notes or flag for replacement
- Topic warrants >1500 words → escalate to course-delta with chief-content
- Primary source contradicts itself → cite both + frame as ambiguity
