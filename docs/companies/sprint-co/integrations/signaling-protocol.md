# Sprint Co Signaling Protocol

**Document Type**: Integration Guide  
**Audience**: Developers implementing sprint-co agents  
**Last Updated**: 2026-03-31

## Overview

In Paperclip, "signaling" is the mechanism by which one agent wakes up another agent to hand off work. Unlike direct function calls, signals are mediated through Paperclip issues — they are auditable, budget-tracked, and conflict-safe.

This document maps every handoff in the Sprint Co workflow to its corresponding Paperclip API calls.

---

## What "Signaling" Means in Paperclip

When an agent finishes its phase and needs to wake the next agent, it doesn't directly invoke code. Instead:

1. **Write to Paperclip** — Update the issue with a comment or status change
2. **Paperclip wakes the next agent** — Via heartbeat trigger
3. **Next agent reads the issue** — Extracts context and continues work

The three signaling primitives are:

- **@-Mention** — `@AgentName in comment` wakes an agent without transferring ownership
- **Assignment** — `PATCH assigneeAgentId` transfers task ownership and triggers a heartbeat
- **Status Transition** — `PATCH status` signals state change; next agent polls and reacts

---

## Agent Slug Reference Table

To avoid conflicts, all references to agents must use the correct slug format:

| Agent Name | AGENTS.md Slug | Short Slug (API) | @-Mention Format | Role |
|---|---|---|---|---|
| Sprint Orchestrator | `sprint-orchestrator` | `orchestrator` | `@Sprint Orchestrator` | Creates sprint, routes work, closes sprint |
| Product Planner | `product-planner` | `planner` | `@Product Planner` | Writes sprint plan, estimates work |
| Sprint Lead | `sprint-lead` | `lead` | `@Sprint Lead` | Writes architecture, assigns features |
| Engineer Alpha | `engineer-alpha` | `alpha` | `@Engineer Alpha` | Implements features (parallel track 1) |
| Engineer Beta | `engineer-beta` | `beta` | `@Engineer Beta` | Implements features (parallel track 2) |
| QA Engineer | `qa-engineer` | `qa` | `@QA Engineer` | Evaluates features, gates deployment |
| Delivery Engineer | `delivery-engineer` | `delivery` | `@Delivery Engineer` | Deploys to production |

**Key Rules**:
- Use `Short Slug` (lowercase, no spaces) in all API calls: `assignedTo`, `assigneeAgentId`, query filters
- Use `@-Mention Format` (with spaces) in comments for human readability
- AGENTS.md maintains the canonical slug; Short Slug is the normalized form for API use

---

## The Ten Handoffs in Sprint Co

### Handoff 1: Sprint Orchestrator → Product Planner (Brief Ready)

**Trigger**: Jeremy sends a brief  
**API Sequence**:

```
Step 1: POST /api/companies/{companyId}/issues
{
  "title": "Sprint [ID]: [brief summary]",
  "description": "Brief: [Jeremy's brief text]",
  "status": "in_progress",
  "projectId": "[sprint-project-id]",
  "assigneeAgentId": "[orchestrator-id]"
}
Response: {id: "SPR-NNN", ...}

Step 2: POST /api/companies/{companyId}/issues
{
  "title": "[SPR-NNN] Planning: Write sprint-plan.md",
  "assigneeAgentId": "[product-planner-id]",
  "parentId": "SPR-NNN",
  "status": "todo"
}
Response: {id: "SPR-PPP"}

Step 3: POST /api/issues/SPR-NNN/comments
{
  "content": "@Product Planner Sprint brief received. Plan due in 20 minutes.\n\nBrief: [text]"
}
```

**Result**: Product Planner's heartbeat fires within 60 seconds

---

### Handoff 2: Product Planner → Sprint Orchestrator (Plan Ready)

**Trigger**: Product Planner finishes sprint-plan.md  
**API Sequence**:

```
Step 1: PUT /api/issues/SPR-PPP/documents/plan
{
  "content": "[entire sprint-plan.md content]",
  "baseRevisionId": "[current latestRevisionId]"
}

Step 2: PATCH /api/issues/SPR-PPP
{
  "status": "done",
  "comment": "sprint-plan.md complete. V1 estimate: [X] min of 100 available."
}

Step 3: POST /api/issues/SPR-NNN/comments
{
  "content": "@Sprint Orchestrator Sprint plan ready. Total V1 estimate: [X] min.\n\nPlan: /SPR-NNN/documents/plan"
}
```

**Result**: Orchestrator's heartbeat fires. Orchestrator reads plan, creates next phase.

---

### Handoff 3: Sprint Orchestrator → Sprint Lead (Architecture Task Ready)

**Trigger**: Orchestrator receives "plan ready" signal  
**API Sequence**:

```
Step 1: POST /api/companies/{companyId}/issues
{
  "title": "[SPR-NNN] Architecture: Write task-breakdown.md",
  "assigneeAgentId": "[sprint-lead-id]",
  "parentId": "SPR-NNN",
  "status": "todo"
}
Response: {id: "SPR-AAA"}

Step 2: POST /api/issues/SPR-NNN/comments
{
  "content": "@Sprint Lead Architecture phase starting. Task: write task-breakdown.md in 20 min.\n\nPlan: /SPR-NNN/documents/plan\nBudget: 100 min of implementation"
}
```

**Result**: Sprint Lead's heartbeat fires

---

### Handoff 4: Sprint Lead → Engineer Alpha + Engineer Beta (Features Ready)

**Trigger**: Sprint Lead finishes task-breakdown.md and creates feature subtasks  
**API Sequence**:

```
Step 1: PUT /api/issues/SPR-AAA/documents/task-breakdown
{
  "content": "[entire task-breakdown.md content]",
  "baseRevisionId": "[current]"
}

Step 2: PATCH /api/issues/SPR-AAA
{
  "status": "done",
  "comment": "task-breakdown.md complete. [N] V1 features, dependencies mapped."
}

Step 3: POST /api/companies/{companyId}/issues (first feature)
{
  "title": "[SPR-NNN] [TASK-001]: [Feature Name]",
  "assigneeAgentId": "[engineer-alpha-id]",
  "parentId": "SPR-NNN",
  "status": "todo"
}
Response: {id: "SPR-F001"}

Step 4: POST /api/companies/{companyId}/issues (second feature)
{
  "title": "[SPR-NNN] [TASK-002]: [Feature Name]",
  "assigneeAgentId": "[engineer-beta-id]",
  "parentId": "SPR-NNN",
  "status": "todo"
}
Response: {id: "SPR-F002"}

Step 5: POST /api/issues/SPR-NNN/comments
{
  "content": "@Engineer Alpha @Engineer Beta Features assigned. Alpha: [TASK-001], Beta: [TASK-002].\n\nBreakdown: /SPR-NNN/documents/task-breakdown"
}
```

**Result**: Both engineers' heartbeats fire simultaneously (parallel assignment)

---

### Handoff 5: Engineer Alpha → QA Engineer (Feature Ready)

**Trigger**: Engineer finishes feature and writes handoff artifact  
**API Sequence**:

```
Step 1: PUT /api/issues/SPR-F001/documents/handoff
{
  "content": "[entire handoff artifact]",
  "baseRevisionId": "[current]"
}

Step 2: PATCH /api/issues/SPR-F001
{
  "status": "done",
  "comment": "Feature complete. All self-eval checks passed. Ready for QA.\n\nHandoff: /SPR-F001/documents/handoff"
}

Step 3: POST /api/companies/{companyId}/issues
{
  "title": "[SPR-NNN] QA: Evaluate [TASK-001]",
  "assigneeAgentId": "[qa-engineer-id]",
  "parentId": "SPR-NNN",
  "status": "todo"
}
Response: {id: "SPR-Q001"}

Step 4: POST /api/issues/SPR-NNN/comments
{
  "content": "@QA Engineer [TASK-001] ready for evaluation. Handoff: /SPR-F001/documents/handoff"
}
```

**Result**: QA Engineer's heartbeat fires

---

### Handoff 6a: QA Engineer → Engineer Alpha (QA PASS)

**Trigger**: QA passes feature  
**API Sequence**:

```
Step 1: PUT /api/issues/SPR-F001/documents/eval-report
{
  "content": "[entire eval report, Result: PASS]",
  "baseRevisionId": "[current]"
}

Step 2: PATCH /api/issues/SPR-Q001
{
  "status": "done",
  "comment": "QA PASS. All 4 criteria passed. Feature ready for deployment.\n\nEval: /SPR-F001/documents/eval-report"
}

Step 3: POST /api/companies/{companyId}/issues
{
  "title": "[SPR-NNN] Deploy: [TASK-001]",
  "assigneeAgentId": "[delivery-engineer-id]",
  "parentId": "SPR-NNN",
  "status": "todo"
}
Response: {id: "SPR-D001"}

Step 4: POST /api/issues/SPR-NNN/comments
{
  "content": "@Delivery Engineer [TASK-001] passed QA. Ready to ship.\n\nEval: /SPR-F001/documents/eval-report"
}
```

**Result**: Delivery Engineer's heartbeat fires (if all features are PASS)

---

### Handoff 6b: QA Engineer → Engineer Alpha (QA FAIL)

**Trigger**: QA fails feature on first attempt  
**API Sequence**:

```
Step 1: PUT /api/issues/SPR-F001/documents/eval-report
{
  "content": "[entire eval report, Result: FAIL, Required Fixes: [...]]",
  "baseRevisionId": "[current]"
}

Step 2: PATCH /api/issues/SPR-F001
{
  "status": "in_progress",
  "assigneeAgentId": "[engineer-alpha-id]",
  "comment": "QA FAIL on [TASK-001]. Required fixes: [specific issues].\n\nEval: /SPR-F001/documents/eval-report"
}

Step 3: POST /api/issues/SPR-NNN/comments
{
  "content": "@Engineer Alpha [TASK-001] QA failed. Refine required.\n\nEval: /SPR-F001/documents/eval-report"
}
```

**Result**: Engineer Alpha's heartbeat fires. Engineer refines the feature.

---

### Handoff 6c: QA Engineer → Sprint Lead (QA FAIL × 2)

**Trigger**: Feature fails QA twice  
**API Sequence**:

```
Step 1: PUT /api/issues/SPR-F001/documents/eval-report
{
  "content": "[eval report, Result: FAIL x2, Escalation Required]",
  "baseRevisionId": "[current]"
}

Step 2: PATCH /api/issues/SPR-F001
{
  "status": "blocked",
  "comment": "QA FAIL × 2. [Feature] has failed twice. Escalating to Sprint Lead for decision."
}

Step 3: POST /api/issues/SPR-NNN/comments
{
  "content": "@Sprint Lead Feature [TASK-001] failed QA twice. Decision needed: drop, simplify, or continue refining?\n\nEval: /SPR-F001/documents/eval-report"
}
```

**Result**: Sprint Lead's heartbeat fires

---

### Handoff 6c Decision Loop: Sprint Lead Reviews Escalated Feature

**Trigger**: QA has failed a feature twice (Handoff 6c escalates to Lead)  
**Lead's Three Decision Paths**:

#### Path 1: Drop Feature (Mark as Dropped)

```
Step 1: PATCH /api/issues/SPR-F001
{
  "status": "done",
  "comment": "Feature dropped per sprint lead decision. Reason: [explanation]. Archive: /SPR-F001/documents/eval-report"
}

Step 2: Remove from deployment queue
→ Delivery Engineer will skip this feature when gathering passing features
```

**When to drop**: Risk is too high, or requirement is out of scope for this sprint.

#### Path 2: Simplify Scope (Modify Acceptance Criteria)

```
Step 1: POST /api/issues/SPR-F001/comments
{
  "content": "Scope reduced. New acceptance criteria:\n- [simplified criterion 1]\n- [simplified criterion 2]\n\nReason: [explanation]. Please re-implement and retest."
}

Step 2: PATCH /api/issues/SPR-F001
{
  "status": "todo",
  "assignedTo": "alpha"
}

Step 3: Optional - POST /api/issues/SPR-NNN/comments
{
  "content": "@Engineer Alpha [TASK-001] scope simplified. See /SPR-F001/documents/eval-report for QA feedback."
}
```

**When to simplify**: Feature is possible but current scope is too ambitious. Reducing MVP scope allows shipping.

#### Path 3: Allow Third Attempt (Reassign for Refinement)

```
Step 1: POST /api/issues/SPR-F001/comments
{
  "content": "Third attempt authorized. Critical notes:\n- Focus on: [specific fix needed]\n- Time remaining: [X minutes]\n- If this fails, feature will be dropped.\n\nEval feedback: /SPR-F001/documents/eval-report"
}

Step 2: PATCH /api/issues/SPR-F001
{
  "status": "todo",
  "assignedTo": "alpha",
  "metadata": {
    "failCount": 2,
    "finalAttempt": true
  }
}
```

**When to allow third attempt**: Engineer has a clear path to fix and time is available.

**Outcome** (after Lead's decision):
- **Dropped**: Issue marked done, removed from deployment
- **Simplified**: New criteria posted, engineer re-implements
- **Third Attempt**: Engineer refines, QA re-evaluates with understanding that failure = drop

---

### Handoff 7: Delivery Engineer → Sprint Orchestrator (Deployment Complete)

**Trigger**: All features deployed  
**API Sequence**:

```
Step 1: PUT /api/issues/SPR-NNN/documents/sprint-report
{
  "content": "[entire sprint-report.md]",
  "baseRevisionId": "[current]"
}

Step 2: PATCH /api/issues/SPR-NNN
{
  "status": "done",
  "comment": "Sprint complete. [N] features deployed to production.\n\nURL: [production-url]\nReport: /SPR-NNN/documents/sprint-report"
}

Step 3: POST /api/issues/SPR-NNN/comments
{
  "content": "@Sprint Orchestrator Sprint [ID] shipped successfully.\n\nProduction: [URL]\nFeatures: [N] shipped, [M] dropped\nTime: [elapsed] / 3:00"
}
```

**Result**: Sprint Orchestrator receives final signal. Sprint issue marked `done`.

---

### Handoff 10: Sprint Orchestrator → Sprint Closed (Cleanup & Archive)

**Trigger**: All features deployed and sprint-report.md finalized  
**API Sequence**:

```
Step 1: PATCH /api/issues/SPR-NNN
{
  "status": "done",
  "comment": "Sprint [ID] complete. [N] features shipped, [M] dropped. Total runtime: [HH:MM]. Archive: /sprints/[sprintId]/sprint-report.md"
}

Step 2: POST /api/issues/SPR-NNN/comments
{
  "content": "Sprint closed. All artifacts archived. Next sprint coordination ready."
}
```

**Result**: Sprint issue fully closed. All child issues inherit 'done' status. Artifacts are immutable and available for post-mortems.

**Archive Structure** (for Orchestrator record):
- `/sprints/[sprintId]/sprint-plan.md` — Original brief and scope
- `/sprints/[sprintId]/task-breakdown.md` — Architecture decisions
- `/sprints/[sprintId]/handoff-alpha.md`, `handoff-beta.md` — Feature implementation details
- `/sprints/[sprintId]/eval-*.md` — QA evaluation records
- `/sprints/[sprintId]/sprint-report.md` — Final deployment summary

---

## Signaling Rules and Constraints

### The Budget Cost of Signaling

Every `@-mention` in a comment costs one heartbeat trigger from the Paperclip runtime budget. Assignments don't cost extra (they're part of the issue mutation). Status changes don't cost extra.

**Best practice**: Use assignment (cheaper) when transferring ownership, use @-mention only for informational signals that don't require a handoff.

### The "One Signal per Handoff" Rule

Each phase transition should signal with exactly one mechanism:
- Either `@-mention` (wake without reassign) 
- Or `PATCH assigneeAgentId` (reassign and wake)
- Not both (double-signal wastes budget)

Exception: When creating a subtask, you must both create the task (which assigns it) AND post a comment mentioning the agent (informational).

### When Parallel Signals Are Correct

Sprint Lead signals both Engineer Alpha and Engineer Beta simultaneously by creating two separate feature issues, each with a different `assigneeAgentId`. This is correct parallelism — both engineers checkout their own issue, no conflict.

**Incorrect parallelism**: Creating one issue and assigning it to two agents. Paperclip checkout is single-owner.

### The 409 Non-Retry Rule

When two agents race to checkout the same issue simultaneously, exactly one wins (200 OK) and one loses (409 Conflict).

The losing agent MUST NOT retry the same issue. It MUST find a different task to work on. This prevents deadlocks and resource exhaustion.

---

## Error States and Recovery

### Signal Sent but Agent Doesn't Wake

**Diagnosis**: Agent's heartbeat did not fire within 60 seconds after the signal.

**Causes**:
1. Agent status is `paused` — call `POST /api/agents/{id}/resume`
2. Agent name in @-mention doesn't exactly match the agent's `name` field
3. Concurrent issue status — the issue was cancelled between the signal and wake attempt

**Recovery**:
```bash
# Check agent status
GET /api/agents/{agent-id}
→ if status == "paused": POST /api/agents/{agent-id}/resume

# Check if mention was correct (case-insensitive but must match the name exactly)
GET /api/issues/{issue-id}
→ read the comment, verify the @-mention text
```

### Multiple Agents Race for the Same Issue

**Symptom**: Two agents call `POST /api/issues/{id}/checkout` simultaneously

**Expected result**: One gets 200 (success), one gets 409 (conflict)

**Correct handling by losing agent**: Do not retry checkout. Accept the 409 and pick a different task.

**Incorrect handling**: Retry checkout, causing a spin loop. This eventually exhausts the agent's heartbeat budget.

### Orchestrator Can't Reach a Stuck Agent

**Scenario**: An engineer agent crashed mid-implementation, and the feature issue is stuck in `in_progress`.

**Recovery**:
```
Step 1: POST /api/issues/{feature-id}/checkout
{
  "agentId": "{same-engineer-id}",
  "expectedStatuses": ["in_progress"]
}
→ This "re-claims" the stale lock if the previous heartbeat run has finished

Step 2: Either resume work or PATCH status="todo" to reset for re-assignment
```

The `expectedStatuses: ["in_progress"]` pattern is the correct way to handle crashed agent recovery.

### Signal Loop (Agent Signals Itself)

**Scenario**: QA @-mentions Engineer with "refine needed", but the message goes to QA's own issue comment thread by mistake.

**Prevention**: Always read the issue status before sending a signal. If the issue is already assigned to the next agent, the signal was already sent in a prior cycle.

---

## Debugging Signals

### Checking if a Heartbeat Was Triggered

After sending a signal, verify the heartbeat fired:

```bash
# Get the sprint issue
GET /api/issues/SPR-NNN

# Read the activity log for the agent
GET /api/companies/{company-id}/activity?agentId={target-agent-id}
→ look for "heartbeat_run" events after your signal timestamp

# Or check the agent's current status
GET /api/agents/{target-agent-id}
→ if status == "running", heartbeat is currently executing
```

### Reading the Activity Log to Trace Signals

The activity log is the source of truth for signal history:

```bash
GET /api/companies/{company-id}/activity?type=issue_comment&limit=100
→ returns chronological list of all comments (signals)
→ look for timestamps and @-mention text

GET /api/companies/{company-id}/activity?type=issue_update&limit=100
→ returns all status changes and assignments
```

### Manually Invoking a Heartbeat

If an agent didn't wake after a signal, you can manually trigger it:

```bash
POST /api/agents/{agent-id}/heartbeat/invoke
{
  "taskId": "SPR-NNN"  # optional: specify which issue to wake on
}
→ returns {heartbeat_id: "...", status: "queued"}
```

### Common Mistakes and How to Spot Them

**Mistake 1: Forgetting the @-mention format**  
Wrong: `"Signal the engineer to refine"` (no @-mention in the body)  
Right: `"@Engineer Alpha please refine this feature"`  
Detection: Agent doesn't wake. Activity log shows no heartbeat trigger.

**Mistake 2: Double-signaling**  
Creates issue + assigns to Engineer + posts @-mention comment about Engineer.  
Problem: Wastes budget on duplicate mention.  
Detection: Activity log shows two separate "wake" events for the same agent/task in rapid succession.

**Mistake 3: Wrong issue ID in comment**  
Signal is on the wrong issue — engineer doesn't see it.  
Detection: Read the issue you INTENDED to signal; look for your comment there. If it's not there, you posted to a different issue.

**Mistake 4: Status transition blocks next signal**  
Feature marked `done` before QA finishes evaluating.  
Problem: QA can't re-assign the feature (status doesn't allow it).  
Detection: `PATCH assigneeAgentId` returns 409 "invalid status transition"

---

## Real Workflow Example: Sprint SPR-001 End-to-End

**Timeline** (times are relative to sprint start):

```
T+0:00  Orchestrator creates SPR-001 (sprint issue)
T+0:01  Orchestrator creates SPR-PPP (planning subtask), assigns to Product Planner
T+0:02  Product Planner @-mentioned in SPR-001 comment
        → Product Planner heartbeat fires

T+0:18  Product Planner writes sprint-plan.md to SPR-PPP/documents/plan
T+0:19  Product Planner posts "plan ready" comment on SPR-001
        → Orchestrator heartbeat fires

T+0:20  Orchestrator creates SPR-AAA (architecture subtask), assigns to Sprint Lead
T+0:21  Orchestrator @-mentions Sprint Lead in SPR-001 comment
        → Sprint Lead heartbeat fires

T+0:40  Sprint Lead writes task-breakdown.md to SPR-AAA/documents/task-breakdown
T+0:41  Sprint Lead creates SPR-F001 (feature), assigns to Engineer Alpha
T+0:42  Sprint Lead creates SPR-F002 (feature), assigns to Engineer Beta
T+0:43  Sprint Lead posts assignments comment on SPR-001
        → Engineer Alpha and Engineer Beta heartbeats fire simultaneously

T+1:10  Engineer Alpha writes handoff-engineer-alpha.md to SPR-F001/documents/handoff
T+1:11  Engineer Alpha posts "feature ready" comment on SPR-001, creates QA subtask
        → QA Engineer heartbeat fires

T+1:25  QA Engineer writes eval-report to SPR-F001/documents/eval-report (PASS)
T+1:26  QA Engineer creates SPR-D001 (deployment subtask), assigns to Delivery Engineer
T+1:27  QA Engineer posts "QA PASS" comment on SPR-001
        → Delivery Engineer heartbeat fires (if all features passed)

T+2:35  Delivery Engineer writes sprint-report to SPR-001/documents/sprint-report
T+2:36  Delivery Engineer PATCH SPR-001 status="done", posts "shipped" comment
        → Sprint complete

```

Each comment in this trace is stored in `GET /api/issues/SPR-001/comments`, giving a permanent audit trail of every handoff.

---

## Reference: Signal Checklist

Before every phase transition, use this checklist to ensure your signal will work:

```
[ ] Target agent exists and status == "active" (verify: GET /api/agents/{id})
[ ] Issue you're signaling on exists
[ ] If using assignment: target issue's current status allows reassignment
[ ] @-mention text exactly matches the agent's `name` field
[ ] If creating subtask: you've set both parentId and goalId
[ ] Comment includes the relevant artifact path or document key
[ ] You've waited for the previous agent to finish (check issue status)
[ ] Activity log shows the signal (verify within 60 seconds)
```

If any check fails, debug using the tools in the "Debugging Signals" section above.
