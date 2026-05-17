# Sandbox Runtime and Provider Adapter Architecture

Status: design proposal for LET-154
Date: 2026-05-15
Audience: Enterprise Agent OS product, runtime, adapter, security, and UI implementers

## 1. Purpose

Paperclip already treats itself as the control plane for autonomous AI companies: issues, org structure, approvals, budgets, heartbeats, comments, documents, work products, and execution workspaces remain the source of truth. This proposal adds a sandbox/runtime layer without changing that product boundary.

The goal is not to make Paperclip a generic cloud executor. The goal is to make agent execution safer, more observable, and more portable while preserving the adapter-agnostic heartbeat model.

## 2. Decision summary

1. Keep Paperclip as control plane, not execution plane.
   - The Paperclip server schedules, authorizes, observes, and records runs.
   - A worker/provider layer owns sandbox realization and process/container lifecycle.
   - Agent adapters remain runtime-specific bridges for Claude Code, Codex, OpenCode/OpenClaw, Hermes, custom CLIs, HTTP agents, and MCP-enabled agents.

2. Add a provider-neutral `SandboxProvider` boundary.
   - MVP provider: `docker_local` on a VPS or operator machine.
   - Future providers: `microvm_firecracker`, `e2b_remote`, `custom_http_provider`.
   - Adapters must not know whether they run inside Docker, a microVM, E2B, or a remote provider.

3. Add an execution worker queue with leases before adding distributed workers.
   - V1 can run the worker in-process or sidecar on the same host.
   - The queue contract should still use explicit leases, heartbeats, attempts, and idempotent run claims so it can move to a separate worker fleet later.

4. Treat secrets as references, never as persisted sandbox payloads.
   - Agent/project/runtime config stores secret references or allowlisted env keys.
   - The worker resolves secrets just-in-time, injects them into the sandbox, records only a redacted manifest, and wipes temporary material on teardown.

5. Make UI status placeholder-safe.
   - Any unimplemented provider/runtime control must display as `Preview`, `Planned`, or `Disabled`.
   - The UI should show human-readable execution state first, then expandable logs/artifacts beneath it.

## 3. Scope and non-goals

### In scope

- Docker/VPS sandbox MVP design.
- Provider-neutral sandbox abstraction.
- Future microVM/E2B-style extension points.
- Worker queue and lease model.
- Logs and artifact capture.
- Resource limits and timeouts.
- Secret injection model.
- Runtime adapter lifecycle for Claude Code, Codex, OpenCode/OpenClaw, Hermes, custom CLI, HTTP, and MCP-agent flows.
- Placeholder-safe UI/status plan.

### Non-goals for this issue

- No production deployment.
- No production runtime behavior change.
- No database migration in this design-only slice.
- No live MCP installation, connection, or execution.
- No secret value exposure.
- No GitHub PR creation or protected merge without approval.

## 4. Existing Paperclip boundaries to preserve

Current docs establish these invariants:

- Company-scoped entities and access checks.
- Single-assignee issue model.
- Atomic checkout for agent-owned `in_progress` issues.
- Heartbeats are short execution windows, not always-on daemons.
- Adapter type/config defines how an agent runs.
- Execution workspaces and work products are separate from issue ownership.
- Local CLI adapters are currently host-trusted and unsandboxed; this architecture hardens that without making the core product a raw log/process UI.

The sandbox runtime should integrate with these existing concepts rather than replacing them.

## 5. Target architecture

```text
Paperclip API / Control Plane
  - companies, agents, issues, approvals, budgets
  - checkout and execution locks
  - heartbeat run records
  - execution workspace and work product records
  - run status/events API and UI

Runtime Orchestrator
  - validates agent/runtime config
  - builds run plan from issue + agent + workspace + approvals
  - enqueues sandbox job
  - applies timeout/cancel/budget/approval gates
  - maps sandbox events back to heartbeat_runs, comments, documents, artifacts

Worker Queue and Lease Store
  - durable job row per execution attempt
  - lease owner, lease expiry, attempt count
  - idempotency key: companyId + issueId + heartbeatRunId + attempt
  - retry only when safe and visible

Sandbox Worker
  - claims leases
  - resolves workspace
  - resolves secret references just-in-time
  - calls SandboxProvider.create/start/exec/stop/teardown
  - streams logs/events/artifacts
  - emits final result and cleanup status

SandboxProvider interface
  - docker_local MVP
  - microvm_firecracker future
  - e2b_remote future
  - custom_http_provider future

RuntimeAdapter interface
  - Claude Code adapter
  - Codex adapter
  - OpenCode/OpenClaw adapter
  - Hermes adapter
  - custom CLI/process adapter
  - HTTP/MCP agent adapter
```

## 6. Module boundaries

### 6.1 Runtime Orchestrator

Responsibilities:

- Accept a heartbeat wake/checkout event.
- Confirm company, agent, issue, approval, budget, and workspace invariants.
- Build a `RunPlan`:
  - agent identity and adapter type
  - issue/task context
  - execution workspace strategy
  - sandbox provider preference
  - resource policy
  - timeout/cancel policy
  - secret reference manifest
  - artifact/log policy
- Enqueue a sandbox job and attach it to the current heartbeat run.
- Keep status in Paperclip terms: queued, running, needs approval, failed, timed out, cancelled, succeeded, cleanup failed.

Non-responsibilities:

- Starting containers/microVMs directly.
- Passing raw secrets into persisted job rows.
- Parsing provider-specific logs as product state.

### 6.2 Worker Queue and Leases

MVP can be Postgres-backed. A separate Redis/BullMQ/Temporal-like system can come later only if operational pressure justifies it.

Suggested table shape, deferred until implementation:

- `runtime_jobs`
  - `id`
  - `company_id`
  - `agent_id`
  - `issue_id`
  - `heartbeat_run_id`
  - `execution_workspace_id`
  - `adapter_type`
  - `sandbox_provider_type`
  - `status`: queued | leased | running | succeeded | failed | timed_out | cancelled | cleanup_failed
  - `attempt`
  - `idempotency_key`
  - `lease_owner`
  - `lease_expires_at`
  - `started_at`, `finished_at`, `updated_at`
  - `resource_policy_json`
  - `redacted_secret_manifest_json`
  - `artifact_root_ref`
  - `error_summary`

- `runtime_job_events`
  - lifecycle/status events, small and queryable
  - no raw secret values
  - raw stdout/stderr remains in run log storage

Lease rules:

- Claim uses compare-and-set: queued job -> leased only if lease is null or expired.
- Worker renews lease periodically while running.
- If lease expires, another worker may adopt only after confirming provider state or marking the old attempt uncertain.
- Cancellation writes a cancel request first; worker translates it to provider stop/kill with grace period.
- Retries must be visible and bounded; no hidden infinite loops.

### 6.3 SandboxProvider

Provider-neutral contract:

```ts
interface SandboxProvider {
  type: "docker_local" | "microvm_firecracker" | "e2b_remote" | "custom_http_provider";
  capabilities: {
    filesystemIsolation: "host_mount" | "copy_on_write" | "snapshot" | "remote";
    networkPolicy: boolean;
    resourceLimits: boolean;
    secretFileMounts: boolean;
    artifactExport: boolean;
    interactiveSessions: boolean;
  };
  validatePolicy(policy: SandboxPolicy): ValidationResult;
  prepare(input: SandboxPrepareInput): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<void>;
  exec(handle: SandboxHandle, command: CommandSpec, hooks: SandboxHooks, signal: AbortSignal): Promise<SandboxExecResult>;
  collectArtifacts(handle: SandboxHandle, policy: ArtifactPolicy): Promise<ArtifactRef[]>;
  stop(handle: SandboxHandle, reason: StopReason): Promise<void>;
  teardown(handle: SandboxHandle): Promise<TeardownResult>;
}
```

Provider invariants:

- Provider never writes Paperclip DB directly.
- Provider emits events/logs/artifacts through hooks.
- Provider receives only redacted run metadata plus just-in-time secret material.
- Provider teardown is idempotent.

### 6.4 RuntimeAdapter

Adapters translate Paperclip run context into the actual agent invocation.

Common lifecycle:

1. `validateConfig` before saving or invoking.
2. `buildCommand` or `buildRequest` from `RunPlan`.
3. `prepareSessionState` from prior adapter runtime state.
4. `invoke` through the sandbox provider.
5. `parseResult` for summary, session id, usage, model/provider, and structured final state.
6. `persistRuntimeStatePatch` through orchestrator only.

Adapter-specific notes:

- Claude Code:
  - CLI must already be installed/authenticated in the sandbox image or provider environment.
  - Use per-agent/per-issue session state when available.
  - Capture model/usage if CLI exposes it.

- Codex:
  - Treat as terminal coding agent with cwd, prompt, args, env, timeout.
  - Preserve session/result metadata in adapter state when available.

- OpenCode/OpenClaw:
  - `opencode_local` behaves like local CLI.
  - `openclaw_gateway` may remain HTTP/webhook-style and use a remote provider rather than Docker.

- Hermes:
  - Should be loaded as an external adapter/plugin where possible.
  - Sandbox policy must not assume Hermes internals; it should only require command/API invocation, env contract, and log/result parsing.

- Custom CLI/process:
  - Strongest sandbox value: isolate arbitrary commands with resource limits and redacted logs.
  - Config must separate command, args, env refs, cwd, timeout, artifact paths.

- MCP agents:
  - MCP server definitions are configuration, not automatic permission to execute tools.
  - Live MCP install/connect/execute remains approval-gated unless explicitly allowed by policy.
  - UI should show MCP capability as Planned/Disabled/Requires approval when not active.

## 7. Docker/VPS MVP

Use Docker as the first sandbox provider because it is available on typical VPS deployments and supports resource controls, log capture, filesystem isolation patterns, and controlled process lifecycle.

### 7.1 Container shape

- One container per heartbeat run attempt.
- Non-root user inside container.
- Read-only base image where possible.
- Dedicated writable workdir mounted or copied from execution workspace.
- Optional tmpfs for transient files.
- No Docker socket inside the container.
- Drop Linux capabilities by default.
- Apply seccomp/AppArmor profile where available.
- Disable privileged mode.
- Network policy defaults to disabled or restricted; enable only by run policy.

### 7.2 Resource controls

MVP policy fields:

- `timeoutSec`
- `graceSec`
- `memoryMb`
- `cpuShares` or `cpus`
- `pidsLimit`
- `diskQuotaMb` where provider can enforce it
- `maxLogBytes`
- `maxArtifactBytes`
- `networkMode`: disabled | restricted | default

The orchestrator enforces logical timeout/cancel. The provider enforces process/container limits. Both write visible status.

### 7.3 Workspace strategy

Initial modes:

- `shared_workspace`: use existing project workspace cautiously; highest contamination risk.
- `isolated_workspace`: copy or worktree per issue/run; preferred default for code tasks.
- `operator_branch`: controlled human/operator branch.
- `adapter_managed`: remote adapter owns workspace.
- `cloud_sandbox`: provider-managed workspace.

The Docker MVP should prefer `isolated_workspace` for agent code changes and fall back to `shared_workspace` only when explicitly configured.

### 7.4 Logs and artifacts

- Stream stdout/stderr/system events to the existing run log store.
- Store small status events in DB for UI timelines.
- Store artifacts through work products or attachment/object storage references.
- Artifact capture is allowlist-based:
  - PR URLs, branch names, diff files, screenshots, test reports, coverage reports, generated docs.
  - Never glob the entire workspace by default.
- Redact configured secret patterns before UI display.
- Preserve raw logs only in access-controlled run log storage, with truncation and retention settings.

## 8. Secret injection model

Principles:

- Store references, not values.
- Resolve as late as possible.
- Inject for the shortest lifetime possible.
- Record redacted manifest for audit.
- Deny by default when a requested secret is not allowed by company/agent/project policy.

Recommended flow:

1. Agent/project/runtime config includes secret refs such as `secret://company/github_token` or typed provider refs.
2. Runtime Orchestrator validates that the agent/run is allowed to request those refs.
3. Worker resolves refs into memory only after claiming the lease.
4. Provider injects secrets as env vars or mounted files.
5. Logs redact values and common derivatives.
6. Teardown deletes secret files and clears provider state.
7. Final run record stores only:
   - secret ref ids or labels
   - injection type: env/file
   - redaction policy version
   - success/failure, never plaintext

## 9. Future microVM/E2B-like abstraction

Docker is a pragmatic MVP, not the final isolation boundary for untrusted or enterprise workloads.

Future providers should fit the same `SandboxProvider` contract:

- `microvm_firecracker`
  - stronger tenant isolation
  - snapshot/restore for faster startup
  - reduced host attack surface compared with containers
  - more operational complexity around images, networking, storage, and metrics

- `e2b_remote`
  - managed remote sandboxes and templates
  - useful for cloud deployments or customers who do not want local Docker
  - requires careful data residency, secret, egress, and cost controls

- `custom_http_provider`
  - enterprise customer can integrate its own runner
  - Paperclip sends a signed job request and receives status/events/artifacts
  - useful when execution must happen inside customer infrastructure

Do not leak provider-specific primitives into agent adapters or issue UI. The UI should describe capabilities and state, not implementation internals.

## 10. UI/status plan

### 10.1 User-facing surfaces

- Agent detail: runtime capability summary and last sandbox health.
- Issue detail: current run card with sandbox state, resource policy, logs, artifacts, cancel button when allowed.
- Project/workspace settings: default execution workspace and sandbox policy.
- Instance settings: available providers and feature flags.
- Admin diagnostics: worker queue, leases, stuck jobs, cleanup failures.

### 10.2 Placeholder-safe labels

Use explicit badges:

- `Active`: implemented and enabled.
- `Preview`: UI/API skeleton exists; behavior is partial.
- `Planned`: design exists; no live behavior.
- `Disabled`: available but off by config or policy.
- `Requires approval`: action would cross deploy/spend/live-external or configured approval gate.

### 10.3 State vocabulary

- Preparing workspace
- Waiting for worker lease
- Starting sandbox
- Running adapter
- Cancelling
- Collecting artifacts
- Cleaning up
- Succeeded
- Failed
- Timed out
- Cleanup failed
- Needs approval

Default UI should show a plain-English summary first. Raw logs stay behind an expandable detail view.

## 11. Implementation roadmap

### Slice 1: design and contracts only

- Add/land this architecture document.
- Add issue document/handoff for LET-154.
- No runtime behavior change.
- No migrations.

### Slice 2: typed contracts and feature flag

- Add shared TypeScript types for `SandboxProvider`, `SandboxPolicy`, `RuntimeJob`, and UI status enums.
- Add config flag: `experimental.sandboxRuntime` default false.
- Add tests for schema validation and redaction helpers.

### Slice 3: Docker provider dry-run harness

- Implement `docker_local` provider behind the feature flag.
- Run only a safe smoke command in a disposable workspace.
- Capture logs/events/artifacts into existing run log/work product paths.
- Tests should mock Docker when daemon is unavailable.

### Slice 4: adapter integration for one CLI

- Start with one adapter, preferably generic `process` or `codex_local`, to validate lifecycle boundaries.
- Keep existing host-local path as default until sandbox runtime is explicitly enabled.
- Add cancellation/timeout tests.

### Slice 5: UI preview

- Add provider capability/status cards.
- Add issue run sandbox timeline with Preview/Disabled labels where behavior is not live.
- Add user-safe error and cleanup-failed states.

### Slice 6: expanded adapters and providers

- Claude Code, Hermes, OpenCode/OpenClaw, MCP-aware policies.
- MicroVM/E2B/custom provider prototypes only after Docker MVP proves the contract.

## 12. Security and risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Container escape or host filesystem access | Critical | no privileged containers, no Docker socket, non-root, cap drop, seccomp/AppArmor, minimal mounts, future microVM for higher-trust tiers |
| Secret leakage in logs/artifacts | Critical | secret refs only, just-in-time injection, redaction, artifact allowlists, no plaintext persisted |
| Hidden spend from remote providers | High | provider cost policy, budget hard-stop, explicit approval for paid external providers/spend |
| Run queue double execution | High | idempotency keys, atomic lease claims, executionRunId linkage, lease renewal/adoption rules |
| Workspace contamination | High | isolated workspace default, cleanup eligibility, explicit shared-workspace warnings |
| Infinite/long-running agents | High | timeoutSec, graceSec, cancellation, pids/memory/cpu/log/artifact limits |
| UI over-promises unimplemented controls | Medium | Preview/Planned/Disabled/Requires approval badges; no fake live status |
| Provider-specific lock-in | Medium | provider-neutral `SandboxProvider` and adapter-neutral lifecycle |
| Debuggability loss from redaction/truncation | Medium | structured events + raw controlled log store + hashes/summaries; redaction reasons visible |
| MCP/live external tool misuse | High | capability policy, approval gates, read-only/default-deny, explicit live action flags |

## 13. Test strategy

- Unit tests:
  - sandbox policy validation
  - lease claim/renew/expire behavior
  - secret manifest redaction
  - artifact allowlist matching
  - adapter command/request building

- Integration tests:
  - queue -> worker -> provider mock -> log/artifact result
  - timeout and cancel with grace period
  - cleanup failure is visible and does not mark run fully successful
  - duplicate lease attempts do not double-run

- UI tests:
  - status badges render correctly
  - placeholder labels appear for disabled/planned providers
  - raw logs are expandable, not primary

- Manual smoke for Docker MVP:
  - disposable command writes a small artifact
  - resource limits are visible in status
  - logs are captured and truncated/redacted as configured
  - teardown leaves no running container

## 14. Open questions for later implementation

1. Should the first queue be `runtime_jobs` or can existing `heartbeat_runs` carry enough queue state with fewer schema changes?
2. Should Docker image selection be per-company, per-project, or per-adapter in the first implementation?
3. What is the minimum useful network policy in local Docker without overbuilding enterprise egress controls?
4. Which adapter should be the first sandbox-backed integration: generic `process`, `codex_local`, or `claude_local`?
5. Should artifact storage use existing work products first, or a dedicated artifact table that later links into work products?

## 15. Research sources consulted

- Docker resource constraints: https://docs.docker.com/engine/containers/resource_constraints/
- Docker logging: https://docs.docker.com/engine/logging/
- Docker Engine security: https://docs.docker.com/engine/security/
- Firecracker microVM project: https://firecracker-microvm.github.io/
- E2B documentation: https://e2b.dev/docs
- Model Context Protocol architecture: https://modelcontextprotocol.io/docs/concepts/architecture
- OpenTelemetry logs concepts: https://opentelemetry.io/docs/concepts/signals/logs/
- Claude Code overview: https://docs.anthropic.com/en/docs/claude-code/overview
- OpenAI Codex CLI repository: https://github.com/openai/codex
- Hermes Agent documentation: https://hermes-agent.nousresearch.com/docs
