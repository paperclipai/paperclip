# Agent OS Technical Report for Paperclip

Date: 2026-04-08
Analyzed upstream: `rivet-dev/agent-os` at commit `0063cdccd1dcb1c8e211670cd05482d70d26a5c4` (`0063cdc`), dated 2026-04-06

## Executive summary

`agent-os` is not a competitor to Paperclip's core product. It is an execution substrate: an embedded, VM-like runtime for agents, tools, filesystems, and session orchestration. Paperclip is a control plane: company scoping, task hierarchy, approvals, budgets, activity logs, workspaces, and governance.

The strongest takeaway is not "copy agent-os wholesale." The strongest takeaway is that Paperclip could selectively use its runtime ideas to improve local agent execution safety, reproducibility, and portability while keeping all company/task/governance logic in Paperclip.

My recommendation is:

1. Do not merge agent-os concepts into the Paperclip core product model.
2. Do evaluate an optional `agentos_local` execution adapter or internal runtime experiment.
3. Borrow a few design patterns aggressively:
   - layered/snapshotted execution filesystems
   - explicit capability-based runtime permissions
   - a better host-tools bridge for controlled tool execution
   - a normalized session capability model for agent adapters
4. Do not import its workflow/cron/queue abstractions into Paperclip core until they are reconciled with Paperclip's issue/comment/governance model.

## What agent-os actually is

From the repo layout and implementation, `agent-os` is a mixed TypeScript/Rust system that provides:

- an `AgentOs` TypeScript API for creating isolated agent VMs
- a Rust kernel/sidecar that virtualizes filesystem, processes, PTYs, pipes, permissions, and networking
- an ACP-based session model for agent runtimes such as Pi, OpenCode, and Claude-style adapters
- a registry of WASM command packages and mount plugins
- optional host toolkits, cron scheduling, and filesystem mounts

The repo is substantial already:

- monorepo with `packages/`, `crates/`, and `registry/`
- roughly 1,200 files just across `packages/`, `crates/`, and `registry/`
- mixed implementation model: TypeScript public API plus Rust kernel/sidecar internals

## Architecture notes

### 1. Public runtime surface

The main API lives in `packages/core/src/agent-os.ts` and exports an `AgentOs` class with methods such as:

- `create()`
- `createSession()`
- `prompt()`
- `exec()`
- `spawn()`
- `snapshotRootFilesystem()`
- cron scheduling helpers

This is an execution API, not a coordination API.

### 2. Virtualized kernel model

The kernel is implemented in Rust under `crates/kernel/src/`. It models:

- virtual filesystem
- process table
- PTYs and pipes
- resource accounting
- permissioned filesystem access
- network permission checks

That gives `agent-os` a much stronger isolation story than Paperclip's current "launch a host CLI in a workspace" local adapter approach.

### 3. Layered filesystem and snapshots

The filesystem design is one of the most reusable ideas. `agent-os` uses:

- a bundled base filesystem
- a writable overlay
- optional mounted filesystems
- snapshot export/import for reusing root states

This is cleaner than treating every execution workspace as a mutable checkout plus ad hoc cleanup. It enables reproducible starting states and cheap isolation.

### 4. Capability-based permissions

The kernel-level permission vocabulary is strong and concrete:

- filesystem operations
- network operations
- child-process execution
- environment access

The Rust kernel defaults are deny-oriented, but the high-level JS API currently serializes permissive defaults unless the caller provides a policy. That is an important nuance: the primitive is security-minded, but the product surface is still convenience-first.

### 5. Host-tools bridge

`agent-os` exposes host-side tools via a toolkit abstraction (`hostTool`, `toolKit`) and a local RPC bridge. This is a strong pattern because it gives the agent explicit, typed tools rather than ambient shell access to everything on the host.

### 6. ACP session abstraction

The session model is more uniform than most agent wrappers. It includes:

- capabilities
- mode/config options
- permission requests
- sequenced session events
- JSON-RPC transport through ACP adapters

This is directly relevant to Paperclip because our adapter layer still normalizes each CLI agent in a fairly bespoke way.

## Paperclip anchor points

The most relevant current Paperclip surfaces for any future `agent-os` integration are:

- `packages/adapter-utils/src/types.ts`
  - shared adapter contract, session metadata, runtime service reporting, environment tests, and optional `detectModel()`
- `server/src/services/heartbeat.ts`
  - heartbeat execution, adapter invocation, cost capture, workspace realization, and issue-comment summaries
- `server/src/services/execution-workspaces.ts`
  - execution workspace lifecycle and git readiness/cleanup logic
- `server/src/services/plugin-loader.ts`
  - dynamic plugin activation, host capability boundaries, and runtime extension loading
- local adapters such as `packages/adapters/codex-local/src/server/execute.ts` and peers
  - current host-CLI execution model that an `agent-os` runtime experiment would complement or replace for selected agents

## What Paperclip can learn from it

### 1. A safer local execution substrate

Paperclip's local adapters currently run host CLIs in managed workspaces and rely on adapter-specific behavior plus process-level controls. That is pragmatic, but weakly isolated.

`agent-os` shows a path toward:

- running local agent tooling in a constrained runtime
- applying explicit network/filesystem/env policies
- reducing accidental host leakage
- making adapter behavior more portable across machines

Best use in Paperclip:

- as an optional runtime beneath local adapters
- or as a new adapter family for agents that can run inside ACP-compatible `agent-os` sessions

This fits Paperclip because it improves execution safety without changing the control-plane model.

### 2. Snapshotted execution roots instead of only mutable workspaces

Paperclip already has strong execution-workspace concepts, but they are repo/worktree-centric. `agent-os` adds a stronger "start from known lower layers, write into a disposable upper layer" model.

That could improve:

- reproducible issue starts
- disposable task sandboxes
- faster reset/cleanup
- "resume from snapshot" behavior for recurring routines
- safe preview environments for risky agent operations

This is especially interesting for tasks that do not need a full git worktree.

### 3. A capability vocabulary for runtime governance

Paperclip has governance at the company/task level:

- approvals
- budgets
- activity logs
- actor permissions
- company scoping

It has less structure at the runtime capability level. `agent-os` offers a clear vocabulary that Paperclip could adopt even without adopting the runtime itself:

- `fs.read`, `fs.write`, `fs.mount_sensitive`
- `network.fetch`, `network.http`, `network.listen`, `network.dns`
- child process execution
- env access

That vocabulary would improve:

- adapter configuration schemas
- policy UIs
- execution review surfaces
- future approval gates for governed actions

### 4. Typed host tools instead of shelling out for everything

Paperclip's plugin system and adapters already have the beginnings of a controlled extension surface. `agent-os` reinforces the value of exposing capabilities as typed tools rather than raw shell access.

Concrete Paperclip uses:

- board-approved toolkits for sensitive operations
- company-scoped service tools
- plugin-defined tools with explicit schemas
- safer execution for common actions like git metadata inspection, preview lookups, deployment status checks, or document generation

This aligns well with Paperclip's governance story.

### 5. Better adapter normalization around sessions and capabilities

Paperclip's adapter contract already supports execution results, session params, environment tests, skill syncing, quota windows, and optional `detectModel()`. But much of the per-agent behavior is still adapter-specific.

`agent-os` suggests a cleaner normalization target:

- a standard capability map
- a consistent event stream model
- explicit mode/config surfaces
- explicit permission request semantics

Paperclip does not need ACP everywhere, but it would benefit from a more formal internal session capability model inspired by this.

### 6. On-demand heavy sandbox escalation

One of the best architectural choices in `agent-os` is that it does not pretend every workload fits the lightweight runtime. It has a sandbox extension for workloads that need a fuller environment.

Paperclip can adopt that philosophy directly:

- lightweight execution by default
- escalate to full worktree / container / remote sandbox only when needed
- keep the escalation explicit in the issue/run model

That is better than forcing all tasks into the heaviest environment up front.

## What does not fit Paperclip well

### 1. Its built-in orchestration primitives overlap the wrong layer

`agent-os` includes cron/session/workflow style primitives inside the runtime package. Paperclip already has higher-level orchestration concepts:

- issues/comments
- heartbeat runs
- approvals
- company/org structure
- execution workspaces
- budget enforcement

If Paperclip copied `agent-os` cron/workflow/queue ideas directly into core, we would likely duplicate orchestration across two layers. That would blur ownership and make debugging harder.

Paperclip should keep orchestration authoritative at the control-plane layer.

### 2. It is not company-scoped or governance-native

`agent-os` is runtime-first, not company-first. It has no native concepts for:

- company boundaries
- board/operator actor types
- audit logs for business actions
- issue hierarchy
- approval routing
- budget hard-stop behavior

Those are Paperclip's differentiators. They should not be displaced by runtime abstractions.

### 3. It introduces meaningful implementation complexity

Adopting `agent-os` deeply would add:

- Rust build/runtime complexity
- sidecar lifecycle management
- new failure modes across JS/Rust boundaries
- more packaging and platform compatibility work
- another abstraction layer for debugging already-complex local adapters

This is justified only if we want stronger local isolation or portability. It is not justified as a general refactor.

### 4. Its security model is not a drop-in governance solution

The permission model is good, but it is low-level. Paperclip would still need to answer:

- who can authorize a capability
- how approval decisions are logged
- how policies are scoped by company/project/issue/agent
- how runtime permissions interact with budgets and task status

In other words, `agent-os` can supply enforcement primitives, not the control policy system itself.

### 5. The agent compatibility story is still selective

The repo is explicit that some runtimes are planned, partial, or still being adapted. In practice this means:

- good ideas for ACP-native or compatible agents
- less certainty for every CLI agent we support today
- real integration work for Codex/Cursor/Gemini-style Paperclip adapters

So the main near-term value is not universal replacement. It is selective use where compatibility is strong.

## Concrete recommendations for Paperclip

### Recommendation A: prototype an optional `agentos_local` adapter

This is the highest-value experiment.

Goal:

- run one supported agent type inside `agent-os`
- keep Paperclip heartbeat/task/workspace/budget logic unchanged
- evaluate startup time, isolation, transcript quality, and operational complexity

Good first target:

- `pi_local` or `opencode_local`

Why not start with Codex:

- Paperclip's Codex adapter is already important and carries repo-specific behavior
- `agent-os`'s Codex story is present in the registry/docs, but the safest path is to validate the runtime on a less central adapter first

Success criteria:

- heartbeat can invoke the adapter reliably
- session resume works across heartbeats
- Paperclip still records logs, summaries, cost metadata, and issue comments normally
- runtime permissions can be configured without breaking common tasks

### Recommendation B: adopt capability vocabulary into adapter configs

Even without using `agent-os`, Paperclip should consider standardizing adapter/runtime permissions around a vocabulary like:

- filesystem
- network
- subprocess/tool execution
- environment access

This would improve:

- schema-driven adapter UIs
- future approvals
- observability
- policy portability across adapters

### Recommendation C: explore snapshot-backed execution workspaces

Paperclip should evaluate whether some execution workspaces can be backed by:

- a reusable lower snapshot
- a disposable upper layer
- optional mounts for project data or artifacts

This is most valuable for:

- non-repo tasks
- repeatable routines
- preview/test environments
- isolation-heavy local execution

It is less urgent for full repo editing flows that already benefit from git worktrees.

### Recommendation D: strengthen typed tool surfaces

Paperclip plugins and adapters should continue moving toward explicit typed tools over ad hoc shell access. `agent-os` confirms that this is the right direction.

This is a good fit for:

- plugin tools
- workspace runtime services
- governed operations that need approval or auditability

### Recommendation E: do not import runtime-level workflows into Paperclip core

Paperclip should not copy `agent-os` cron/workflow/queue concepts into core orchestration yet.

If we want them later, they must map cleanly onto:

- issues
- comments
- heartbeats
- approvals
- budgets
- activity logs

Without that mapping, they would create a second orchestration system inside the product.

## A practical integration map

### Best near-term fits

- optional local adapter runtime
- runtime capability schema
- typed host-tool ideas for plugins/adapters
- snapshot ideas for disposable execution roots

### Medium-term fits

- stronger session capability normalization across adapters
- policy-aware runtime permission UI
- selective ACP-inspired event normalization

### Poor fits right now

- moving Paperclip orchestration into agent-os workflows
- replacing company/task/governance models with runtime constructs
- making Rust sidecars a mandatory dependency for all local execution

## Bottom line

`agent-os` is useful to Paperclip as an execution technology reference, not as a product model.

Paperclip should treat it the same way it treats sandboxes or agent CLIs:

- execution substrate underneath the control plane
- optional where the tradeoff is worth it
- never the source of truth for company/task/governance state

If we do one thing from this report, it should be a narrowly scoped `agentos_local` experiment plus a design pass on capability-based runtime permissions. Those two ideas have the best upside and the lowest architectural risk.
