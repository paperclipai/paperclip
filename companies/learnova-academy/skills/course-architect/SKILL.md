---
name: course-architect
description: >
  Course Author's first-stage skill — design a multi-chapter course outline
  before any chapter is written. Defines audience, prerequisites, learning
  outcomes, chapter sequence, and capstone project. Use when ticket lands
  assigned to @course-author with type new-course.
---

# Course Architect

Outline first. Always. A great course needs a great spine.

## Scope

- One new-course ticket → one outline.md file
- Outline is reviewed by @content-reviewer (G0) and @ceo (strategic alignment) BEFORE per-chapter tickets are dispatched
- Hand off back to @chief-content for chapter-by-chapter dispatch sequencing

## Inputs

- Paperclip ticket with: course slug, target audience, vendor_tag, level (Beginner/Builder/Professional), priority
- Existing course list in `src/lib/fixtures.ts` (don't duplicate; complement)
- Today's research vault for grounding examples in real-world AI ecosystem

## Workflow

### 1. Audience + outcome definition

Define:
- **Target audience** (who exactly — current role, current skills, what they don't yet know)
- **Prerequisites** (what they need to bring; ≤4 bullets)
- **Learning outcomes** (3-5 observable, measurable — "ship a working MCP server", not "understand MCP")

If you can't write a falsifiable success criterion ("learner can do X"), the course concept is too vague. Push back to chief-content.

### 2. Chapter sequencing

Design 4-8 chapters such that:
- Each chapter builds on prior chapters (declare prerequisites)
- Each is a complete unit (a learner who stops at chapter 3 has learned chapters 1-3 fully)
- Difficulty progression is monotonic (no harder-then-easier-then-harder)
- Total duration: Beginner ≤180 min, Builder ≤240 min, Professional ≤360 min

For each chapter: title (answer-first), 3-5 learning objectives, key concepts, 1 hands-on exercise, duration estimate.

### 3. Capstone project

End the course with a capstone that proves the learning outcomes:
- Specific deliverable
- Verification criteria
- Estimated time-to-complete

Without a capstone, the course can't prove it taught anything.

### 4. Write outline.md

`vault/courses/<slug>/outline.md`:

```markdown
---
course_slug: mcp-server-scaffolding-production
title: "How to build a production MCP server in 5 chapters"
status: outline-draft-for-review
author: course-author
level: Builder
vendor_tag: anthropic
target_audience: "Developers comfortable with Python or TypeScript who've used at least one LLM API. New to MCP."
prerequisites:
  - "Basic Python or TypeScript syntax"
  - "Familiarity with REST APIs or stdio-style processes"
  - "Used Claude / GPT / Gemini API at least once"
learning_outcomes:
  - "Ship a working MCP server in production with auth, logging, and tests"
  - "Diagnose connection + auth issues independently"
  - "Add observability + structured logging"
  - "Choose between stdio and HTTP transport for a use case"
total_duration_min: 240
chapter_count: 5
capstone_project_min: 60
---

# How to build a production MCP server in 5 chapters

## Why this course
<2-3 paragraphs — why now, what's at stake, who benefits>

## Course outline

### Chapter 1: What MCP is and isn't
- **Duration**: 30 min
- **Prerequisites**: course intro
- **Learning objectives**:
  - Explain MCP vs LSP vs OpenAPI in 1 paragraph each
  - Identify when MCP is the right tool (vs alternatives)
  - Recognize the 3 protocol primitives (Tools, Resources, Prompts)
- **Key concepts**: protocol design, JSON-RPC over stdio, manifest spec
- **Hands-on**: read the official MCP spec; identify 3 examples in your own work where MCP would replace a custom integration

### Chapter 2: ...
[same pattern]

### Chapter N: ...

## Capstone project

**Build a production MCP server for [specific real domain].**

Deliverable:
- A repo with: tests, structured logging, auth, README
- Server passes the verification suite (provided)
- Server handles 3 representative queries cleanly

Verification:
- All tests green
- Logs are structured + searchable
- Auth rejects unauthorized requests + accepts authorized ones

Time: 60 min

## Why this beats alternatives

<2-3 sentence opinionated stance — what makes this course genuinely worth a learner's 4 hours>
```

### 5. Hand off

Status: `outline-awaiting-g0` → @content-reviewer.

Comment:
```
✅ Course outline ready · vault/courses/<slug>/outline.md
- 5 chapters, 240 min total + 60 min capstone
- Audience: <one-line>
- Prerequisites: 3 bullets
- 4 learning outcomes (all measurable)
- Capstone: ship a production MCP server with tests + auth + logging

Status: outline-awaiting-g0 → @content-reviewer
```

## Output

`vault/courses/<slug>/outline.md` + Paperclip ticket comment.

## Notes

- Per-task cap **$1**.
- Outline first, chapters second. Never short-circuit.
- If you can't fit the course in 8 chapters, the scope is too big — split into 2 courses.
- Use `seo-cluster` skill to think about how this course interlinks with existing courses + blogs.

## Escalation

- Topic too big for 8 chapters → propose 2 separate courses
- Audience definition is vague → block + ask chief-content
- No clear capstone possible → topic might not be a course (might be a blog series)
