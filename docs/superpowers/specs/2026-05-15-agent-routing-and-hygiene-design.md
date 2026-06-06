# Agent Routing, Concurrency & Repo Hygiene Design

**Date:** 2026-05-15  
**Status:** Approved — ready for implementation  
**Scope:** MV Automation company (id: `a93b263d-5f67-480b-aba7-9359a431b98e`)

## Problem

Manager agents (CEO, ProjectManager, CTO) end up writing code instead of delegating to the right specialist. Root causes identified:

1. CEO routing table only goes to CTO level — adds a hop where code gets done instead of delegated further
2. CTO has a "unless no engineer is available and the change is trivial" escape hatch that enables coding
3. PM has no routing table, only a bottom-of-file out-of-scope list
4. 5 of 13 IC agents have no instructions file at all
5. Two nearly-identical frontend engineers (SeniorFrontendDeveloper, SeniorFrontendEngineer) create routing ambiguity — SeniorFrontendEngineer has no instructions
6. 10 agents have timer heartbeats with only a 10-second cooldown and no `intervalSec`, risking constant concurrent Claude API calls
7. No worktree discipline — agents risk branch conflicts when working in parallel
8. No PR queue gate — backlog of open PRs can grow unbounded

## Solution: Approach B

Fix manager instructions + fill IC gaps + resolve duplicates + add concurrency and repo hygiene controls.

---

## Section 1: Canonical Routing Table

Single source of truth embedded in CEO, PM, and CTO instructions. No overlaps.

| Task type | Primary owner | Escalate to if blocked |
|-----------|--------------|----------------------|
| Vue 3 / TypeScript frontend UI, components, Pinia, Storybook | SeniorFrontendDeveloper | CTO |
| Python backend, FastAPI, Redis, ChromaDB, async pipelines | BackendEngineer | CTO |
| CI/CD, Docker, Ansible, infra-as-code, observability, secrets | DevOpsEngineer | CTO |
| Auth, security audits, vulnerability remediations, threat modelling | SecurityEngineer | CTO |
| UX, wireframes, design system, interaction design | UXDesigner | CEO |
| PR review, code quality, merge discipline | CodeReviewer → SeniorCodeArchitect (architecture) | CTO |
| Architecture decisions, ADRs, cross-stack technical direction | CTO | CEO |
| Brand, content, growth, social, devrel | CMO | CEO |
| Issue hygiene, delivery cadence, scoping vague requests | ProjectManager | CEO |
| Strategy, hiring, board comms, cross-team conflict | CEO | — |

**Key decisions:**
- SeniorFrontendEngineer is retired (no instructions, exact duplicate of SeniorFrontendDeveloper)
- CTO is architecture-only — the "unless trivial" coding escape hatch is removed entirely
- CEO and PM carry identical routing tables so there is no divergence between them

---

## Section 2: Concurrency & Rate Limit Controls

### Heartbeat Tiers

| Tier | Agents | Config change |
|------|--------|--------------|
| Scheduled — 5 min | CEO, ProjectManager | `intervalSec: 300`, `maxConcurrentRuns: 1` |
| Periodic check — 10 min | CodeReviewer | `intervalSec: 600`, `maxConcurrentRuns: 1` |
| Wake-on-demand only | CTO, BackendEngineer, SeniorFrontendDeveloper, DevOpsEngineer, SecurityEngineer, SeniorCodeArchitect, UXDesigner, CMO, FoundingEngineer | `enabled: false`, `wakeOnDemand: true`, `maxConcurrentRuns: 1` |

`maxConcurrentRuns` drops from 5 → 1 for all agents.

### Standard Model Efficiency Block (all agents)

```markdown
## Model Efficiency

Use **cheap** model profile for:
- Posting status update comments
- Reading and summarising issue context
- Board hygiene checks (scanning issue lists, checking staleness)
- Routing decisions (deciding who to delegate to)
- Writing issue descriptions for tasks you are creating

Use **main** model (default) for:
- Writing, reviewing, or debugging code
- Architecture decisions and ADRs
- Security analysis
- UX or design critique
- Any reasoning where a mistake is costly to reverse

When in doubt: if the output is a comment or a routing action, use cheap. If the output is a deliverable, use main.
```

### Standard Budget Guardrails Block (all agents)

```markdown
## Budget Guardrails

- **>80% company budget used** → pause non-critical work, post a summary comment to your manager, and wait for direction
- **>90% company budget used** → stop all work except unblocking critical blockers; notify CEO immediately with a list of what was paused
```

---

## Section 3: Repo Hygiene Rules

### Rule 1 — Always work in a worktree (IC coding agents)

IC agents (BackendEngineer, SeniorFrontendDeveloper, DevOpsEngineer, SecurityEngineer, FoundingEngineer, SeniorCodeArchitect) must never switch branches on the primary checkout. Standard block added to each:

```markdown
## Worktree Discipline (non-negotiable)

Never work on the primary checkout. Before touching any code:
1. Create a worktree: `pnpm paperclipai worktree:make <issue-id> --start-point origin/Dev_new_gui`
2. Do all work inside that worktree
3. Never run `git checkout` on the primary repo

A checkout that touches the primary working tree is a bug.
```

### Rule 2 — Clean up after merge (IC agents + CodeReviewer)

```markdown
## Cleanup After Merge (required)

After your PR is merged:
1. Delete the remote branch: `gh pr view <number> --json headRefName -q .headRefName | xargs -I{} git push origin --delete {}`
2. Remove the local worktree: `pnpm paperclipai worktree:cleanup <worktree-name>`

A merged branch that still exists is a bug. A worktree that outlives its PR is a bug.
```

### Rule 3 — PR queue gate: max 5 open PRs (IC agents)

```markdown
## PR Queue Gate (hard limit)

Before opening a PR, always check:
  `gh pr list --state open --json number | python3 -c "import json,sys; prs=json.load(sys.stdin); print(len(prs))"`

If the count is **5 or more**:
- Do NOT create a PR
- Post a comment: "Work complete on branch `<branch>` — PR creation blocked, 5 PRs already await review. Notifying CodeReviewer."
- @-mention CodeReviewer to clear the backlog
- Set your issue to `in_review` with `blockedByIssueIds` pointing to the oldest open PR's linked issue
```

### Rule 4 — CodeReviewer enforces cleanup on every merge

```markdown
## On Every Merge

After merging a PR:
1. Delete the head branch: `gh pr merge <number> --delete-branch` (or delete separately if already merged)
2. Verify no orphaned worktrees: `pnpm paperclipai worktree:list`
3. If the PR queue drops below 5, post a comment on any blocked issues so they can proceed with PR creation
```

### PM — PR queue monitoring (board hygiene addition)

PM's periodic scan checks PR count. If ≥4 open PRs, PM flags to CodeReviewer before the gate triggers.

---

## Changes Required

### A. Instruction file edits

| Agent | File exists? | Change |
|-------|-------------|--------|
| CEO | ✅ | Add routing table with specific engineers; section 2+3 blocks |
| ProjectManager | ✅ | Add routing table as rule #1; section 2+3 blocks; PR queue monitoring |
| CTO | ✅ | Remove "unless trivial" loophole; section 2 blocks |
| SeniorFrontendDeveloper | ✅ | Add section 2+3 blocks (worktree, PR gate, cleanup, model efficiency) |
| UXDesigner | ✅ | Add section 2 blocks |
| FoundingEngineer | ✅ | Add section 2+3 blocks |
| CMO | ✅ | Add section 2 blocks |
| BackendEngineer | ❌ | Create AGENTS.md |
| DevOpsEngineer | ❌ | Create AGENTS.md |
| SecurityEngineer | ❌ | Create AGENTS.md |
| SeniorCodeArchitect | ❌ | Create AGENTS.md |
| CodeReviewer | ❌ | Create AGENTS.md |

### B. Heartbeat config changes (via API PATCH /api/agents/:id)

All agents: `maxConcurrentRuns: 1`  
CEO, PM: `intervalSec: 300`, `enabled: true`  
CodeReviewer: `intervalSec: 600`, `enabled: true`  
All others: `enabled: false`, `wakeOnDemand: true`

### C. Retire SeniorFrontendEngineer

PATCH agent status to `inactive` or remove. Update routing table references.

### D. Capabilities field updates

Update all agents' `capabilities` field to include explicit routing-signal keywords matching the routing table in Section 1.

---

## Acceptance Criteria

- CEO and PM never write or generate code in any heartbeat — they delegate to a named IC agent via a child issue
- CTO never directly edits files — delegates to BackendEngineer, SeniorFrontendDeveloper, DevOpsEngineer, or FoundingEngineer
- No two coding agents switch the same branch simultaneously
- After any PR merge, the head branch is deleted and the worktree is cleaned up within the same heartbeat
- No agent creates a PR when ≥5 are already open
- No agent fires more than once per minute (enforced by `intervalSec` and `maxConcurrentRuns: 1`)
