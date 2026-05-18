# Versioned Agent Memory — Implementation Plan

- **Parent**: LET-407 (this lane is architecture-only; the issues below are the implementation lanes)
- **Status**: Drafted, **not yet created in Paperclip**. LET-407 closes when QA Validator + Claude Reviewer PASS the architecture artifacts; the EAOS CEO loop (LET-161) is then expected to file these child issues into the active backlog.
- **Companion**: [ADR](../adr/0001-versioned-agent-memory.md), [Contract](versioned-agent-memory-contract.md), [Validation Contract](versioned-agent-memory-validation-contract.md), [Integration Notes](versioned-agent-memory-integration.md).

## Why these aren't filed yet

Per LET-407 instruction, the architecture deliverable is the binding artifact. The EAOS CEO loop owns sequencing and parallel-fan-out into the executor team (Codex Executor / Hermes Executor for implementation, QA Validator + Claude Reviewer for verification). Filing the child issues from this lane would pre-empt that sequencing and could push the active workstream cap (6) over the limit. The CEO loop should pick the next bounded slice and file these as appropriate.

If the CEO loop asks this lane to file them directly, the section below is the spec-ready text.

## Dependency graph

```
LET-407 (this lane)                  — architecture, must PASS first
   │
   ├── LET-407-A  Schema + service + REST routes + unit/service/route tests
   │     │       (Codex or Hermes Executor; behind MEMORY_API_ENABLED=false)
   │     │
   │     ├── LET-407-B  MCP tools + capabilities  (depends on A)
   │     │
   │     ├── LET-407-C  Mission Control UI panel  (depends on A; UI specialty)
   │     │
   │     └── LET-407-D  Replay endpoint + heartbeat run events + golden fixtures (depends on A)
   │
   └── LET-407-E  Compliance export endpoint (depends on A; can run in parallel with C/D)

PRODUCTION-ENABLE gate (separate CEO-approved deploy issue; NOT a child here)
```

A, B, C, D, E each must land their own QA Validator PASS and Claude Reviewer PASS before merging to master per the project's pullRequestPolicy.

## File overlap matrix

| Issue | Adds / changes | Risk of overlap with active lanes |
|---|---|---|
| 407-A | `packages/db/src/schema/agent_memory.ts`, `agent_memory_revisions.ts`, `packages/db/src/migrations/0090_agent_memory.sql`, `packages/shared/src/validators/agent_memory.ts`, `server/src/services/agent_memory.ts`, `server/src/services/agent_memory_redaction.ts`, `server/src/routes/agent_memory.ts`, tests | LOW — fresh namespace |
| 407-B | `packages/mcp-server/src/tools.ts` (extend existing aggregator) and new `packages/mcp-server/src/tools/agent_memory.ts`; new `packages/shared/src/agent-memory-capabilities.ts` + `packages/shared/src/__tests__/agent-memory-capabilities.test.ts`; re-export edits in `packages/shared/src/index.ts` | LOW |
| 407-C | `ui/src/features/agent-memory/` (new feature folder), route registration in `ui/src/pages/` and `ui/src/eaos/` shell as needed | MED — coordinate with LET-326/LET-337 dashboard owners to avoid touching shared dashboard shell |
| 407-D | `server/src/replay/agent_memory.ts`, `heartbeat_run_events` event-type enum, fixtures | LOW–MED — touches replay code if any |
| 407-E | `server/src/routes/agent_memory_export.ts` | LOW |

> **Repo-path note.** Earlier drafts referenced `apps/mcp-paperclip/`, `frontend/`, and a `packages/shared/src/capabilities/` directory; none of those exist in this repo (verified against `master` and this branch as of 2026-05-18 by reading `packages/shared/src/` and `ui/src/`). The canonical locations are:
>
> - `packages/mcp-server/` for MCP tools (the new `packages/mcp-server/src/tools/agent_memory.ts` for LET-407-B).
> - `ui/` for the React app, with a new `ui/src/features/agent-memory/` folder owned by LET-407-C — create it as part of that issue.
> - `packages/shared/src/agent-capabilities.ts` and `packages/shared/src/capability-apply.ts` are the existing capability modules; neither is a registry of named gate-capabilities with default-holder roles. The memory ACL gates therefore live in a NEW sibling module `packages/shared/src/agent-memory-capabilities.ts`, re-exported from `packages/shared/src/index.ts` (contract §6.1).
>
> If at implementation time the MCP server, UI tree, or shared package layout has moved again, the implementer must update this matrix and contract §6.1 in the same PR rather than silently writing files into a stale path.

Migration number `0090` is reserved here; if the migration counter has advanced by the time 407-A is filed, the implementation issue must pick the next free number and update this doc as part of the PR.

## Issues to file (spec text — ready to paste)

### LET-407-A — [IMPL] Agent Memory: schema, service, REST routes, tests (live flag OFF)

> Implement the Versioned Agent Memory data layer and HTTP surface per LET-407 contract.
>
> **Scope**
> - Add Drizzle schema for `agent_memory` and `agent_memory_revisions` exactly as specified in the LET-407 contract spec §1.1–§1.2.
> - Generate migration via `drizzle-kit generate` (do not hand-edit the inline SQL from the doc; the doc is reference only).
> - Add Zod schemas in `packages/shared/src/validators/agent_memory.ts` exactly as specified in contract §2.
> - Add service `server/src/services/agent_memory.ts` implementing the interface in contract §4.
> - Add `server/src/services/agent_memory_redaction.ts` exporting `sanitizeMemoryJson` (two-pass: `sanitizeRecord` + per-string-leaf `redactSensitiveText`) and `sanitizeTextWithFlag` per contract §7.7. This is the only redaction-related new file; `server/src/redaction.ts` is reused **unchanged**. The helper returns disjoint `redactedPaths` (pass-1 `sanitizeRecord` hit: key-name branch OR JWT value-shape branch) and `jsonTextRedactedPaths` (pass-2 `redactSensitiveText` rewrite) arrays.
> - Add routes `server/src/routes/agent_memory.ts` implementing contract §3, including the capability guard wired against `MEMORY_CAPABILITY_DEFAULT_HOLDERS` (registered by LET-407-B, but the guard call sites are in this lane so 407-A's route tests assert 403 behavior even before 407-B lands by stubbing the holder map).
> - Wire activity_log emission per contract §8.
> - Wire all redaction rules per contract §7. Reuse `server/src/redaction.ts` unchanged; persist both `redactedPaths` and `jsonTextRedactedPaths` from the new `agent_memory_redaction.ts` helper (contract §7.7); 422 body matches contract §4.1 step 5.
> - Add unit, service, route, migration tests per validation contract §2, §3, §4, §5.
> - Gate the routes behind `MEMORY_API_ENABLED` env (default `false`); when off, return 404.
> - Apply migration **locally only**. Production deploy is a separate CEO-approved gate.
>
> **Out of scope**: MCP tools (LET-407-B), UI (LET-407-C), replay (LET-407-D), export (LET-407-E), production enable.
>
> **Acceptance**: QA Validator PASS (all tests in validation contract §2–§5 present and green; `pnpm typecheck` clean) + Claude Reviewer PASS.
>
> **Branch**: `enterprise-agent-os/LET-407-A`.
>
> **Boundaries**: No production migration apply, no deploy, no live flag flip.

### LET-407-B — [IMPL] Agent Memory: MCP tools + capabilities

> Add the six MCP tools listed in LET-407 contract §5 to the existing `packages/mcp-server` package (register from `packages/mcp-server/src/tools.ts`; implementation in a new `packages/mcp-server/src/tools/agent_memory.ts`). Register capabilities per §6.
>
> **Blocked by**: LET-407-A merged.
>
> **Scope**
> - Implement tools `paperclipUpsertAgentMemory`, `paperclipListAgentMemory`, `paperclipGetAgentMemoryRevisions`, `paperclipDiffAgentMemoryRevisions`, `paperclipRollbackAgentMemory`, `paperclipForgetAgentMemory`.
> - Register capabilities `memory.read`, `memory.write`, `memory.write_company`, `memory.rollback`, `memory.forget`, `memory.forget.hard`, and `memory.export` in the **new** module `packages/shared/src/agent-memory-capabilities.ts` (constants tuple `MEMORY_CAPABILITIES`, holder map `MEMORY_CAPABILITY_DEFAULT_HOLDERS`, guard `isMemoryCapability`) per contract §6.1. Add `packages/shared/src/__tests__/agent-memory-capabilities.test.ts`. Re-export from `packages/shared/src/index.ts` next to the existing `agentCapability*` exports. The existing `packages/shared/src/agent-capabilities.ts` and `packages/shared/src/capability-apply.ts` files are NOT modified — the memory registry is a sibling module so route guards and MCP tools can depend on it without coupling to the MCP-config schema. (`memory.export` is registered here even though it is exercised by 407-E, so all memory capabilities land in a single registry edit.)
> - Add MCP tool tests per validation contract §6.
> - All tools surface `{ ok:false, code:"REDACTION_REQUIRED", redactedPaths, jsonTextRedactedPaths, textRedactionApplied }` for redaction-blocked writes (contract §4.1 step 5 / §7.2).
>
> **Out of scope**: UI, replay, production enable.
>
> **Acceptance**: QA Validator PASS + Claude Reviewer PASS. Smoke run against a local Paperclip instance invokes each tool successfully (synthetic data).
>
> **Branch**: `enterprise-agent-os/LET-407-B`.

### LET-407-C — [DESIGN+IMPL] Agent Memory: Mission Control panel

> Add the Memory panel to Mission Control / Command Center per LET-407 integration notes §1.
>
> **Blocked by**: LET-407-A merged.
>
> **Scope**
> - New components under `ui/src/features/agent-memory/` (the `features/` folder does not yet exist under `ui/src/`; create it as part of this issue alongside the new feature folder).
> - "Memory" tab on agent detail, company detail, and run detail pages.
> - Diff modal reusing existing markdown diff component.
> - Rollback button visible only to callers with `memory.rollback` capability.
> - `private_prompt_data:true` rows show placeholder + 🔒 only.
> - `visibility=agent_only` rows excluded from any UI view.
> - Screenshots in `docs/pr-screenshots/let-407-c/` using synthetic seed data only.
>
> **Boundaries**: Do not modify dashboard shell components owned by LET-326/LET-337 lanes; if a shared change is needed, file a coordination comment on the LET-326 thread first.
>
> **Out of scope**: replay UI, export UI, production enable.
>
> **Acceptance**: QA Validator PASS + Claude Reviewer PASS + screenshot review (no real customer data).
>
> **Branch**: `enterprise-agent-os/LET-407-C`.

### LET-407-D — [IMPL] Agent Memory: replay endpoint + heartbeat run events + golden fixtures

> Implement the replay surface per LET-407 integration notes §2.
>
> **Blocked by**: LET-407-A merged.
>
> **Scope**
> - `GET /api/runs/:runId/memory?asOf=` returning replay-coherent set per integration §2.2.
> - Add `memory_read` / `memory_write` event types to `heartbeat_run_events` and emit from the runtime hot path per integration §3.
> - Golden fixtures under `server/src/replay/__fixtures__/agent_memory/` per validation contract §7.
> - `forgottenLater:true` marker logic per integration §2.3.
>
> **Out of scope**: UI (separate replay UI lane), export, production enable.
>
> **Acceptance**: QA Validator PASS + Claude Reviewer PASS; replay fixtures byte-equal to goldens; runtime change does not regress heartbeat tests.
>
> **Branch**: `enterprise-agent-os/LET-407-D`.

### LET-407-E — [IMPL] Agent Memory: compliance export endpoint

> Add `GET /api/companies/:companyId/memory/export?subject=` per LET-407 integration notes §5.2.
>
> **Blocked by**: LET-407-A merged.
>
> **Scope**
> - Subject-based search across `value_text` (gin_trgm) and `value_json` keys/values matching the subject identifier.
> - Output bundle includes full revision history per matching entry (respecting visibility for caller).
> - Capability `memory.export` is registered by LET-407-B (see contract §6 and 407-B scope). LET-407-E only enforces the capability at the route layer; it does not edit the registry itself.
> - Tests for subject match, redaction enforcement in output, capability gate.
>
> **Out of scope**: UI for export, production enable.
>
> **Acceptance**: QA Validator PASS + Claude Reviewer PASS.
>
> **Branch**: `enterprise-agent-os/LET-407-E`.

## Sequencing & parallelism

- **Serial gate**: 407-A must merge first.
- **After A**: B, C, D, E can run in parallel up to the active-workstream cap (6 per LET-161).
- **Suggested fan-out**: B + C + D in parallel (3 implementation lanes) + reviewers on each (2 review lanes) = 5 active. E can wait one phase to stay under the cap.

## What we are not creating

- No "live flag flip" issue is filed here. That is a separate CEO-approved deploy gate, owned by Release Manager, and explicitly outside LET-407's scope.
- No file-based memory bridge from `MEMORY.md` — explicitly out of scope.
- No vector / embedding memory — separate roadmap item, not in this lane.

## Handoff back to CEO loop

When LET-407 closes (QA Validator + Claude Reviewer PASS), the CEO loop should:

1. Review this implementation plan.
2. Decide whether to file all five issues at once or sequence them.
3. Assign LET-407-A to Codex Executor or Hermes Executor and proceed.

The architecture artifacts on branch `enterprise-agent-os/LET-407` are the binding spec. Any deviation in implementation must come back through an ADR amendment, not a silent code change.
