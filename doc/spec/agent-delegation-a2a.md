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
5. **Parallel fan-out with join** (Manus/OpenCode-style): multiple children per run (`wait: false` per call). The parent settles when the **last** child finishes; one `delegation_child_completed` wake fires with the aggregated results of the whole fan-out (Promise.allSettled semantics).
6. **Multi-turn follow-up** (`followUpToChildRunId`): a new delegation to the same agent resumes the prior child's adapter session via the existing `resumeFromRunId` machinery — revisions and clarifications keep the subagent's context.
7. **Synchronous join**: `GET /api/heartbeat-runs/:runId/delegation?waitAllSec=N` long-polls until every child is terminal (event-driven, same waiter registry).
8. **Idempotent retries**: `clientKey` dedupes network-level retries — the same key returns the existing child instead of spawning a duplicate.
9. **Structured output contract**: `expectedOutput` travels in the handoff and child issue so results come back in the requested shape.
10. **Selective cancel**: `POST /api/heartbeat-runs/:runId/delegations/:childRunId/cancel` interrupts one child without tearing down the fan-out.
11. Optional child issue creation for board audit trail.
12. Org policy: target must be a **report** of source (walk `reportsTo` upward).
13. Cancel propagation: cancelling or pausing the parent cancels non-terminal children (recursively through grandchildren) and settles the parent's delegation state.
14. OpenCode-style guardrails with **per-agent overrides** (`runtimeConfig.delegation.{maxDepth,maxChildren}`): defaults `DELEGATION_MAX_DEPTH` (3, hard cap 10) and `DELEGATION_MAX_CHILDREN_PER_RUN` (5, hard cap 20).
15. A2A protocol alignment (Google/Linux Foundation): responses expose `a2aTaskState` (`submitted|working|completed|failed|canceled`); `GET /api/agents/:id/agent-card` serves an A2A-style Agent Card; `GET /api/companies/:id/agent-cards` is the discovery directory.
16. Sweeper safety net: heartbeat timer tick settles parents stuck in `delegationStatus: pending` whose children are all terminal (covers crashes/restarts mid-delegation).
17. `parentRunId`/`delegationStatus` exposed in run list columns so UI/BizCursor can render delegation trees.

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

### Guardrails (OpenCode-style, per-agent tunable)

| Limit | Default | Hard cap | Override | Behavior |
|-------|---------|----------|----------|----------|
| Chain depth | 3 | 10 | `runtimeConfig.delegation.maxDepth` | 409 when exceeded |
| Children per run | 5 | 20 | `runtimeConfig.delegation.maxChildren` | 409 when exhausted |
| Wait cap | 300s | — | — | Clamped server-side |

Parallel fan-out replaces the earlier "one pending delegation per run" rule: a run may hold multiple pending children up to its budget; the join fires once when the last child lands.

## 6. Fan-out join and continuation

When a child run finalizes and the parent has `delegationStatus: pending`:

1. The child's terminal state is mirrored onto its row and any in-process `wait: true` waiter resolves immediately.
2. If **any sibling is still non-terminal**, nothing else happens — the join waits for the last child.
3. When the **last** child lands, a compare-and-set update flips the parent's `delegationStatus` from `pending` to the aggregate (`completed` if all succeeded; `failed` if any failed; else `cancelled`). Only the CAS winner performs side effects, making concurrent child finalizers, the wait:true HTTP path, and the sweep race-safe.
4. If the parent run already ended `succeeded` or `timed_out`, one `delegation_child_completed` wake fires with `delegationResults` (per-child results array), `delegationAggregate`, and `delegationCounts`.
5. If the parent is still `running` (agent kept working after `wait: false` or a wait timeout), no wake fires — the agent joins with `GET /api/heartbeat-runs/:runId/delegation?waitAllSec=N` or reads once without waiting.
6. If the parent was `cancelled`, the delegation state settles to `cancelled` with no wake (operator intent).

### Terminal-path coverage

`handleChildRunCompleted` fires from: normal adapter finalize (all outcomes), adapter-throw failure path, run cancellation (`cancelRunInternal`), selective child cancel, process-loss reap (when no retry queues), and the periodic pending-delegation sweep in `tickTimers`.

## 7. MCP

Tool: `paperclipDelegate` — wraps delegate endpoint; requires `PAPERCLIP_RUN_ID`.

## 7.1 Cross-adapter interop

Delegation is **adapter-agnostic by construction**: the control plane mediates every hop, so a CEO on `opencode_local` can delegate to a Dev on `cursor_cloud` and get results back from a QA on `claude_local` without any adapter knowing about the others.

The contract is `contextSnapshot.paperclipSessionHandoffMarkdown`:

- On `a2a_delegate` wakes it carries the task + expected output; every adapter (claude, codex, opencode, cursor, cursor-cloud, gemini, grok, pi, acpx, openclaw) already renders it into the child's prompt.
- On `delegation_child_completed` wakes it carries the joined per-child results so the parent's continuation prompt starts with the fan-out outcome on any adapter.
- The heartbeat preserves this field for delegation wake reasons (session compaction owns it for every other wake).

Follow-up (`followUpToChildRunId`) resumes sessions through each adapter's own session codec (`resumeFromRunId` machinery), so multi-turn also works per adapter.

## 7.2 Board UI

Non-technical operators see delegation without touching the API:

- Run rows (agent page) and the issue Run ledger show plain-language chips: "Delegated task" (child), "Delegating" / "Delegation done" / "Delegation issues" (parent).
- Run detail shows a "Delegated Work" section listing each child with live status and links, plus an origin banner ("This run was started by another agent") linking back to the delegating run.
- `awaiting_delegation` liveness renders as "Awaiting delegation" in the ledger.

## 8. BizCursor alignment

BizCursor F2 should call this API instead of parsing `delegation` blocks from CEO text. See `docs/bizcursor/A2A-DELEGATION-ALIGNMENT.md`.

## 9. Cost measurement

Baseline queries: `scripts/delegation-cost-baseline.sh`.
