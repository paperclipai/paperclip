---
schema: agentcompanies/v1
kind: team
slug: engineering
name: Engineering
description: Anthropic-style 3-agent harness (Planner → Generator → Evaluator) for shipping frontend + backend changes to the Academy product. Plan-mode planning, separate-agent code review, browser+test QA verification.
manager: ../../agents/chief-engineering/AGENTS.md
includes:
  - ../../agents/planner/AGENTS.md
  - ../../agents/executor/AGENTS.md
  - ../../agents/code-reviewer/AGENTS.md
  - ../../agents/qa-verifier/AGENTS.md
tags:
  - team
  - engineering
  - harness
---

# Engineering team

Implements the **Anthropic April 2026 Harness Engineering pattern** (Planner → Generator → Evaluator with structured handoffs). Cited performance: 4-hour harness produces functional app vs 20-min single-agent producing broken code. We adopt this exactly.

## Workflow

```
CEO ticket: "Bug X" or "Feature Y" or "UI tweak Z"
  ↓
Chief Engineering — assigns to one of the workers based on task shape
  ↓
planner-executor (Opus 4.7, Claude Code in plan mode)
  → reads codebase via worktree
  → writes structured plan to vault/decisions/<task-id>-plan.md
  → exits plan mode
  ↓
code-reviewer (Codex/GPT-5, reviewer prompt)
  → reviews plan: "is this complete? right files? side effects? test coverage?"
  → ✅ or ✏️ with line-level feedback
  ↓
[on ✏️: planner-executor revises plan]
[on ✅: planner-executor exits plan mode and IMPLEMENTS the plan]
  → opens draft PR in learnovaBeast on academy/redesign-v1 branch
  ↓
code-reviewer (G_code)
  → reviews actual diff: correctness, style, security, tests
  → demands evidence (test output, screenshot)
  ↓
[on ✏️: planner-executor revises]
[on ✅]
  ↓
qa-verifier (Haiku 4.5 + browser-use)
  → runs full test suite
  → walks the UI in headed Chrome
  → cross-checks any content changes vs research sources
  → G2 verdict
  ↓
Chief Engineering green-lights → CEO G3 → Vardaan G4 → merge PR
```

## Why three agents, not one

A single agent that plans + codes + reviews itself produces drift. Anthropic's harness benchmarks show: separate Planner + Generator + Evaluator with structured handoffs gives 4× the success rate. The Reviewer's "different lens" is the highest-leverage gate.

## Worktree isolation

Each engineering agent works in its own git worktree:
- `~/Documents/Paperclip/learnovaBeast-fe-agent/` (port 3001 if running dev server)
- `~/Documents/Paperclip/learnovaBeast-be-agent/` (port 3002)
- `~/Documents/Paperclip/learnovaBeast-qa-agent/` (port 3003 — for browser-use)

Created via `git worktree add`. Locks via `.claude/agent-lock` per worktree to prevent two agents claiming the same ticket.

## Two agents — Planner and Executor

**Planner** and **Executor** run the same model (Opus 4.7), with the same prompt+tools+context, but are **two separate Paperclip agents** so the audit trail is crystal-clear: Planner-only log entries during planning, Executor-only entries during implementation. Configured in `.paperclip.yaml`:
- Planner: `claude_local` + `extraArgs: ["--permission-mode", "plan"]`
- Executor: `claude_local` (no plan-mode flag)

Handoff is via the plan file at `vault/decisions/<task-id>-plan.md` — Executor reads it as input. No mid-session runtime toggle, no fragility.

## Out-of-bounds for V1

- Cursor Background Agents (no subscription)
- Kilo Code (V2 — community Paperclip adapter exists but we don't need a 3rd engineer yet)
- Direct merges to `main` (always go through `academy/redesign-v1` → review → merge)
- Touching non-academy portals (`learnova-student/sales/admin/tc`) without explicit ticket
