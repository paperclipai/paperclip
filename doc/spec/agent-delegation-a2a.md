# Agent Delegation (A2A-first-class) Spec

Status: Implemented (fork)  
Date: 2026-07-04  
Audience: Engineering  
Scope: Native agent-to-agent delegation inside the Paperclip control plane

## 1. Problem

Today delegation is **issue-centric and async**: agent A creates a child issue for agent B and exits; B wakes on assignment. The parent must heartbeat again to integrate results, causing coordination loops and redundant LLM turns.

This spec adds **first-class run delegation**: a running agent can spawn a child run on another agent, optionally wait for completion, and receive structured results — without improvising REST or polling issues.

This is **not** the full Google A2A protocol (Agent Cards, JSON-RPC). It is the minimal control-plane primitive required for CEO→report delegation inside Paperclip.

## 2. Goals

1. `POST /api/heartbeat-runs/:runId/delegate` callable by the **source run** (agent JWT + `X-Paperclip-Run-Id`).
2. Child `heartbeat_runs` row linked via `parentRunId`.
3. `wakeReason: a2a_delegate` on child wakeup (wired; replaces dead `a2a-bridge` stub path).
4. `wait: true` — long-poll until child reaches terminal status (bounded timeout).
5. `wait: false` — return immediately; parent receives automatic continuation when child completes.
6. Optional child issue creation for board audit trail.
7. Org policy: target must be a **report** of source (walk `reportsTo` upward).
8. Cancel propagation: cancelling parent cancels non-terminal children.

## 3. Non-goals (v1)

- External A2A interoperability (`/.well-known/agent.json`).
- Cross-company delegation.
- Synchronous in-process subagents inside adapters (OpenCode `Task` tool remains adapter-local).
- Replacing issue-based delegation for long-running parallel work.

## 4. Data model

### `heartbeat_runs` additions

| Column | Type | Notes |
|--------|------|-------|
| `parentRunId` | uuid FK → heartbeat_runs | null for normal runs |
| `delegationStatus` | text | `pending` \| `completed` \| `failed` \| `cancelled` \| null |
| `delegationResultJson` | jsonb | Structured child result for parent consumption |

### Liveness

Add `awaiting_delegation` to `RUN_LIVENESS_STATES` when parent is waiting on a child (async path).

## 5. API

### `POST /api/heartbeat-runs/:runId/delegate`

**Auth:** Agent bearer key; `req.actor.runId` must equal `:runId`; source agent must own the run.

**Body:**

```json
{
  "targetAgentId": "uuid",
  "task": "Implement the login form validation",
  "issueId": "uuid-or-identifier (optional)",
  "createChildIssue": true,
  "childIssueTitle": "optional override",
  "wait": true,
  "waitTimeoutSec": 300
}
```

**Behavior:**

1. Validate parent run `status === running`.
2. Validate target invokable and in same company.
3. Validate `target` is in `source` org subtree (`reportsTo` chain).
4. If `createChildIssue` and parent has `issueId` in context, create child issue assigned to target.
5. Enqueue child wakeup (`source: automation`, `reason: a2a_delegate`).
6. Set parent `livenessState: awaiting_delegation`, `delegationStatus: pending`.
7. If `wait: true`, poll child until terminal or timeout; return combined payload.
8. If `wait: false`, return `{ childRunId, delegationStatus: "pending" }`.

**Response (wait complete):**

```json
{
  "parentRunId": "uuid",
  "childRunId": "uuid",
  "childIssueId": "uuid | null",
  "delegationStatus": "completed",
  "childRun": { "status": "succeeded", "resultJson": {} },
  "delegationResult": { "summary": "...", "status": "succeeded" }
}
```

### Cancel propagation

`cancelRun(parent)` also cancels queued/running children where `parentRunId = parent.id`.

## 6. Continuation (async wait)

When child run finalizes and parent has `delegationStatus: pending` + `livenessState: awaiting_delegation`:

1. Update parent `delegationStatus` from child outcome.
2. `enqueueWakeup` for parent agent with `reason: delegation_child_completed` and payload containing child summary.

## 7. MCP

Tool: `paperclipDelegate` — wraps delegate endpoint; requires `PAPERCLIP_RUN_ID`.

## 8. BizCursor alignment

BizCursor F2 should call this API instead of parsing `delegation` blocks from CEO text. See `docs/bizcursor/A2A-DELEGATION-ALIGNMENT.md`.

## 9. Cost measurement

Baseline queries: `scripts/delegation-cost-baseline.sh`.
