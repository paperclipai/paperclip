# Execution Policy: Review & Approval Workflows

Paperclip's execution policy system ensures tasks are completed with the right level of oversight. Instead of relying on agents to remember to hand off work for review, the **runtime enforces** review and approval stages automatically.

## Overview

An execution policy is an optional structured object on any issue that defines what must happen after the executor finishes their work. It supports three layers of enforcement:

| Layer | Purpose | Scope |
|---|---|---|
| **Comment required** | Every agent run must post a comment back to the issue | Runtime invariant (always on) |
| **Review stage** | A reviewer checks quality/correctness and can request changes | Per-issue, optional |
| **Approval stage** | A manager/stakeholder gives final sign-off | Per-issue, optional |

These layers compose. An issue can have review only, approval only, both in sequence, or neither (just the comment-required backstop).

## Data Model

### Execution Policy (issue field: `executionPolicy`)

```ts
interface IssueExecutionPolicy {
  mode: "normal" | "auto";
  commentRequired: boolean;       // always true, enforced by runtime
  stages: IssueExecutionStage[];  // ordered list of review/approval stages
}

interface IssueExecutionStage {
  id: string;                                 // auto-generated UUID
  type: "review" | "approval";                // stage kind
  approvalsNeeded: number;                    // currently always 1
  participants: IssueExecutionStageParticipant[];
}

interface IssueExecutionStageParticipant {
  id: string;
  type: "agent" | "user";
  agentId?: string | null;    // set when type is "agent"
  userId?: string | null;     // set when type is "user"
}
```

Participants can be either agents or board users. Each stage can have multiple participants; the runtime selects the first eligible participant, preferring any explicitly requested assignee while excluding the original executor.

### Execution State (issue field: `executionState`)

Tracks where the issue currently sits in its policy workflow:

```ts
interface IssueExecutionState {
  status: "idle" | "pending" | "changes_requested" | "completed";
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: "review" | "approval" | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: "approved" | "changes_requested" | null;
}
```

### Execution Decisions (table: `issue_execution_decisions`)

An audit trail of every review/approval action:

```ts
interface IssueExecutionDecision {
  id: string;
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: "review" | "approval";
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: "approved" | "changes_requested";
  body: string;              // required comment explaining the decision
  createdByRunId: string | null;
  createdAt: Date;
}
```

## Workflow

### Happy Path: Review + Approval

```
┌──────────┐    executor     ┌───────────┐   reviewer    ┌───────────┐   approver    ┌──────┐
│  todo     │───completes───▶│ in_review  │───approves───▶│ in_review │───approves───▶│ done │
│ (Coder)  │    work         │ (QA)      │               │ (CTO)     │               │      │
└──────────┘                 └───────────┘               └───────────┘               └──────┘
```

1. **Issue created** with `executionPolicy` specifying a review stage (e.g., QA) and an approval stage (e.g., CTO).
2. **Executor works** on the issue in `in_progress` status.
3. **Executor transitions to `done`** — the runtime intercepts this:
   - Status changes to `in_review` (not `done`)
   - Issue is reassigned to the first reviewer
   - `executionState` enters `pending` on the review stage
4. **Reviewer reviews** and transitions to `done` with a comment:
   - A decision record is created: `{ outcome: "approved" }`
   - Issue stays `in_review`, reassigned to the approver
   - `executionState` advances to the approval stage
5. **Approver approves** and transitions to `done` with a comment:
   - A decision record is created: `{ outcome: "approved" }`
   - `executionState.status` becomes `completed`
   - Issue reaches actual `done` status

### Changes Requested Flow

```
┌───────────┐   reviewer requests   ┌─────────────┐   executor    ┌───────────┐
│ in_review  │───changes────────────▶│ in_progress  │───resubmits──▶│ in_review │
│ (QA)      │                       │ (Coder)      │               │ (QA)      │
└───────────┘                       └──────────────┘               └───────────┘
```

1. **Reviewer requests changes** by transitioning to any status other than `done` (typically `in_progress`), with a comment explaining what needs to change.
2. Runtime automatically:
   - Sets status to `in_progress`
   - Reassigns to the original executor (stored in `returnAssignee`)
   - Sets `executionState.status` to `changes_requested`
3. **Executor makes changes** and transitions to `done` again.
4. Runtime routes back to the **same review stage** (not the beginning), with the same reviewer.
5. This loop continues until the reviewer approves.

### Policy Variants

**Review only** (no approval stage):
```json
{
  "stages": [
    { "type": "review", "participants": [{ "type": "agent", "agentId": "qa-agent-id" }] }
  ]
}
```
Executor finishes → reviewer approves → done.

**Approval only** (no review stage):
```json
{
  "stages": [
    { "type": "approval", "participants": [{ "type": "user", "userId": "manager-user-id" }] }
  ]
}
```
Executor finishes → approver signs off → done.

**Multiple reviewers/approvers:**
Each stage supports multiple participants. The runtime selects one to act, excluding the original executor to prevent self-review.

## Comment Required Backstop

Independent of review stages, every issue-bound agent run must leave a comment. This is enforced at the runtime level:

1. **Run completes** — runtime checks if the agent posted a comment for this run.
2. **If no comment**: `issueCommentStatus` is set to `retry_queued`, and the agent is woken once more with reason `missing_issue_comment`.
3. **If still no comment after retry**: `issueCommentStatus` is set to `retry_exhausted`. No further retries. The failure is recorded.
4. **If comment posted**: `issueCommentStatus` is set to `satisfied` and linked to the comment ID.

This prevents silent completions where an agent finishes work but leaves no trace of what happened.

### Run-level tracking fields

| Field | Description |
|---|---|
| `issueCommentStatus` | `satisfied`, `retry_queued`, or `retry_exhausted` |
| `issueCommentSatisfiedByCommentId` | Links to the comment that fulfilled the requirement |
| `issueCommentRetryQueuedAt` | Timestamp when the retry wake was scheduled |

## Access Control

- Only the **active reviewer/approver** (the `currentParticipant` in execution state) can advance or reject the current stage.
- Non-participants who attempt to transition the issue receive a `422 Unprocessable Entity` error.
- Both approvals and change requests **require a comment** — empty or whitespace-only comments are rejected.

## API Usage

### Setting an execution policy on issue creation

```bash
POST /api/companies/{companyId}/issues
{
  "title": "Implement feature X",
  "assigneeAgentId": "coder-agent-id",
  "executionPolicy": {
    "mode": "normal",
    "commentRequired": true,
    "stages": [
      {
        "type": "review",
        "participants": [
          { "type": "agent", "agentId": "qa-agent-id" }
        ]
      },
      {
        "type": "approval",
        "participants": [
          { "type": "user", "userId": "cto-user-id" }
        ]
      }
    ]
  }
}
```

Stage IDs and participant IDs are auto-generated if omitted. Duplicate participants within a stage are automatically deduplicated. Stages with no valid participants are removed. If no valid stages remain, the policy is set to `null`.

### Updating execution policy on an existing issue

```bash
PATCH /api/issues/{issueId}
{
  "executionPolicy": { ... }
}
```

If the policy is removed (`null`) while a review is in progress, the execution state is cleared and the issue is returned to the original executor.

### Advancing a stage (reviewer/approver approves)

The active reviewer or approver transitions the issue to `done` with a comment:

```bash
PATCH /api/issues/{issueId}
{
  "status": "done",
  "comment": "Reviewed — implementation looks correct, tests pass."
}
```

The runtime determines whether this completes the workflow or advances to the next stage.

### Requesting changes

The active reviewer transitions to any non-`done` status with a comment:

```bash
PATCH /api/issues/{issueId}
{
  "status": "in_progress",
  "comment": "Button alignment is off on mobile. Please fix the flex container."
}
```

The runtime reassigns to the original executor automatically.

## UI

### New Issue Dialog

When creating a new issue, **Reviewer** and **Approver** buttons appear alongside the assignee selector. Clicking either opens a participant picker with:
- "No reviewer" / "No approver" (to clear)
- "Me" (current user)
- Full list of agents and board users

Selections build the `executionPolicy.stages` array automatically.

### Issue Properties Pane

For existing issues, the properties panel shows editable **Reviewer** and **Approver** fields. Multiple participants can be added per stage. Changes persist to the issue's `executionPolicy` via the API.

## Design Principles

1. **Runtime-enforced, not prompt-dependent.** Agents don't need to remember to hand off work. The runtime intercepts status transitions and routes accordingly.
2. **Iterative, not terminal.** Review is a loop (request changes → revise → re-review), not a one-shot gate. The system returns to the same stage on re-submission.
3. **Flexible roles.** Participants can be agents or users. Not every organization has "QA" — the reviewer/approver pattern is generic enough for peer review, manager sign-off, compliance checks, or any multi-party workflow.
4. **Auditable.** Every decision is recorded with actor, outcome, comment, and run ID. The full review history is queryable per issue.
5. **Single execution invariant preserved.** Review wakes and comment retries respect the existing constraint that only one agent run can be active per issue at a time.
