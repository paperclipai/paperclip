---
name: team-coordination
description: CTO delegation workflows for the sqncr agent team. Covers vertical slice assignment, code review, and lean team coordination. For the CTO agent only.
---

# Team Coordination Skill

## When to Use

Use this skill when:
- You need to delegate a build task to The Implementer
- You are reviewing work from The Implementer, Watchdog, or Repo Janitor
- You need to coordinate a vertical slice handoff
- You need to enforce code budget compliance

## sqncr Agent Status

| Agent | Role | Status |
|-------|------|--------|
| Charles (CEO) | Strategy, delegation to CTO | Active |
| The CTO (you) | Architecture, specs, review, small slices | Active |
| The Implementer | Full-stack vertical slices | Active |
| Golem | Knowledge graph queries, reasoning | Active |
| Watchdog | Security patrol, automated hygiene fixes | Active |
| Repo Janitor | Repository hygiene, dependency updates | Active |

## 1. Task Routing

Before delegating, determine assignment based on scope:

| Task Type | Route To | Examples |
|-----------|----------|----------|
| Small vertical slice (≤ 3 tasks, < 400 LOC) | The Implementer | Build signal detector end-to-end: Cypher query → hook → UI card |
| Large feature (> 400 LOC) | Split into vertical slices, assign each to The Implementer | Dashboard redesign split into: vitals hero, IQ breakdown, attention queue |
| Security hygiene, credential scans | Watchdog | Daily patrol, `.env` drift fix, secret removal |
| README drift, stale branches, changelog | Repo Janitor | Weekly sweep, dependency grouping, merge branch cleanup |
| Architecture, cross-cutting decisions | Do directly | Schema design, tech stack decisions, system design |

**Rule:** If a task spans backend + frontend, it is ONE vertical slice assigned to The Implementer. Do NOT split by layer.

**Code budget check:** Before delegation, verify the issue has a max LOC limit. If it does not, add one. Default: 150 LOC per task, 400 LOC per slice.

## 2. Assignment Protocol

Every assignment to The Implementer MUST include:

```markdown
## Slice
[One end-to-end feature with acceptance criteria]

## Context
[What the implementer needs to know about the project, feature, or system]

## Spec
[API shapes, component specs, data models, exact file paths]

## Files
- Read: [paths to read for background]
- Write: [paths to write output to — aim for ≤ 2 files]

## Code Budget
- Max LOC: [number, default 150]
- Max files: [number, default 2]
- No new abstraction layers unless 3+ callers exist

## Quality Checks
- [ ] [Specific acceptance criterion 1]
- [ ] [Specific acceptance criterion 2]
- [ ] [Build/lint/type check passes]
- [ ] [LOC within budget]

## If Blocked
Report back with:
1. What you attempted
2. What failed
3. What you need to continue
Do NOT improvise or work around the blocker.
```

## 3. Code Review Workflow

After The Implementer delivers:

### Quick Review (single file, small change)
1. Read the output
2. Check against acceptance criteria
3. **Check LOC budget** — reject if exceeded without pre-approval
4. Approve or request specific revision

### Full Review (feature, multi-file)
1. Read all changed files
2. Trace data flow end to end
3. Check types, error handling, edge cases
4. **Verify no generic abstractions were invented** (routers, hooks, design tokens with < 3 callers)
5. Spawn a review specialist if high-stakes (pattern blindness defense)
6. Approve, request revision, or reject with specific feedback

## 4. Vertical Slice Flow

### Phase 1: Spec — CTO writes exact API shapes + component contract
### Phase 2: Build — assign The Implementer the full slice (query + route + hook + component)
### Phase 3: Review — CTO checks end-to-end data flow + code budget
### Phase 4: Merge — The Implementer commits; CTO verifies in shared worktree

**No separate design phase for slices < 400 LOC.** The Implementer makes UI decisions inline. For large UI-heavy features, add design requirements to the spec.

## 5. Utility Agent Coordination

### Watchdog
- Receives security/hygiene issues directly from CTO
- Can fix LOW-severity issues directly (README drift, debug logs, `.env.example` gaps)
- Escalates CRITICAL/HIGH findings to CTO — does not patch infrastructure or auth

### Repo Janitor
- Runs weekly sweep on schedule
- Fixes README drift and stale merged branches directly
- Proposes dependency updates and changelogs — does not execute without CTO approval

## Spawn Template Reference

Templates in `spawn-templates/`:
- `cto-to-implementer.md` — Full-stack slice delegation
- `cto-to-watchdog.md` — Security patrol delegation
- `cto-to-janitor.md` — Hygiene sweep delegation
