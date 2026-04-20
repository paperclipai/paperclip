# 3-Agent Swarm Pattern

Reference guide for the Architect/Planner/Implementer/Verifier swarm pattern used in Paperclip agentic engineering.

---

## Overview

A **swarm** is a small set of agents collaborating on a single feature or task, each with a distinct role and a limited view of context. The goal is separation of concerns: the agent who understands the problem is not the same as the agent who writes the code, and neither is the same as the agent who checks the output.

The default composition is four roles across three agents:

```
Architect ──► Planner ──► Implementer(s) ──► Verifier
```

Each role hands off to the next via Paperclip issues. The platform enforces single-assignee checkout, so only one agent works a task at a time — but multiple agents can work parallel sub-tasks simultaneously.

---

## Role Definitions

### Architect

The Architect owns the **problem definition**. Their job is to transform a vague goal or feature request into a concrete, bounded scope that can be planned and built.

**Responsibilities:**

- Decompose a goal into well-scoped sub-problems
- Define acceptance criteria and constraints
- Identify cross-team dependencies and escalation points
- Decide the execution strategy (single task vs. parallel sub-tasks vs. phased delivery)

**What they should NOT do:**

- Write or review implementation code
- Make low-level technical design decisions
- Assign specific subtasks (that is the Planner's job)

**Typical output:** An issue (or set of issues) with clear `description`, `Done Criteria`, and `Boundaries` sections.

---

### Planner

The Planner owns the **execution plan**. They receive a well-scoped problem from the Architect and break it into implementable steps.

**Responsibilities:**

- Create a `plan` document on the issue (see `PUT /api/issues/{issueId}/documents/plan`)
- Enumerate sub-tasks with explicit handoff points
- Estimate risk areas and flag blockers before implementation begins
- Set priority and assign subtasks to Implementer agents
- Get plan approved by manager/Architect before Implementers start

**What they should NOT do:**

- Write implementation code themselves
- Skip plan approval for medium/high/critical priority tasks
- Create tasks without `parentId` and `goalId`

**Typical output:** A `plan` document, a set of child issues assigned to Implementers, status set to `blocked` pending plan review.

---

### Implementer

The Implementer owns **execution**. They receive a scoped, planned task and deliver the working implementation.

**Responsibilities:**

- Check out the task (`POST /api/issues/{issueId}/checkout`)
- Work within the boundaries defined by Architect and Planner
- Run verification checks before marking complete (`pnpm test:run`, `pnpm -r typecheck`, `pnpm build`)
- Set status to `in_review` — never `done` — when finished
- Leave a verification comment explaining what was done and how to check it

**What they should NOT do:**

- Expand scope beyond task boundaries
- Mark tasks `done` without Verifier sign-off
- Create sibling or parent tasks (escalate to manager instead)

**Typical output:** Working implementation, status `in_review`, comment with verification steps.

---

### Verifier

The Verifier owns the **quality gate**. They validate that the Implementer's output satisfies the done criteria before the task closes.

**Responsibilities:**

- Read the issue description, plan document, and `in_review` comment
- Run all appropriate checks (tests, linter, manual review)
- Mark `done` on pass; apply Fix Forward on fail (see `skills/paperclip/references/verifier-workflow.md`)
- Never re-assign or reopen the original task

**What they should NOT do:**

- Skip verification and rubber-stamp `done`
- Modify the implementation themselves (create a fix subtask instead)
- Block on minor style issues — focus on done criteria

**Who plays this role:** By default, the assigning manager. A dedicated QA agent may be designated explicitly.

---

## When to Use Each Role

| Situation                                    | Apply this role                                     |
| -------------------------------------------- | --------------------------------------------------- |
| New feature request arrives with vague scope | Architect — define the problem first                |
| Scoped problem needs a delivery plan         | Planner — create plan document, break into subtasks |
| Plan is approved, implementation can start   | Implementer — execute the subtasks                  |
| Subtask is marked `in_review`                | Verifier — run checks, pass or Fix Forward          |
| Unexpected blocker during implementation     | Implementer blocks → Planner/Architect unblocks     |
| Scope expands beyond original issue          | Escalate to Architect — do not silently expand      |

**Use the full 4-role flow when:**

- Priority is `medium`, `high`, or `critical`
- The feature touches multiple layers (db/shared/server/ui)
- More than one Implementer agent needs to work in parallel
- The team is new and role clarity reduces coordination overhead

**Simplify to a single agent when:**

- Priority is `low` and scope is clearly defined
- The change is a single-file documentation or config edit
- The Implementer can self-verify (trivial task, no code path risk)

---

## Context Isolation Guidelines

Each role should receive only the context it needs to do its job. Over-sharing context increases noise and can cause agents to drift outside their scope.

### What each role should see

| Context                           | Architect    | Planner      | Implementer    | Verifier            |
| --------------------------------- | ------------ | ------------ | -------------- | ------------------- |
| Goal / product spec               | ✓            | Summary only | No             | No                  |
| Issue description & done criteria | ✓            | ✓            | ✓              | ✓                   |
| Plan document                     | ✓ (authored) | ✓ (authored) | ✓              | ✓                   |
| Prior comment thread              | ✓            | Recent only  | Relevant only  | `in_review` comment |
| Full codebase                     | No           | No           | Relevant areas | Relevant areas      |
| Test output                       | No           | No           | ✓              | ✓                   |
| Sibling / parent issue details    | ✓            | Summary      | No             | No                  |

### Isolation rules

1. **Implementers do not need product context.** Pass done criteria and boundaries — not the original feature rationale. This keeps implementation focused.

2. **Planners do not need implementation details.** They design the sequence; they do not need to read every file that will be changed.

3. **Verifiers read the plan and the `in_review` comment — not the full comment history.** The `in_review` comment should contain everything needed to run verification.

4. **Never paste full file contents into issue descriptions.** Reference file paths; agents can read files themselves during checkout.

5. **Keep plan documents current.** The plan document is the shared source of truth across all roles — update it when scope changes, not the comment thread.

---

## Example Task Flow

The following shows a complete handoff sequence for a medium-priority feature.

### Scenario

> "Add rate limiting to the agent heartbeat endpoint."

---

**Step 1 — Architect scopes the problem**

Architect creates issue `PAP-850`:

```
Title: Rate-limit the heartbeat endpoint to prevent abuse
Description:
  ## Problem
  Agent heartbeat runs can be triggered externally, creating DoS risk.

  ## Boundaries
  - Only modify heartbeat endpoint and middleware
  - Do not change heartbeat logic or run semantics

  ## Done Criteria
  - Heartbeat endpoint returns 429 after N requests/minute per agent
  - Rate limit config is env-var driven
  - Existing heartbeat tests still pass
  - New test covers rate-limit rejection
```

Architect assigns to Planner.

---

**Step 2 — Planner creates the plan**

Planner checks out `PAP-850`, creates plan document:

```
PUT /api/issues/PAP-850/documents/plan

# Plan

## Approach
Use express-rate-limit middleware scoped to agentId header.

## Steps
1. Add `express-rate-limit` to server/package.json
2. Create middleware at server/src/middleware/rateLimiter.ts
3. Apply middleware to POST /api/issues/:id/run (heartbeat route)
4. Add env var HEARTBEAT_RATE_LIMIT_RPM (default: 60)
5. Write test: heartbeat returns 429 on N+1 request

## Subtasks
- PAP-851: Implement rate limiter middleware
- PAP-852: Write rate-limit integration test
```

Planner creates child issues `PAP-851` and `PAP-852`, sets `PAP-850` to `blocked` pending plan review, comments:

```
Plan ready: /PAP/issues/PAP-850#document-plan
Blocked on plan approval before implementation begins.
```

---

**Step 3 — Plan approval**

Manager reviews and approves via comment. Planner's next heartbeat unblocks `PAP-850`, sets subtasks to `todo`, assigns to Implementer agents.

---

**Step 4 — Implementation**

Implementer A checks out `PAP-851`, writes the middleware, runs:

```sh
pnpm test:run && pnpm -r typecheck
```

Sets status to `in_review`:

```
Implementation complete.
- Added server/src/middleware/rateLimiter.ts
- Applied to heartbeat route in server/src/routes/issues.ts
- HEARTBEAT_RATE_LIMIT_RPM env var documented in .env.example
- Tests pass: pnpm test:run ✓
```

Implementer B (or same agent) checks out `PAP-852`, writes the test, marks `in_review` similarly.

---

**Step 5 — Verification**

Verifier (assigning manager or QA agent) wakes on `in_review` trigger:

1. Reads issue, plan, and `in_review` comments.
2. Runs: `pnpm test:run && pnpm -r typecheck && pnpm build`
3. Confirms rate-limit test is present and passes.
4. **Pass:** `PATCH status: done` on both subtasks.
5. Once subtasks are done, marks parent `PAP-850` done.

---

**If verification fails (Fix Forward):**

Verifier creates `PAP-853`:

```
Title: Fix: rate-limit test missing agentId scope assertion
Description:
  Verification of PAP-851 failed.

  Failures:
  - Test does not assert 429 is returned per-agent (global limit only)

  Done Criteria:
  - Test verifies two different agents each get their own rate limit bucket
```

Assigns to original Implementer. `PAP-851` stays `in_review`.

---

## Related References

- Verifier workflow and Fix Forward details: `skills/paperclip/references/verifier-workflow.md`
- Paperclip API quick reference: `skills/paperclip/references/api-reference.md`
- Plan-before-code gate: see Step 7 of the heartbeat procedure in the Paperclip skill
