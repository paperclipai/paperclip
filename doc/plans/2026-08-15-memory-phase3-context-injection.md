# PRA-634 Phase 3 Implementation — Context Injection (async warm-up)

**Heartbeat run**: 80e15f64-8263-4975-a9cf-b235552e21f1
**Date**: 2026-08-15
**Author**: CTO
**Status**: implemented + tested — pending live-run verification

## What Was Done

### 1. New service: `server/src/services/memory-context-injection.ts`

Implements the Phase 3 async warm-up design from
`doc/plans/2026-08-15-memory-workstream-b-v0.4.0.md` §3:

- `buildMemoryPreamble(snippets)` — formats `MemorySnippet[]` into a
  markdown preamble block (`=== Context from Past Work ===` … `=== End Context ===`)
  with relevance scores, source refs, summaries, and 500-char text truncation.
- `warmUpAgentMemory(db, companyId, agentId, scope, config?)` — resolves the
  agent's memory binding (company default → agent override), queries the
  builtin_pgvector adapter scoped to the agent, and returns a preamble or a
  graceful-skip result. **Never throws**; all failures degrade to
  `status: "error" | "skipped_*"` with a logged warning. Enforced 3s timeout.

### 2. Heartbeat integration: `server/src/services/heartbeat.ts`

- `executeRun()` now starts the memory warm-up **asynchronously** right after
  the paperclip wake/task context is built (parallel with workspace setup,
  skill resolution, secret binding — exactly the "async warm-up, pre-fetched
  not inline" constraint).
- The warm-up promise is stored in a local `memoryWarmUpPromise` variable
  (NOT on the context object, so it is not persisted to `contextSnapshot`).
- Right before `adapter.execute()`, the promise is awaited so the preamble is
  guaranteed present in the agent context before execution starts.
- On failure/timeout the heartbeat proceeds without memory (logged, non-fatal).
- When warm-up succeeds, `context.paperclipMemoryPreamble` is set; it is
  visible to the agent alongside `paperclipTaskMarkdown` / `paperclipWake`.

### 3. Test cleanup: `server/src/services/memory-bindings.test.ts`

Fixed the two pre-existing type errors (missing `enabled` / `priority` fields
required by the zod-inferred types). Typecheck for the whole server package is
now clean.

### 4. New tests: `server/src/services/memory-context-injection.test.ts`

8 unit tests for `buildMemoryPreamble` (empty/null input, single + multiple
snippets, score rendering, source refs, summaries, 500-char truncation,
ordering).

## Verification

- `npx tsc --noEmit` — clean (0 errors across server package)
- `npx vitest run src/services/memory-context-injection.test.ts src/services/memory-bindings.test.ts` — 32/32 pass
- `npx vitest run src/__tests__/heartbeat-model-profile.test.ts src/__tests__/heartbeat-run-summary.test.ts` — 13/13 pass
- `heartbeat-comment-wake-batching.test.ts` — skipped (embedded PostgreSQL test DB failed to start; environment issue, unrelated to this change)

## Remaining Work (Phase 3 +)

- [ ] Post-run capture hook (auto-capture run summary/decisions into memory)
- [ ] Issue comment/document capture hooks (opt-in)
- [ ] Agent-level memory tools (`memory.search`, `memory.note`, `memory.forget`)
- [ ] Live-run verification: seed a binding + memory record, confirm preamble
      appears in a real heartbeat context
- [ ] Phase 4: Memory browser UI (separate workstream)
- [ ] Phase 5: Company knowledge base (curated/reviewed/versioned)

## Files Touched (this heartbeat)

| File | Change |
|------|--------|
| `packages/adapters/hermes/src/server/execute.ts` | Wire `paperclipMemoryPreamble` into `buildPrompt()` — read from context, expose as template var, include in joined prompt sections |
| `packages/adapters/hermes/src/gateway/server/execute.ts` | Same for gateway `buildInput()` |
| `packages/adapters/acpx-local/src/server/execute.ts` | Same for acpx-local prompt assembly |
| `packages/adapters/claude-local/src/server/execute.ts` | Same for claude-local |
| `packages/adapters/codex-local/src/server/execute.ts` | Same for codex-local |
| `packages/adapters/gemini-local/src/server/execute.ts` | Same for gemini-local |
| `packages/adapters/grok-local/src/server/execute.ts` | Same for grok-local |
| `packages/adapters/opencode-local/src/server/execute.ts` | Same for opencode-local |
| `packages/adapters/pi-local/src/server/execute.ts` | Same for pi-local |
| `packages/adapters/cursor-cloud/src/server/execute.ts` | Same for cursor-cloud |
| `packages/adapters/cursor-local/src/server/execute.ts` | Same for cursor-local |
| `packages/adapters/hermes/src/server/prompt-rendering.test.ts` | 3 new tests: injection, template var, absent |
