---
schema: agentcompanies/v1
kind: skill
name: sprint-protocol
description: >
  The foundational sprint protocol for Sprint Co. Covers how agents read sprint context,
  write handoff artifacts, manage the 3-hour clock, and track velocity.
  All Sprint Co agents should have this skill.
---

# Sprint Protocol

## Overview

Sprint Co operates on a strict 3-hour budget. Every agent must know:
1. How to find and read their current context
2. How to write handoff artifacts (structured state for the next agent)
3. How to report velocity and blockers
4. How to manage time discipline

---

## 1. Reading Sprint Context

At the start of every session, read context in this order:

```
1. sprint-plan.md          — the product spec and backlog
2. task-breakdown.md       — engineering tasks with acceptance criteria
3. handoff-[last].md       — what the previous agent produced
4. sprint-log.md           — current sprint status and elapsed time
```

If any of these files doesn't exist yet, that's the previous phase's job. Check with Sprint Orchestrator.

**Finding files:**
- Sprint artifacts are written to the sprint workspace: `./sprints/[sprint-id]/`
- Shared skills reference: `./skills/[skill-name]/SKILL.md`

---

## 2. Writing Handoff Artifacts

Every phase transition MUST produce a handoff artifact. This is the single source of truth for the next agent. **Context resets happen between sessions — the handoff artifact IS the memory.**

### Universal Handoff Format

```markdown
# [Artifact Type] — Sprint [ID]
**Phase**: [which phase produced this]
**Agent**: [your slug]
**Timestamp**: [ISO timestamp]
**Sprint Elapsed**: [HH:MM] of 3:00:00

---

## Status
[READY | BLOCKED | FAILED | PARTIAL]

## Summary
[2–4 sentences: what was done, what state things are in]

## Outputs
- `[filename]` — [what it contains]
- `[URL]` — [what it is]

## Context for Next Agent
[Specific things the next agent needs to know that aren't obvious from the files]

## How to Continue
[Exact steps to pick up where this left off]

## Known Issues / Risks
- [honest, specific issues]

## Time Remaining
[HH:MM] remaining in 3-hour sprint window

## Next Agent
**Who**: [agent slug]
**First Action**: [exact first thing they should do]
```

### BLOCKED Handoffs
If you're handing off in a BLOCKED state:
```markdown
## Blocker
**Type**: [technical | dependency | unclear requirements]
**Description**: [specific description of what's blocking]
**Already Tried**: [what you attempted]
**Recommendation**: [your suggestion to resolve]
**Escalate To**: Sprint Orchestrator
```

---

## 3. Sprint Clock Management

### Time Tracking
The sprint clock starts when Sprint Orchestrator receives the brief. Each agent's time budget:

| Phase | Budget | Start Trigger |
|-------|--------|---------------|
| Planning | 20 min | Brief received |
| Architecture | 20 min | sprint-plan.md ready |
| Implementation | 100 min | task-breakdown.md ready |
| QA | 25 min | Feature handoffs ready |
| Deployment | 15 min | QA PASS |

### Time Discipline Rules

**If you're over budget:**
1. Finish what you're doing if it's <5 minutes from done
2. Drop it if it's more than 5 minutes from done
3. Produce a partial handoff artifact immediately
4. Signal Sprint Orchestrator with how far over budget you are

**The 10-Minute Rule:**
If you've been stuck on the same thing for 10 minutes with no progress, STOP. Write down what you tried. Escalate to Sprint Lead or Orchestrator.

**The 80% Rule:**
A working feature at 80% quality shipped on time beats a perfect feature shipped after the 3-hour window. Sprint Co ships on time.

---

## 4. Sprint Log Format

Sprint Orchestrator maintains the `sprint-log.md`. All agents can read it; only Orchestrator writes it.

```markdown
# Sprint Log — Sprint [ID]

## Sprint Info
- **Brief**: [original brief]
- **Started**: [ISO timestamp]
- **Deadline**: [ISO timestamp — 3 hours from start]

## Timeline

| Time | Event | Agent | Status |
|------|-------|-------|--------|
| 0:00 | Sprint started | Orchestrator | ✅ |
| 0:03 | Brief sent to Planner | Orchestrator | ✅ |
| 0:18 | sprint-plan.md delivered | Planner | ✅ |
| ... | ... | ... | ... |

## Current Status
**Phase**: [current phase]
**Active Agent**: [who's working]
**Elapsed**: [HH:MM]
**Remaining**: [HH:MM]
**Risk Level**: [GREEN / YELLOW / RED]

## Blockers
[none / list of active blockers]
```

---

## 5. Velocity Tracking

Sprint velocity = features completed / features planned (V1 only).

Target velocity checkpoints:
- T+1:00: 30% of V1 features done
- T+1:40: 60% of V1 features done
- T+2:00: 80% of V1 features done

If velocity falls below target at any checkpoint, Sprint Lead must immediately:
1. Identify which V1 features are NOT yet started
2. Scope them down (simpler version that's faster to build)
3. Or drop them and convert to V2 (with Orchestrator approval)

---

## 6. Context Reset Protocol

When a session gets long (>80k tokens) or between major phases:

1. **Generate the handoff artifact** (above format, comprehensive)
2. **Confirm the next agent has the artifact path**
3. **Start a fresh session**
4. **First action in new session**: Read the handoff artifact and the last 3 sprint artifacts

This is not failure — this is the protocol. Structured artifacts carry state better than long conversation history.

---

## 7. Paperclip Coordination Protocol

When running under Paperclip heartbeat, every phase transition must both write the disk artifact AND coordinate via the Paperclip API. This section defines the mechanical operations required.

### Role Slugs

Every agent in Sprint Co maps to a Paperclip agent slug:

| Agent | Slug |
|-------|------|
| Sprint Orchestrator | `sprint-orchestrator` |
| Sprint Lead | `sprint-lead` |
| Product Planner | `product-planner` |
| Engineer Alpha | `engineer-alpha` |
| Engineer Beta | `engineer-beta` |
| QA Engineer | `qa-engineer` |
| Delivery Engineer | `delivery-engineer` |

### Signal Definitions

**"Signal [role]" means:** Post a comment on the current sprint's Paperclip task (`$PAPERCLIP_TASK_ID`), @-mention the target agent slug, and optionally update the task status. The exact operation is:

```
POST /api/issues/{issueId}/comments
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "body": "@[role-slug] [message describing handoff]"
}
```

And optionally:
```
PATCH /api/issues/{issueId}
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "assigneeAgentId": "[resolved target agent ID]",
  "status": "[todo | blocked | done]"
}
```

### Signal Types

**Signal QA** (Feature complete → QA testing)
- Trigger: Feature handoff artifact ready
- Operation:
  1. POST comment: "@qa-engineer Feature ready for evaluation at ./sprints/[sprint-id]/handoff-[agent].md"
  2. PATCH task: `assigneeAgentId` = qa-engineer's agent ID, `status` = `todo`

**Signal Delivery Engineer** (QA PASS → Deployment)
- Trigger: QA passes feature
- Operation:
  1. POST comment: "@delivery-engineer Ready to deploy. QA passed. See ./sprints/[sprint-id]/eval-[TASK-ID].md"
  2. PATCH task: `assigneeAgentId` = delivery-engineer's agent ID, `status` = `todo`

**Signal Engineer [Alpha/Beta]** (Rework requested)
- Trigger: QA failed feature or delivery blocker
- Operation:
  1. POST comment: "@engineer-alpha Failed: [specific issues]. Rework needed."
  2. PATCH task: `assigneeAgentId` = [engineer agent ID], `status` = `todo`

**Signal Sprint Lead** (Escalation)
- Trigger: Blocker cannot be resolved by current agent
- Operation:
  1. POST comment: "@sprint-lead Escalation needed: [blocker description]. Already tried: [attempts]"
  2. PATCH task: `status` = `blocked` (NO reassign to lead)

**Signal Sprint Orchestrator** (Over-budget or critical blocker)
- Trigger: Agent over time budget or critical infrastructure failure
- Operation:
  1. POST comment: "@sprint-orchestrator Over budget by [X] min. Current status: [summary]"
  2. PATCH task: `status` = `blocked` (NO reassign)

### Status Values

The Paperclip task representing the sprint uses these status values:

- **`todo`**: Sprint is in progress, waiting for current agent to finish
- **`in_progress`**: Sprint task is currently being worked on by the active agent
- **`blocked`**: A blocker has been encountered; requires escalation or decision-making
- **`done`**: Sprint completed and deployed

### Required Headers

All Paperclip API calls MUST include the `X-Paperclip-Run-Id` header:
```
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
```

This header ties all operations within a single sprint execution to one audit trail.

### Environment Variables

These variables are injected by Paperclip at runtime:

- `PAPERCLIP_TASK_ID` — ID of the sprint task (e.g., "issue-12345")
- `PAPERCLIP_RUN_ID` — Unique ID for this sprint execution
- `PAPERCLIP_API_URL` — Base URL for Paperclip API (e.g., "https://api.paperclip.ai")
- `PAPERCLIP_API_KEY` — Authentication token for API calls

### Handoff Artifact Update (for Section 2)

When writing handoff artifacts under Paperclip, add a **Paperclip Signal** section:

```markdown
## Paperclip Signal

**Signal Type**: [QA | Delivery | Engineer | Lead | Orchestrator]
**Target Role**: [role-slug]
**Message**: [message for comment]
**Reassign?**: [yes with role-slug | no]
```

This metadata ensures the next phase knows exactly what signal the previous agent intended to send.
