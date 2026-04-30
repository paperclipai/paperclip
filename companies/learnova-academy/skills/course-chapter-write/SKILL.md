---
name: course-chapter-write
description: >
  Course Author's chapter-writing skill — write one comprehensive course
  chapter (2,000-5,000 words) with prerequisites, learning objectives,
  RunPromptCells, KnowledgeChecks, callouts, hands-on exercise, and
  what's-next pointer. Use when ticket lands assigned to @course-author
  with type new-chapter or course-delta.
---

# Course Chapter Write

One chapter at a time. Each is a complete unit.

## Scope

- One chapter ticket → one markdown file at `vault/courses/<slug>/<NN>-<chapter-slug>.md`
- 2,000-5,000 words (chapter-size, NOT blog-size)
- Strict structure (see Workflow §3)
- Hand off to @content-reviewer at `awaiting-g0`

## Inputs

- Paperclip ticket with: course slug, chapter number, prerequisites_chapters, focus topic, learning objectives
- The course outline at `vault/courses/<slug>/outline.md` (must exist + be G0-passed before this skill runs)
- Prior chapters in `vault/courses/<slug>/<MM>-*.md` (for context + cross-references)

## Workflow

### 1. Verify prerequisites

Read `vault/courses/<slug>/outline.md`:
- Confirm this chapter's number matches the outline
- Confirm prior chapters declared as prerequisites are written + G0-passed
- Read the prior chapters to ground cross-references

If prerequisites missing → block + ask chief-content for sequencing fix.

### 2. Plan the chapter (5-min mental sketch)

Before writing, decide:
- The ONE specific outcome a learner achieves by chapter end
- The 3-4 sub-concepts they'll build through
- The hands-on exercise that proves they got it
- The 2 RunPromptCells that demonstrate the concept
- The 2 KnowledgeChecks (1 MCQ + 1 free-form)
- The 1 callout (info/warn/hot)

### 3. Draft using the strict structure (V3-1b LOCKED 2026-04-30)

**Mandatory structural pattern** (Reviewer BLOCKs anything missing these):
- **Wikipedia-style lead sentence**: chapter must open with a definition matching `[Topic] is [category] [defined-by]` form
- **Lead paragraph**: 60-120 words. Includes a named entity + a number + a date in the first 2 sentences
- **Key facts numbered list**: 3-7 items immediately after lead paragraph
- **References footer**: numbered `[N] Title — URL · retrieved YYYY-MM-DD`
- **Author**: choose from `src/lib/authors.ts` registry. Frontmatter `author: vardaan-koenig` (default).

`vault/courses/<slug>/<NN>-<chapter-slug>.md`:

```markdown
---
course_slug: mcp-server-scaffolding-production
chapter_num: 2
chapter_slug: tools-resources-prompts
title: "Tools, Resources, Prompts — the three primitives"
status: draft-for-review
author: vardaan-koenig
agent_drafted_by: course-author
date: 2026-04-30
duration_min: 50
prerequisites_chapters: [1]
learning_objectives:
  - Define each of the three MCP primitives in 1 sentence
  - Implement a Tool, a Resource, and a Prompt in the hello-world server
  - Choose the right primitive for a given use case (decision rule)
key_concepts: [tool, resource, prompt, JSON Schema, manifest]
hands_on_exercise: "Extend the hello-world server with one Tool, one Resource, and one Prompt"
sources:
  - https://spec.modelcontextprotocol.io/...
  - ...
---

# Tools, Resources, Prompts — the three primitives

<Wikipedia-style lead. First sentence: "[Topic] is [category] [defined-by]." 60-120 words. Includes a named entity + a number + a date in the first 2 sentences.>

> **Prerequisites**: Chapter 1 (What MCP is and isn't) — you should have a hello-world server running.
>
> **Time**: 50 minutes
>
> **Learning objectives**: by the end of this chapter, you can define each primitive in 1 sentence,
> implement all three in your hello-world server, and apply a clear decision rule for which to use when.

## Key facts

1. <One sentence with a date or number; cite as [1].>
2. <Same.>
3. <Same.>

## Why three primitives, not one

<2-3 paragraphs. Patient setup. Cite the MCP spec. Frame the design rationale.>

## Tools — what the model calls

<3-5 paragraphs. Patient explanation. Cite primary source. Then:>

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="<concrete prompt that uses a Tool>"
  expectedOutput="<3-line description>"
/>

<Callout type="warn">
A common pitfall: <specific anti-pattern> — <why it bites + how to avoid>.
</Callout>

## Resources — what the model reads

<Same depth. Same scaffolding.>

## Prompts — what the model receives as templates

<Same depth.>

<KnowledgeCheck
  question="A user wants to look up the latest deployment status from their CI/CD system. Which MCP primitive fits best?"
  options={["Tool", "Resource", "Prompt", "Either Tool or Resource works equally well"]}
  correctIdx={0}
  explanation="The deployment status changes frequently and the model needs to fetch fresh data on demand — that's a Tool call. Resources are better for static reference content; Prompts are templates the user picks from."
/>

## Decision rule: which primitive to use

<Concrete decision rule (table or flowchart in prose). Specific, falsifiable.>

## Hands-on exercise

**Extend your hello-world MCP server with:**
1. One Tool: <specific tool spec>
2. One Resource: <specific resource spec>
3. One Prompt: <specific prompt spec>

**Verification**: <how to check it works>

**Estimated time**: 20 minutes

<KnowledgeCheck
  question="<Free-form>"
  options={["self-check"]}
  correctIdx={0}
  explanation="<self-check criteria>"
/>

## What's next

In Chapter 3, you'll add <next outcome> — building on the primitives you just shipped.

## References

[1] MCP Specification — https://spec.modelcontextprotocol.io/ · retrieved 2026-04-30
[2] <Title> — <URL> · retrieved 2026-04-30
[3] <Title> — <URL> · retrieved 2026-04-30
```

### 4. Word count + structure check

```bash
wc -w vault/courses/<slug>/<NN>-*.md
```

Expected: 2,000-5,000. Outside = revise.

Required counts:
- ≥2 RunPromptCells
- ≥2 KnowledgeChecks (1 MCQ + 1 free-form)
- ≥1 Callout
- ≥3 inline citations to primary sources
- ≥1 explicit "What's next" pointer

### 5. Hand off

```yaml
status: awaiting-g0
assignee: @content-reviewer
```

```
15:42 ✅ Chapter ready · vault/courses/<slug>/<NN>-<chapter-slug>.md
- 3,200 words; 3 RunPromptCells, 2 KnowledgeChecks, 1 Callout
- Prerequisites: ch01 ✓
- Duration: 50 min
- Hands-on: extend hello-world with Tool + Resource + Prompt
- Cited 6 sources
- Status: awaiting-g0 → @content-reviewer
```

## Output

Markdown chapter + ticket comment.

## Notes

- Per-task cap **$2** (chapters are 3× blog size).
- 2,000-5,000 words is the strike zone. Below = thin; above = should split into 2 chapters.
- One specific outcome per chapter. Multi-outcome chapters confuse learners.
- Domain-specific examples ALWAYS. Never "foo bar baz".

## Escalation

- Chapter would naturally exceed 5,000 words → propose split into chapters N + N.5 with chief-content
- Outline says X but topic naturally wants Y → block + ask chief-content for outline fix
- Hands-on exercise impossible without infra (e.g., needs cloud account) → propose simpler exercise + flag in ticket
