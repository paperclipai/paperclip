# Jarvis Cross-System Orchestration

## Goal
Make Jarvis the always-on executive orchestrator for Paperclip, Hermes, Pi, and OpenCode: it reads from all four, synthesizes one CEO view, routes work to the best system, and can execute approved work autonomously under standing approval.

## Scope
- Jarvis reads, summarizes, routes, and executes across the four systems.
- Paperclip remains the operational source of truth for tasks, approvals, and audit logs.
- Hermes handles strategic reasoning and planning.
- Pi handles implementation and test/patch loops.
- OpenCode handles code execution/editing tasks.
- Jarvis keeps a unified cross-system run log and trace IDs.

## Decisions
- **Authority model:** the user is final authority; Jarvis has standing approval for normal work.
- **Safety model:** a fixed immutable denylist blocks destructive, secret, payment, legal, public-release, and production-risk actions; there is no override path in this first version.
- **State model:** Paperclip stores the durable record of tasks, approvals, and cross-system actions.
- **Orchestration model:** Jarvis is the brain; adapters are tools.

## Architecture
### Jarvis core
Owns decision making, prioritization, policy checks, and synthesis.

### System adapters
- **Paperclip adapter** — read/write tasks, approvals, audit logs, and workflow state.
- **Hermes adapter** — strategy briefs, scenario analysis, causal reasoning, and risk framing.
- **Pi adapter** — implementation work, patches, tests, and structured execution.
- **OpenCode adapter** — code execution and code-edit operations.

### Policy layer
Evaluates each action before execution, applies the denylist, records the reason for any refusal, and tags approved actions with trace IDs.

### Unified trace log
Every multi-system action gets one trace ID, one summary, and one rollback hint, all persisted back to Paperclip.

## Workflows
### 1) Briefing loop
Jarvis pulls recent state from Paperclip plus outputs from Hermes, Pi, and OpenCode, then produces one executive summary with:
- what changed
- what is risky
- what needs attention
- what to do next

### 2) Routing loop
Jarvis chooses the best system for each work item:
- Paperclip for governance/state
- Hermes for planning and synthesis
- Pi for implementation
- OpenCode for direct code execution/editing

### 3) Execution loop
For allowed actions, Jarvis dispatches the work immediately and records the result. For denylisted actions, Jarvis stops, explains why, and logs the refusal.

### 4) Audit loop
Every action writes a Paperclip audit entry containing actor, target system, input intent, output summary, approval basis, and rollback hint.

## Interfaces
Each adapter should expose the same conceptual operations:
- `read()`
- `plan()`
- `execute()`
- `report()`

This keeps Jarvis orchestration simple and makes each integration swappable.

## Error handling
- If an adapter is offline, Jarvis falls back to partial synthesis and marks the missing source explicitly.
- If execution fails, Jarvis records the failure in Paperclip and retries only when the action is safe and idempotent.
- If a request hits the denylist, Jarvis returns a clear refusal with the blocked rule.
- If Paperclip is unavailable, Jarvis preserves the action locally in a queue until state can be written back.

## Testing
- Unit tests for policy/denylist decisions.
- Adapter contract tests for Paperclip, Hermes, Pi, and OpenCode.
- Integration tests for briefing, routing, and execution loops.
- Regression test that audit records are written for every successful and blocked action.
- Smoke test that the system can summarize from all sources and route one task end-to-end.

## Done When
- Jarvis can read/summarize across Paperclip, Hermes, Pi, and OpenCode.
- Jarvis can route tasks to the right system.
- Jarvis can execute approved actions autonomously.
- Paperclip stores the durable task/approval/audit record.
- The denylist still blocks irreversible high-risk actions.
