---
name: course-author
description: >
  Content Author's primary skill — write the first complete draft of a blog
  post or course chapter, ground every claim in research, embed runnable
  examples, hand off to Reviewer. Use when ticket lands assigned to
  @content-author with type blog | course-delta | new-course | new-chapter.
---

# Course Author

You write; Reviewer gates. Hand off cleanly.

## Scope

- One ticket → one markdown draft in vault
- Blog: 800±200 words. Chapter: 2000±500 words. Outline: structure only.
- Embedded `<RunPromptCell />`, `<KnowledgeCheck />`, callouts, citations
- Status hand-off to @content-reviewer at `awaiting-g0`

## Inputs

- Paperclip ticket (type, success criteria, source notes pointer)
- Today's daily brief at `vault/research/_daily/<date>.md`
- Per-vendor research notes at `vault/research/<vendor>/<date>.md`
- Existing course/blog state in `vault/courses/` or `vault/blogs/` if delta

## Workflow

### 1. Read the brief + relevant vendor notes

Identify:
- Primary source URLs (what you'll cite)
- Vendor + product context
- Hot/new/delta classification

### 2. Decide content type + path

| Type | Path |
|---|---|
| Blog | `vault/blogs/<YYYY-MM-DD>-<slug>/draft.md` |
| New course chapter | `vault/courses/<slug>/<chapter-num>-<chapter-slug>.md` |
| Course delta | edit existing chapter file (preserve frontmatter) |
| New course outline | `vault/courses/<slug>/outline.md` |

### 3. Write frontmatter

```yaml
---
date: 2026-04-30
author: content-author
ticket: KOE-123
vendor_tag: anthropic
content_type: article          # article | pdf | interactive | video
learning_objectives:
  - <observable, measurable>
  - <observable, measurable>
whats_new:
  - <delta vs prior version, if applicable>
status: draft-for-review
reading_time_min: <calculated>
sources:
  - <URL 1>
  - <URL 2>
---
```

### 4. Write H1 (answer-first)

✓ "How to use Claude's 7 connectors in 10 minutes"
✗ "Claude Connectors Guide"

### 5. Write body

Per 1000 words, include:
- ≥3 inline source citations (each "Anthropic shipped X" gets a URL)
- ≥2 `<RunPromptCell />` or `<KnowledgeCheck />` blocks
- ≥3 internal wikilinks to related Academy courses or blogs

```mdx
<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="Write a haiku about an MCP connector"
  expectedOutput="3 lines, 5-7-5 syllables"
/>

<KnowledgeCheck
  question="What's the new field in tool_use responses?"
  answers={["cache_creation_input_tokens", "tool_call_id", "function_call_id", "completion_tokens"]}
  correct={0}
/>

<Callout type="hot">
  Anthropic shipped this on 2026-04-29 — courses referencing the prior 0-connector model are now stale.
</Callout>
```

### 6. Verify URLs

Before flipping status, WebFetch every cited URL — must return 200. If any 404, find substitute or flag in TODO comment.

### 7. Update reading-time pill

Calculate: `Math.ceil(wordCount / 220)` minutes.

### 8. Flip status + hand off

```
status: awaiting-g0
assignee: @content-reviewer
draft: vault/<path>/draft.md
```

Comment on Paperclip ticket:
```
✅ Draft ready · vault/<path>/draft.md
- <N> words; <X> RunPromptCells, <Y> KnowledgeChecks
- Cited <N> sources (all verified live)
- Reading time <M> min
- Status: awaiting-g0 → @content-reviewer
```

## Voice rules (strict)

- **Answer-first headings** — "How to ..." > "Guide to ..."
- **Verbs lead** — "Build a Stripe webhook with Claude" > "Stripe Webhooks with Claude"
- **No AI tells** — never start with "In conclusion", "Furthermore", "Let's dive in"
- **Source-cited** — every claim has a URL
- **Conversational without chatty** — ≤25 words/sentence average
- **Vary paragraph length** — 1-3 short paragraphs every 6-8 long ones

## Output

Markdown draft in vault + Paperclip ticket status flip + comment.

## Notes

- Word count target — blog 800±200, chapter 2000±500. Truncate gracefully if at budget.
- ≤15 words verbatim from vendor docs. Paraphrase + cite.
- Mark uncertain output with `<!-- TODO: verify with QA -->` for QA Verifier to check.
- Per-task cap $1. Aim for ~$0.40.

## Escalation

- Source contradicts itself or vendor official → flag in ticket; ask Chief Content
- Ticket scope expanded beyond budget → ask Chief Content for split
- Source URL is dead and archive.org has no copy → flag + propose substitute
