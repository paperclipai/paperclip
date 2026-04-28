# Phase 3: Multica Execution Backbone - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24T13:51:00+09:00
**Phase:** 3-Multica Execution Backbone
**Areas discussed:** Execution model, Runtime integration, Queue and claim behavior, UI visibility, Safety and governance

---

## Execution Model

| Option | Description | Selected |
|--------|-------------|----------|
| Multica-inspired lifecycle layer | Implement enqueue/claim/start/complete semantics inside RT2 while reusing existing substrate | ✓ |
| Full Multica import | Pull in a separate runtime model and adapt the app around it | |
| Paperclip-only lifecycle | Keep issue status and heartbeat as the only execution model | |

**User's choice:** Auto-selected default through `$gsd-next` non-interactive advancement.
**Notes:** This aligns with `AGENTS.md`: Multica is a reference for lifecycle/runtime behavior, not the product identity.

---

## Runtime Integration

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse existing execution workspace/runtime records | Build RT2 execution linkage over `execution_workspaces`, `workspace_runtime_services`, heartbeat runs, and work products | ✓ |
| Build a separate execution database | Creates clearer separation but risks duplicate runtime truth | |
| Rewrite workspace-runtime first | Higher risk and outside the Phase 3 product boundary | |

**User's choice:** Auto-selected default through `$gsd-next` non-interactive advancement.
**Notes:** Prior Phase 1 and Phase 2 already stabilized Windows runtime/worktree behavior, so Phase 3 should preserve that substrate.

---

## Queue And Claim Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Atomic claim with attempt history | Prevent duplicate active execution and preserve retries as separate attempts | ✓ |
| Best-effort status update only | Simpler but unsafe for concurrent human/agent work | |
| One attempt per task forever | Loses retry history and failure evidence | |

**User's choice:** Auto-selected default through `$gsd-next` non-interactive advancement.
**Notes:** This supports RealTycoon2's deliverable-first and auditability requirements.

---

## UI Visibility

| Option | Description | Selected |
|--------|-------------|----------|
| Show RT2 lifecycle summary on task/to-do surfaces | Product-facing status stays in RT2 terms with advanced links to runtime details | ✓ |
| Expose raw Paperclip runtime records directly | Accurate but too control-plane-shaped for RT2 operators | |
| Backend only | Leaves Phase 3 invisible to users and weakens success criteria | |

**User's choice:** Auto-selected default through `$gsd-next` non-interactive advancement.
**Notes:** Product-facing copy should prefer RealTycoon2 terms while preserving drilldown access.

---

## Safety And Governance

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve company authz, approvals, and audit boundaries | Execution mutations are company-scoped and high-impact actions remain governed | ✓ |
| Trust internal execution routes | Faster but violates RT2 governance direction | |
| Defer all audit logging to Phase 4 | Too weak for execution lifecycle mutations | |

**User's choice:** Auto-selected default through `$gsd-next` non-interactive advancement.
**Notes:** Full event sourcing waits for Phase 4, but important lifecycle changes should still use existing activity/audit mechanisms.

---

## the agent's Discretion

- Exact storage shape for execution attempts.
- Exact UI placement inside existing RT2 task/detail surfaces.
- Exact retry metadata shape.

## Deferred Ideas

- Full append-only event stream.
- Full external Multica daemon or remote worker marketplace.
- Jarvis quality automation and reward economics.
