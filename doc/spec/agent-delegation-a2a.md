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
4. `wait: true` — event-driven wait until child reaches terminal status (server cap 300s; in-process waiter notified from every child-terminal path, 10s fallback poll).
5. `wait: false` — return immediately; parent receives automatic `delegation_child_completed` continuation when child completes (parent `succeeded` or `timed_out`; never after `cancelled`).
6. Optional child issue creation for board audit trail.
7. Org policy: target must be a **report** of source (walk `reportsTo` upward).
8. Cancel propagation: cancelling or pausing the parent cancels non-terminal children (recursively through grandchildren) and settles the parent's delegation state.
9. OpenCode-style guardrails: max chain depth `DELEGATION_MAX_DEPTH` (3), max `DELEGATION_MAX_CHILDREN_PER_RUN` (5) children per run, single pending delegation per run.
10. `GET /api/heartbeat-runs/:runId/delegation` — recovery/read path after wait timeouts (agents read own runs; board reads any).
11. A2A protocol alignment (Google/Linux Foundation): responses expose `a2aTaskState` (`submitted|working|completed|failed|canceled`) and `GET /api/agents/:id/agent-card` serves an A2A-style Agent Card for discovery.
12. Sweeper safety net: heartbeat timer tick settles parents stuck in `delegationStatus: pending` whose children are all terminal (covers crashes/restarts mid-delegation).

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
  "a2aTaskState": "completed",
  "childRun": { "status": "succeeded", "resultJson": {} },
  "delegationResult": { "summary": "...", "childStatus": "succeeded" }
}
```

On wait timeout the response carries `timedOut: true` plus a `recoveryHint` pointing at the read endpoint below.

### `GET /api/heartbeat-runs/:runId/delegation`

Read-only delegation state: `delegationStatus`, `a2aTaskState`, `delegationResult`, and the list of child runs. Agents may read only their own runs; board reads any. This is the deterministic recovery path after a wait timeout.

### `GET /api/agents/:id/agent-card`

A2A-style Agent Card (Google A2A discovery shape): identity, provider, capabilities, and a `paperclip.delegate` skill entry pointing at the delegate endpoint. Paperclip does not host a JSON-RPC A2A server; the card advertises the native REST surface so A2A-aligned clients can discover it.

### Cancel propagation

`cancelRun(parent)` and agent pause (`cancelActiveForAgent`) cancel queued/running children where `parentRunId = parent.id`, recursively (each child cancel propagates to its own children). Settling the parent's `delegationStatus` is CAS-guarded so no ghost continuation fires after cancellation.

### Guardrails (OpenCode-style)

| Limit | Value | Behavior |
|-------|-------|----------|
| Chain depth | `DELEGATION_MAX_DEPTH` = 3 | 409 when exceeded |
| Children per run | `DELEGATION_MAX_CHILDREN_PER_RUN` = 5 | 409 when exhausted |
| Pending per run | 1 | 409 while a delegation is pending |
| Wait cap | `DELEGATION_WAIT_TIMEOUT_MAX_SEC` = 300 | Clamped server-side |

## 6. Continuation (async wait)

When child run finalizes and parent has `delegationStatus: pending` + `livenessState: awaiting_delegation`:

1. Compare-and-set update of parent `delegationStatus` from child outcome (`WHERE delegationStatus = 'pending'`) — only the CAS winner performs side effects, making the wait:true HTTP path and the heartbeat finalize path race-safe.
2. If the parent run already ended `succeeded` or `timed_out`, `enqueueWakeup` for the parent agent with `reason: delegation_child_completed` and payload containing the structured child result.
3. If the parent is still `running` (agent kept working after `wait: false` or a wait timeout), no wake fires — the agent reads the result with `paperclipGetDelegation` / `GET /api/heartbeat-runs/:runId/delegation`.
4. If the parent was `cancelled`, the delegation state is settled to `cancelled` with no wake (operator intent).

### Terminal-path coverage

`handleChildRunCompleted` fires from: normal adapter finalize (all outcomes), adapter-throw failure path, run cancellation (`cancelRunInternal`), process-loss reap (when no retry queues), and the periodic pending-delegation sweep in `tickTimers`.

## 7. MCP

Tool: `paperclipDelegate` — wraps delegate endpoint; requires `PAPERCLIP_RUN_ID`.

## 8. BizCursor alignment

BizCursor F2 should call this API instead of parsing `delegation` blocks from CEO text. See `docs/bizcursor/A2A-DELEGATION-ALIGNMENT.md`.

## 9. Cost measurement

Baseline queries: `scripts/delegation-cost-baseline.sh`.
