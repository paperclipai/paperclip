# Agent Runs Subsystem Spec

Status: Draft  
Date: 2026-02-17  
Audience: Product + Engineering  
Scope: Agent execution runtime, adapter protocol, wakeup orchestration, and live status delivery

## 1. Document Role

This spec defines how Paperclip actually runs agents while staying runtime-agnostic.

- `doc/SPEC-implementation.md` remains the V1 baseline contract.
- This document adds concrete subsystem detail for agent execution, including local CLI adapters, runtime state persistence, wakeup scheduling, and browser live updates.
- If this doc conflicts with current runtime behavior in code, this doc is the target behavior for upcoming implementation.

## 2. Captured Intent (From Request)

The following intentions are explicitly preserved in this spec:

1. Paperclip is adapter-agnostic. The key is a protocol, not a specific runtime.
2. We still need default built-ins to make the system useful immediately.
3. First two built-ins are `claude-local` and `codex-local`.
4. Those adapters run local CLIs directly on the host machine, unsandboxed.
5. Agent config includes working directory and initial/default prompt.
6. Heartbeats run the configured adapter process, Paperclip manages lifecycle, and on exit Paperclip parses JSON output and updates state.
7. Session IDs and token usage must be persisted so later heartbeats can resume.
8. Adapters should support status updates (short message + color) and optional streaming logs.
9. UI should support prompt template "pills" for variable insertion.
10. CLI errors must be visible in full (or as much as possible) in the UI.
11. Status changes must live-update across task and agent views via server push.
12. Wakeup triggers should be centralized by a heartbeat/wakeup service with at least:
   - timer interval
   - wake on task assignment
   - explicit ping/request

## 3. Goals and Non-Goals

### 3.1 Goals

1. Define a stable adapter protocol that supports multiple runtimes.
2. Ship production-usable local adapters for Claude CLI and Codex CLI.
3. Persist adapter runtime state (session IDs, token/cost usage, last errors).
4. Centralize wakeup decisions and queueing in one service.
5. Provide realtime run/task/agent updates to the browser.
6. Support deployment-specific full-log storage without bloating Postgres.
7. Preserve company scoping and existing governance invariants.

### 3.2 Non-Goals (for this subsystem phase)

1. Distributed execution workers across multiple hosts.
2. Third-party adapter marketplace/plugin SDK.
3. Perfect cost accounting for providers that do not emit cost.
4. Long-term log archival strategy beyond basic retention.

## 4. Baseline and Gaps (As of 2026-02-17)

Current code already has:

- `agents` with `adapterType` + `adapterConfig`.
- `heartbeat_runs` with basic status tracking.
- in-process `heartbeatService` that invokes `process` and `http`.
- cancellation endpoints for active runs.

Current gaps this spec addresses:

1. No persistent per-agent runtime state for session resume.
2. No queue/wakeup abstraction (invoke is immediate).
3. No assignment-triggered or timer-triggered centralized wakeups.
4. No websocket/SSE push path to browser.
5. No persisted run event timeline or external full-log storage contract.
6. No typed local adapter contracts for Claude/Codex session and usage extraction.
7. No prompt-template variable/pill system in agent setup.
8. No deployment-aware adapter for full run log storage (disk/object store/etc).

## 5. Architecture Overview

The subsystem introduces six cooperating components:

1. `Adapter Registry`
   - Maps `adapter_type` to implementation.
   - Exposes capability metadata and config validation.

2. `Wakeup Coordinator`
   - Single entrypoint for all wakeups (`timer`, `assignment`, `on_demand`, `automation`).
   - Applies dedupe/coalescing and queue rules.

3. `Run Executor`
   - Claims queued wakeups.
   - Creates `heartbeat_runs`.
   - Spawns/monitors child processes for local adapters.
   - Handles timeout/cancel/graceful kill.

4. `Runtime State Store`
   - Persists resumable adapter state per agent.
   - Persists run usage summaries and lightweight run-event timeline.

5. `Run Log Store`
   - Persists full stdout/stderr streams via pluggable storage adapter.
   - Returns stable `logRef` for retrieval (local path, object key, or DB reference).

6. `Realtime Event Hub`
   - Publishes run/agent/task updates over websocket.
   - Supports selective subscription by company.

Control flow (happy path):

1. Trigger arrives (`timer`, `assignment`, `on_demand`, or `automation`).
2. Wakeup coordinator enqueues/merges wake request.
3. Executor claims request, creates run row, marks agent `running`.
4. Adapter executes, emits status/log/usage events.
5. Full logs stream to `RunLogStore`; metadata/events are persisted to DB and pushed to websocket subscribers.
6. Process exits, output parser updates run result + runtime state.
7. Agent returns to `idle` or `error`; UI updates in real time.

## 6. Agent Run Protocol (Version `agent-run/v1`)

This protocol is runtime-agnostic and implemented by all adapters.

```ts
type RunOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";
type StatusColor = "neutral" | "blue" | "green" | "yellow" | "red";

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cachedOutputTokens?: number;
}

interface AdapterInvokeInput {
  protocolVersion: "agent-run/v1";
  companyId: string;
  agentId: string;
  runId: string;
  wakeupSource: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  cwd: string;
  prompt: string;
  adapterConfig: Record<string, unknown>;
  runtimeState: Record<string, unknown>;
  env: Record<string, string>;
  timeoutSec: number;
}

interface AdapterHooks {
  status?: (update: { message: string; color?: StatusColor }) => Promise<void>;
  log?: (event: { stream: "stdout" | "stderr" | "system"; chunk: string }) => Promise<void>;
  usage?: (usage: TokenUsage) => Promise<void>;
  event?: (eventType: string, payload: Record<string, unknown>) => Promise<void>;
}

interface AdapterInvokeResult {
  outcome: RunOutcome;
  exitCode: number | null;
  errorMessage?: string | null;
  summary?: string | null;
  sessionId?: string | null;
  usage?: TokenUsage | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  runtimeStatePatch?: Record<string, unknown>;
  rawResult?: Record<string, unknown> | null;
}

interface AgentRunAdapter {
  type: string;
  protocolVersion: "agent-run/v1";
  capabilities: {
    resumableSession: boolean;
    statusUpdates: boolean;
    logStreaming: boolean;
    tokenUsage: boolean;
  };
  validateConfig(config: unknown): { ok: true } | { ok: false; errors: string[] };
  invoke(input: AdapterInvokeInput, hooks: AdapterHooks, signal: AbortSignal): Promise<AdapterInvokeResult>;
}
```

### 6.1 Required Behavior

1. `validateConfig` runs before saving or invoking.
2. `invoke` must be deterministic for a given config + runtime state + prompt.
3. Adapter must not mutate DB directly; it returns data via result/events only.
4. Adapter must emit enough context for errors to be debuggable.
5. If `invoke` throws, executor records run as `failed` with captured error text.

### 6.2 Optional Behavior

Adapters may omit status/log hooks. If omitted, runtime still emits system lifecycle statuses (`queued`, `running`, `finished`).

### 6.3 Run log storage protocol

Full run logs are managed by a separate pluggable store (not by the agent adapter).

```ts
type RunLogStoreType = "local_file" | "object_store" | "postgres";

interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string; // opaque provider reference (path, key, uri, row id)
}

interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  finalize(
    handle: RunLogHandle,
    summary: { bytes: number; sha256?: string; compressed: boolean },
  ): Promise<void>;
  read(
    handle: RunLogHandle,
    opts?: { offset?: number; limitBytes?: number },
  ): Promise<{ content: string; nextOffset?: number }>;
  delete?(handle: RunLogHandle): Promise<void>;
}
```

V1 deployment defaults:

1. Dev/local default: `local_file` (write to `data/run-logs/...`).
2. Cloud/serverless default: `object_store` (S3/R2/GCS compatible).
3. Optional fallback: `postgres` with strict size caps.

### 6.4 Adapter identity and compatibility

For V1 rollout, adapter identity is explicit:

- `claude_local`
- `codex_local`
- `process` (generic existing behavior)
- `http` (generic existing behavior)

`claude_local` and `codex_local` are not wrappers around arbitrary `process`; they are typed adapters with known parser/resume semantics.

## 7. Built-in Adapters (Phase 1)

## 7.1 `claude-local`

Runs local `claude` CLI directly.

### Config

```json
{
  "cwd": "/absolute/or/relative/path",
  "promptTemplate": "You are agent {{agent.id}} ...",
  "model": "optional-model-id",
  "maxTurnsPerRun": 80,
  "dangerouslySkipPermissions": true,
  "env": {"KEY": "VALUE"},
  "extraArgs": [],
  "timeoutSec": 1800,
  "graceSec": 20
}
```

### Invocation

- Base command: `claude --print <prompt> --output-format json`
- Resume: add `--resume <sessionId>` when runtime state has session ID
- Unsandboxed mode: add `--dangerously-skip-permissions` when enabled

### Output parsing

1. Parse stdout JSON object.
2. Extract `session_id` for resume.
3. Extract usage fields:
   - `usage.input_tokens`
   - `usage.cache_read_input_tokens` (if present)
   - `usage.output_tokens`
4. Extract `total_cost_usd` when present.
5. On non-zero exit: still attempt parse; if parse succeeds keep extracted state and mark run failed unless adapter explicitly reports success.

## 7.2 `codex-local`

Runs local `codex` CLI directly.

### Config

```json
{
  "cwd": "/absolute/or/relative/path",
  "promptTemplate": "You are agent {{agent.id}} ...",
  "model": "optional-model-id",
  "search": false,
  "dangerouslyBypassApprovalsAndSandbox": true,
  "env": {"KEY": "VALUE"},
  "extraArgs": [],
  "timeoutSec": 1800,
  "graceSec": 20
}
```

### Invocation

- Base command: `codex exec --json <prompt>`
- Resume form: `codex exec --json resume <sessionId> <prompt>`
- Unsandboxed mode: add `--dangerously-bypass-approvals-and-sandbox` when enabled
- Optional search mode: add `--search`

### Output parsing

Codex emits JSONL events. Parse line-by-line and extract:

1. `thread.started.thread_id` -> session ID
2. `item.completed` where item type is `agent_message` -> output text
3. `turn.completed.usage`:
   - `input_tokens`
   - `cached_input_tokens`
   - `output_tokens`

Codex JSONL currently may not include cost; store token usage and leave cost null/unknown unless available.

## 7.3 Common local adapter process handling

Both local adapters must:

1. Use `spawn(command, args, { shell: false, stdio: "pipe" })`.
2. Capture stdout/stderr in stream chunks and forward to `RunLogStore`.
3. Maintain rolling stdout/stderr tail excerpts in memory for DB diagnostic fields.
4. Emit live log events to websocket subscribers (optional to throttle/chunk).
5. Support graceful cancel: `SIGTERM`, then `SIGKILL` after `graceSec`.
6. Enforce timeout using adapter `timeoutSec`.
7. Return exit code + parsed result + diagnostic stderr.

## 8. Heartbeat and Wakeup Coordinator

## 8.1 Wakeup sources

Supported sources:

1. `timer`: periodic heartbeat per agent.
2. `assignment`: issue assigned/reassigned to agent.
3. `on_demand`: explicit wake request path (board/manual click or API ping).
4. `automation`: non-interactive wake path (external callback or internal system automation).

## 8.2 Central API

All sources call one internal service:

```ts
enqueueWakeup({
  companyId,
  agentId,
  source,
  triggerDetail, // optional: manual|ping|callback|system
  reason,
  payload,
  requestedBy,
  idempotencyKey?
})
```

No source invokes adapters directly.

## 8.3 Queue semantics

1. Max active run per agent remains `1`.
2. If agent already has `queued`/`running` run:
   - coalesce duplicate wakeups
   - increment `coalescedCount`
   - preserve latest reason/source metadata
3. Queue is DB-backed for restart safety.
4. Coordinator uses FIFO by `requested_at`, with optional priority:
   - `on_demand` > `assignment` > `timer`/`automation`

## 8.4 Agent heartbeat policy fields

Agent-level control-plane settings (not adapter-specific):

```json
{
  "heartbeat": {
    "enabled": true,
    "intervalSec": 300,
    "wakeOnAssignment": true,
    "wakeOnOnDemand": true,
    "wakeOnAutomation": true,
    "cooldownSec": 10
  }
}
```

Defaults:

- `enabled: true`
- `intervalSec: null` (no timer until explicitly set) or product default `300` if desired globally
- `wakeOnAssignment: true`
- `wakeOnOnDemand: true`
- `wakeOnAutomation: true`

## 8.5 Trigger integration rules

1. Timer checks run on server worker interval and enqueue due agents.
2. Issue assignment mutation enqueues wakeup when assignee changes and target agent has `wakeOnAssignment=true`.
3. On-demand endpoint enqueues wakeup with `source=on_demand` and `triggerDetail=manual|ping` when `wakeOnOnDemand=true`.
4. Callback/system automations enqueue wakeup with `source=automation` and `triggerDetail=callback|system` when `wakeOnAutomation=true`.
5. Paused/terminated agents do not receive new wakeups.
6. Hard budget-stopped agents do not receive new wakeups.

## 9. Persistence Model

All tables remain company-scoped.

## 9.0 Changes to `agents`

1. Extend `adapter_type` domain to include `claude_local` and `codex_local` (alongside existing `process`, `http`).
2. Keep `adapter_config` as adapter-owned config (CLI flags, cwd, prompt templates, env overrides).
3. Add `runtime_config` jsonb for control-plane scheduling policy:
   - heartbeat enable/interval
   - wake-on-assignment
   - wake-on-on-demand
   - wake-on-automation
   - cooldown

This separation keeps adapter config runtime-agnostic while allowing the heartbeat service to apply consistent scheduling logic.

## 9.1 New table: `agent_runtime_state`

One row per agent for aggregate runtime counters and legacy compatibility.

- `agent_id` uuid pk fk `agents.id`
- `company_id` uuid fk not null
- `adapter_type` text not null
- `session_id` text null
- `state_json` jsonb not null default `{}`
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_run_status` text null
- `total_input_tokens` bigint not null default `0`
- `total_output_tokens` bigint not null default `0`
- `total_cached_input_tokens` bigint not null default `0`
- `total_cost_cents` bigint not null default `0`
- `last_error` text null
- `updated_at` timestamptz not null

Invariant: exactly one runtime state row per agent.

## 9.1.1 New table: `agent_task_sessions`

One row per `(company_id, agent_id, adapter_type, task_key)` for resumable session state.

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `adapter_type` text not null
- `task_key` text not null
- `session_params_json` jsonb null (adapter-defined shape)
- `session_display_id` text null (for UI/debug)
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_error` text null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Invariant: unique `(company_id, agent_id, adapter_type, task_key)`.

## 9.2 New table: `agent_wakeup_requests`

Queue + audit for wakeups.

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `source` text not null (`timer|assignment|on_demand|automation`)
- `trigger_detail` text null (`manual|ping|callback|system`)
- `reason` text null
- `payload` jsonb null
- `status` text not null (`queued|claimed|coalesced|skipped|completed|failed|cancelled`)
- `coalesced_count` int not null default `0`
- `requested_by_actor_type` text null (`user|agent|system`)
- `requested_by_actor_id` text null
- `idempotency_key` text null
- `run_id` uuid fk `heartbeat_runs.id` null
- `requested_at` timestamptz not null
- `claimed_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null

## 9.3 New table: `heartbeat_run_events`

Append-only per-run lightweight event timeline (no full raw log chunks).

- `id` bigserial pk
- `company_id` uuid fk not null
- `run_id` uuid fk `heartbeat_runs.id` not null
- `agent_id` uuid fk `agents.id` not null
- `seq` int not null
- `event_type` text not null (`lifecycle|status|usage|error|structured`)
- `stream` text null (`system|stdout|stderr`) (summarized events only, not full stream chunks)
- `level` text null (`info|warn|error`)
- `color` text null
- `message` text null
- `payload` jsonb null
- `created_at` timestamptz not null

## 9.4 Changes to `heartbeat_runs`

Add fields required for result and diagnostics:

- `wakeup_request_id` uuid fk `agent_wakeup_requests.id` null
- `exit_code` int null
- `signal` text null
- `usage_json` jsonb null
- `result_json` jsonb null
- `session_id_before` text null
- `session_id_after` text null
- `log_store` text null (`local_file|object_store|postgres`)
- `log_ref` text null (opaque provider reference; path/key/uri/row id)
- `log_bytes` bigint null
- `log_sha256` text null
- `log_compressed` boolean not null default false
- `stderr_excerpt` text null
- `stdout_excerpt` text null
- `error_code` text null

This keeps per-run diagnostics queryable without storing full logs in Postgres.

## 9.5 Log storage adapter configuration

Runtime log storage is deployment-configured (not per-agent by default).

```json
{
  "runLogStore": {
    "type": "local_file | object_store | postgres",
    "basePath": "./data/run-logs",
    "bucket": "paperclip-run-logs",
    "prefix": "runs/",
    "compress": true,
    "maxInlineExcerptBytes": 32768
  }
}
```

Rules:

1. `log_ref` must be opaque and provider-neutral at API boundaries.
2. UI/API must not assume local filesystem semantics.
3. Provider-specific secrets/credentials stay in server config, never in agent config.

## 10. Prompt Template and Pill System

## 10.1 Template format

- Mustache-style placeholders: `{{path.to.value}}`
- No arbitrary code execution.
- Unknown variable on save = validation error.

## 10.2 Initial variable catalog

- `company.id`
- `company.name`
- `agent.id`
- `agent.name`
- `agent.role`
- `agent.title`
- `run.id`
- `run.source`
- `run.startedAt`
- `heartbeat.reason`
- `paperclip.skill` (shared Paperclip skill text block)
- `credentials.apiBaseUrl`
- `credentials.apiKey` (optional, sensitive)

## 10.3 Prompt fields

1. `promptTemplate`
   - Used on every wakeup (first run and resumed runs).
   - Can include run source/reason pills.

## 10.4 UI requirements

1. Agent setup/edit form includes prompt editors with pill insertion.
2. Variables are shown as clickable pills for fast insertion.
3. Save-time validation indicates unknown/missing variables.
4. Sensitive pills (`credentials.*`) show explicit warning badge.

## 10.5 Security notes for credentials

1. Credentials in prompt are allowed for initial simplicity but discouraged.
2. Preferred transport is env vars (`PAPERCLIP_*`) injected at runtime.
3. Prompt preview and logs must redact sensitive values.

## 11. Realtime Status Delivery

## 11.1 Transport

Primary transport: websocket channel per company.

- Endpoint: `GET /api/companies/:companyId/events/ws`
- Auth: board session or agent API key (company-bound)

## 11.2 Event envelope

```json
{
  "eventId": "uuid-or-monotonic-id",
  "companyId": "uuid",
  "type": "heartbeat.run.status",
  "entityType": "heartbeat_run",
  "entityId": "uuid",
  "occurredAt": "2026-02-17T12:00:00Z",
  "payload": {}
}
```

## 11.3 Required event types

1. `agent.status.changed`
2. `heartbeat.run.queued`
3. `heartbeat.run.started`
4. `heartbeat.run.status` (short color+message updates)
5. `heartbeat.run.log` (optional live chunk stream; full persistence handled by `RunLogStore`)
6. `heartbeat.run.finished`
7. `issue.updated`
8. `issue.comment.created`
9. `activity.appended`

## 11.4 UI behavior

1. Agent detail view updates run timeline live.
2. Task board reflects assignment/status/comment changes from agent activity without refresh.
3. Org/agent list reflects status changes live.
4. If websocket disconnects, client falls back to short polling until reconnect.

## 12. Error Handling and Diagnostics

## 12.1 Error classes

- `adapter_not_installed`
- `invalid_working_directory`
- `spawn_failed`
- `timeout`
- `cancelled`
- `nonzero_exit`
- `output_parse_error`
- `resume_session_invalid`
- `budget_blocked`

## 12.2 Logging requirements

1. Persist full stdout/stderr stream to configured `RunLogStore`.
2. Persist only lightweight run metadata/events in Postgres (`heartbeat_runs`, `heartbeat_run_events`).
3. Persist bounded `stdout_excerpt` and `stderr_excerpt` in Postgres for quick diagnostics.
4. Mark truncation explicitly when excerpts are capped.
5. Redact secrets from logs, excerpts, and websocket payloads.

## 12.3 Log retention and lifecycle

1. `RunLogStore` retention is configurable by deployment (for example 7/30/90 days).
2. Postgres run metadata can outlive full log objects.
3. Deletion/pruning jobs must handle orphaned metadata/log-object references safely.
4. If full log object is gone, APIs still return metadata and excerpts with `log_unavailable` status.

## 12.4 Restart recovery

On server startup:

1. Find stale `queued`/`running` runs.
2. Mark as `failed` with `error_code=control_plane_restart`.
3. Set affected non-paused/non-terminated agents to `error` (or `idle` based on policy).
4. Emit recovery events to websocket and activity log.

## 13. API Surface Changes

## 13.1 New/updated endpoints

1. `POST /agents/:agentId/wakeup`
   - enqueue wakeup with source/reason
2. `POST /agents/:agentId/heartbeat/invoke`
   - backward-compatible alias to wakeup API
3. `GET /agents/:agentId/runtime-state`
   - board-only debug view
4. `GET /agents/:agentId/task-sessions`
   - board-only list of task-scoped adapter sessions
5. `POST /agents/:agentId/runtime-state/reset-session`
   - clears all task sessions for the agent, or one when `taskKey` is provided
6. `GET /heartbeat-runs/:runId/events?afterSeq=:n`
   - fetch persisted lightweight timeline
7. `GET /heartbeat-runs/:runId/log`
   - reads full log stream via `RunLogStore` (or redirects/presigned URL for object store)
8. `GET /api/companies/:companyId/events/ws`
   - websocket stream

## 13.2 Mutation logging

All wakeup/run state mutations must create `activity_log` entries:

- `wakeup.requested`
- `wakeup.coalesced`
- `heartbeat.started`
- `heartbeat.finished`
- `heartbeat.failed`
- `heartbeat.cancelled`
- `runtime_state.updated`

## 14. Heartbeat Service Implementation Plan

## Phase 1: Contracts and schema

1. Add new DB tables/columns (`agent_runtime_state`, `agent_wakeup_requests`, `heartbeat_run_events`, `heartbeat_runs.log_*` fields).
2. Add `RunLogStore` interface and configuration wiring.
3. Add shared types/constants/validators.
4. Keep existing routes functional during migration.

## Phase 2: Wakeup coordinator

1. Implement DB-backed wakeup queue.
2. Convert invoke/wake routes to enqueue with `source=on_demand` and appropriate `triggerDetail`.
3. Add worker loop to claim and execute queued wakeups.

## Phase 3: Local adapters

1. Implement `claude-local` adapter.
2. Implement `codex-local` adapter.
3. Parse and persist session IDs and token usage.
4. Wire cancel/timeout/grace behavior.

## Phase 4: Realtime push

1. Implement company websocket hub.
2. Publish run/agent/issue events.
3. Update UI pages to subscribe and invalidate/update relevant data.

## Phase 5: Prompt pills and config UX

1. Add adapter-specific config editor with prompt templates.
2. Add pill insertion and variable validation.
3. Add sensitive-variable warnings and redaction.

## Phase 6: Hardening

1. Add failure/restart recovery sweeps.
2. Add metadata/full-log retention policies and pruning jobs.
3. Add integration/e2e coverage for wakeup triggers and live updates.

## 15. Acceptance Criteria

1. Agent with `claude-local` or `codex-local` can run, exit, and persist run result.
2. Session parameters are persisted per task scope and reused automatically for same-task resumes.
3. Token usage is persisted per run and accumulated per agent runtime state.
4. Timer, assignment, on-demand, and automation wakeups all enqueue through one coordinator.
5. Pause/terminate interrupts running local process and prevents new wakeups.
6. Browser receives live websocket updates for run status/logs and task/agent changes.
7. Failed runs expose rich CLI diagnostics in UI with excerpts immediately available and full log retrievable via `RunLogStore`.
8. All actions remain company-scoped and auditable.

## 16. Open Questions

1. Should timer default be `null` (off until enabled) or `300` seconds by default?
2. What should the default retention policy be for full log objects vs Postgres metadata?
3. Should agent API credentials be allowed in prompt templates by default, or require explicit opt-in toggle?
4. Should websocket be the only realtime channel, or should we also expose SSE for simpler clients?
