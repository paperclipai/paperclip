---
name: plan-mode-harness
description: >
  Planner's primary skill — produce a tight implementation plan for a single
  engineering ticket using Claude Code's plan mode. Read the codebase, propose
  approaches, pick one, write the plan to vault/decisions/. Use when ticket
  lands assigned to @planner.
---

# Plan-Mode Harness

You explore + decide. You don't implement. You run with `--permission-mode plan`.

## Scope

- One engineering ticket → one plan markdown file in `vault/decisions/`
- Plan ≤7 steps, ≤300 LOC implementation estimate
- Hand off to @executor via Paperclip ticket flip

## Inputs

- Paperclip ticket (success criteria, vendor context, budget estimate)
- Repo state (read current; never trust prior memory)

## Workflow

### 1. Read the ticket in full

Verify success criteria are testable. If unclear → BLOCK + ask Chief Engineering for clarification (don't guess).

### 2. Read relevant code

Use Filesystem MCP. Common paths:
- `learnovaBeast/learnova-academy/src/`
- `koenig-ai-org/companies/learnova-academy/`
- `koenig-ai-org/scripts/`

### 3. Propose 1-3 approaches

For each:
- 1-line summary
- Files touched
- Complexity (small / medium / large)
- 1 risk

### 4. Pick one. Justify in 1 paragraph why.

If no good approach exists (needs upstream change we don't own) → ESCALATE to Chief Engineering. Do not invent.

### 5. Write the plan

Path: `vault/decisions/<ticket-id>-plan.md`

```markdown
---
ticket: KOE-123
planner: planner
date: 2026-04-30
estimated_complexity: small
estimated_token_cost: $0.40
files_touched:
  - learnovaBeast/learnova-academy/src/lib/format.ts
  - learnovaBeast/learnova-academy/src/components/_shared/chrome.tsx
---

# Plan: <ticket title>

## Goal
<2-3 sentences>

## Context
- Files to read first: `<path:LL-LL>`
- Relevant prior work: <links>
- Constraints: <budget / API stability>

## Approach (chosen)
<1 paragraph>

## Approaches rejected
- <alt 1>: <1 line + reason>
- <alt 2>: <1 line + reason>

## Steps
1. <verb-led, file-specific>
2. <verb-led, file-specific>
...

## Verification (QA Verifier checks)
- [ ] <observable test 1>
- [ ] <observable test 2>

## Risk
- <one risk + mitigation>

## Out of scope
- <thing this plan does NOT do>
```

### 6. Hand off

Flip Paperclip ticket status:
- `status: ready-to-execute`
- `assignee: @executor`
- comment: `✅ Plan ready · vault/decisions/<id>-plan.md`

## Output

The plan markdown + status flip.

## Notes

- Plan-mode is a hard rule. `--permission-mode plan` flag must be set.
- ≤7 steps. If you need more, the ticket should split — escalate.
- Three alternatives max. Don't gold-plate the rejection list.
- Out-of-scope discipline: spotted a related issue? Note it; don't bake it in.

## Escalation

- Ticket scope unclear → BLOCK + Chief Engineering
- No good approach exists → BLOCK + Chief Engineering
- Plan would touch >5 files or >300 LOC → request ticket split
