# Paperclip, Reverse-Engineered to Its Skeletal Working System

*Derived from a direct read of the repo (schema in `packages/db/src/schema`, the engine in
`server/src/services/heartbeat.ts`, boot in `server/src/index.ts`, the adapter contract in
`packages/adapter-utils/src/types.ts`, wiring in `server/src/app.ts`). Scale: ~90 tables, 141
services, a 12,326-line heartbeat. This strips it to the irreducible core — the "kernel" idea 065 Part C
would hand-build.*

## The one-sentence model

> **A company is a tree of goals decomposed into a tree of issues, worked by a tree of agents, where a
> timer periodically wakes each agent to pick up an assigned issue and execute it through an adapter,
> recording every execution as a run.**

Everything else (governance, budgets, secrets, knowledge, plugins, multi-user, UI) is a ring of
elaboration around that sentence.

## The spine: 5 tables out of ~90

```
companies ──< agents (org chart: agents.reportsTo → agents.id)
    │            │
    │            └── adapterType + adapterConfig   ← what the agent *is*
    │            └── capabilities, role, budget, status
    │
    ├──< goals   (goal tree: goals.parentId → goals.id; level, ownerAgentId)
    │
    ├──< issues  (issue tree: issues.parentId → issues.id; issues.goalId → goals.id)
    │            └── assigneeAgentId, status, priority
    │            └── checkoutRunId / executionRunId  ← run-level locking
    │
    └──< heartbeat_runs  (the execution ledger: companyId, agentId, status,
                          usageJson, resultJson, sessionIdBefore/After, log*)
```

- **companies** — the tenant/container. Core fields: `status`/`pauseReason`, `issuePrefix`+`issueCounter`
  (human IDs), `budgetMonthlyCents`/`spentMonthlyCents` (the spend guardrail anchor).
- **agents** — the workforce. An agent *is* its `adapterType` + `adapterConfig` (+ `runtimeConfig`).
  `reportsTo` (self-ref) is the org chart; `capabilities` is free text; `status` drives scheduling.
- **goals** — the "why." A tree (`parentId`) with `level` (goal→…→task) and `ownerAgentId`. The
  invariant *all work traces to the goal* lives here.
- **issues** — the "what/work." A tree (`parentId`) linked to a goal (`goalId`) and an assignee
  (`assigneeAgentId`). `checkoutRunId`/`executionRunId`/`executionLockedAt` implement *exactly-one-run-
  at-a-time* per issue.
- **heartbeat_runs** — the "what happened." Every execution: `status` (queued→running→done/failed),
  `usageJson` (tokens), `resultJson`, `sessionIdBefore/After` (continuity), `log*` (output). This is the
  fact table everything analytical hangs off.

## The engine: one tick → wake → pick → execute → record

Boot (`server/src/index.ts`) starts the whole machine with **two `setInterval` timers**:

```
setInterval → heartbeat.tickTimers(now)          // wakes eligible agents, enqueues runs
setInterval → heartbeat.tickScheduledTriggers()  // routines (cron-style scheduled work)
```

A single **heartbeat run** (the core of `heartbeat.ts`) is the entire control loop:

1. **Wake** an eligible agent (timer tick, or an event-driven `agent_wakeup_requests` /
   `issue-assignment-wakeup`). Event-first, timer as the safety net.
2. **Admit** — may it start? Per-agent concurrency (`AGENT_DEFAULT_MAX_CONCURRENT_RUNS`), agent/company
   `status`, the issue's execution lock (`executionLockedAt`). (There is *no* fleet-wide cap — that gap
   is idea 001.)
3. **Pick** an assigned, ready issue; check it out (`checkoutRunId`).
4. **Resolve** the run's adapter config (`resolveExecutionRunAdapterConfig`) — model, workspace, skills,
   session to resume (`sessionIdBefore`).
5. **Execute** across the adapter boundary (below). The agent reads its issue/goal context, does work,
   produces outputs.
6. **Record** — write the `heartbeat_run` (status, `usageJson`, `resultJson`, `sessionIdAfter`, logs),
   update the issue `status`, persist work products/comments, release the lock.
7. **Account** — usage → `cost_events` → budget check (warn / hard-stop).

Liveness is guarded out-of-band: `task-watchdogs`, `run-liveness`, `issue-liveness`,
`heartbeat_run_watchdog_decisions`, plus process-recovery for crashed runs.

## The one boundary that matters: the adapter contract

The *only* thing that actually talks to an LLM/CLI is an adapter. The seam
(`packages/adapter-utils/src/types.ts`) is essentially:

```ts
execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>
//   ctx:  agent, issue/goal context, model, workspace, session, skills
//   result: outputs, UsageSummary (tokens → cost), sessionId (continuity),
//           error family (transient_upstream | model_refusal)
```

Each builtin (`pi-local`, `claude-local`, `process`, `http`, … in `BUILTIN_ADAPTER_TYPES`) implements
`execute` (+ a `ServerAdapterModule`/`CLIAdapterModule`, config schema, env checks, session codec, quota
windows). Swap the adapter, change the brain/runtime; the control plane is unchanged. **This is why
idea 008 (local LLM) is "mostly config" and why the kernel needs exactly one working adapter.**

## The interface: HTTP CRUD + a chat door + realtime

`app.ts` mounts ~40 Express route modules; the load-bearing few are
`companies`, `agents`, `goals`, `issues`, `approvals`, `costs`, and **`board-chat`** (the human's door to
file goals/issues and direct the company). A live-events websocket/SSE (`server/src/realtime`) streams
run/issue/budget changes to the UI so you can watch the company move.

## The concentric rings (everything else, by distance from the core)

1. **Core (above):** companies · agents · goals · issues · heartbeat_runs · the tick loop · one adapter.
2. **Accounting & safety:** `cost_events`, `budget_policies`, `budget_incidents`, watchdogs, `activity_log`.
3. **Governance:** `approvals`/`issue_approvals`, agent permissions, trust presets, secrets +
   `company_secret_bindings`, execution policy.
4. **Work substrate:** `execution_workspaces`, `workspace_operations`, `issue_work_products`,
   `documents`, environments + `environment_leases`.
5. **Extensibility:** plugins (adapters/skills/routines/jobs/host-services), `skills-catalog`,
   `teams-catalog`, `mcp-server`.
6. **People & surface:** auth, memberships, multi-user roles, sidebar/inbox, the `ui/` React app.

The `.ideas/` backlog is almost entirely *ring 2–6 enrichment*; the spine in rings 0–1 barely changes.

## The minimal kernel (what survives if you scale to skeleton — for idea 065 Part C)

The smallest thing that is recognizably Paperclip:

- **Tables:** `companies`, `agents`, `goals`, `issues`, `heartbeat_runs` (drop the other ~85).
- **Loop:** one `setInterval` → wake an agent → pick its assigned ready issue → execute → record →
  update status. (Event wakeups optional; timer alone works.)
- **Adapter:** exactly one (`process` or a single LLM via `http`) implementing `execute()`.
- **Guardrails (kernel-grade):** a company budget hard-stop from summed `usageJson`, and a manual
  human-approval gate before a run's output is accepted. (Autonomy Dial Level 0–1, per cross-cut 01.)
- **Interface:** create company/agent/goal/issue + watch runs (a handful of routes, or even seed scripts).

Everything past that — fleet concurrency, predictive budgets, deadlock/drift detection, knowledge,
multi-company, the full UI — is a capability the kernel can *grow into* (the 065 bootstrap), one ring at
a time, rather than a prerequisite. The architecture is already shaped as concentric rings, which is
precisely what makes "scale it down, then build it up" (idea 065) realistic.
