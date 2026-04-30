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

### 3. Draft body using the strict structure (V3-1b LOCKED 2026-04-30)

**Mandatory structural pattern** (Reviewer BLOCKs anything missing these):
- **Wikipedia-style lead sentence**: First sentence MUST be `[Topic] is [category] [defined-by]` (e.g., "MCP is an open protocol introduced by Anthropic in November 2024 for connecting AI assistants to data sources.")
- **Lead paragraph**: 40-80 words. Includes a named entity + a number + a date in the first 2 sentences (these are AI-engine retrieval anchors).
- **Key facts numbered list**: 3-7 numbered items immediately after the lead paragraph, before any prose. Each fact 1 sentence; numerical or dated where possible.
- **References footer**: Every post ends with `## References` — numbered `[1]`, `[2]`, etc., format `[N] Title — URL · retrieved YYYY-MM-DD`.
- **Author**: choose from `src/lib/authors.ts` registry (vardaan-koenig | editorial-team). Frontmatter `author: vardaan-koenig`.

```markdown
---
date: 2026-04-30
author: vardaan-koenig
agent_drafted_by: blog-author
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

<Wikipedia-style lead. First sentence: "[Topic] is [category] [defined-by]." 40-80 words total. Includes a named entity + a number + a date in the first 2 sentences.>

## Key facts

1. <One sentence with a date or number; cite as [1].>
2. <Same.>
3. <Same.>
4. <Optional, up to 7.>

## <Answer-first H2 — first answer in first sentence>

<Contrarian-angle paragraph: "Most takes on this miss that..." or "The press-release version says X; the engineering reality is Y because Z [2]."

2-3 paragraphs follow. Each leads with the answer; supports with evidence + citation.>

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

## References

[1] <Title of cited primary source> — <https://primary.source/url> · retrieved 2026-04-30
[2] <Title> — <https://primary.source/url> · retrieved 2026-04-30
[3] <Title> — <https://primary.source/url> · retrieved 2026-04-30
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

**Citation pre-flight (BLOCK if failed — do not hand off until resolved):**

```bash
# Count inline [N] citation markers in the body (excluding the References section)
grep -oP '\[\d+\]' vault/blogs/<date>-<slug>/draft.md | wc -l
```

- Expected: **≥ 5** inline `[N]` citations in the body. If <5, add citations before handoff.
- Confirm `## References` footer section is present at the end of the draft.
- Both checks must pass. Record the count in the handoff comment (see step 6).

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
- citations: 7 inline ✅ · ## References footer ✅ (all 7 URLs verified live <HH:MM>)
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
