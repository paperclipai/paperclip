# Gbrain Context For Codex And Claude

Date: 2026-06-09

## Summary

Codex and Claude local adapters should use Paperclip memory before each heartbeat so agents do not depend only on a live session transcript. The existing product direction is already captured in `doc/memory-landscape.md` and `doc/plans/2026-03-17-memory-service-surface-api.md`: Paperclip should own company/agent binding, provenance, operation logging, and usage accounting, while the memory provider owns storage, indexing, extraction, and ranking.

In this checkout, `packages/gbrain-vault`, `packages/gbrain-mcp`, and `packages/paperclip-gbrain-bridge` currently contain no checked-in source files. They are placeholders or stale package directories, so a real gbrain integration must either restore those package sources or consume an external gbrain service through a new provider adapter.

## Immediate Adapter Fix

Codex should receive the same task-context prompt material as Claude. Claude already includes `context.paperclipTaskMarkdown` in the prompt sequence; Codex did not. This makes Codex easier to hydrate from future memory output without requiring a different adapter path.

## Target Flow

1. Resolve memory binding for the run:
   - company default binding
   - agent override when present
   - no cross-company memory

2. Build a `MemoryScope`:
   - `companyId`
   - `agentId`
   - `projectId` when available
   - `issueId` / `taskId` when available
   - `runId`
   - optional `sessionKey`

3. Run pre-heartbeat recall:
   - operation: `query`
   - intent: `agent_preamble`
   - query input from issue title, description, recent comments, goal/project context, and wake reason
   - top-K capped and budgeted

4. Convert recall output into `paperclipTaskMarkdown` or a dedicated `paperclipMemoryMarkdown` context field:
   - include source handles and provenance
   - keep snippets concise
   - label it as remembered context, not current issue truth

5. Inject memory into local adapters:
   - Claude: current prompt path already accepts `paperclipTaskMarkdown`
   - Codex: prompt path now also accepts `paperclipTaskMarkdown`
   - future improvement: split task context from memory context if UI/metrics need separate counters

6. Capture after run:
   - operation: `capture`
   - source: `run`
   - payload: run summary, final comment, artifacts, and structured result excerpts
   - provenance back to company, agent, issue, and run

7. Expose inspectability:
   - recent memory operations
   - query snippets used for a run
   - source backlinks to issues/comments/runs
   - memory cost and latency

## Minimal Implementation Phases

### Phase 1: Provider Restoration

Restore or recreate the missing gbrain provider source. The provider should implement the memory adapter surface from `doc/plans/2026-03-17-memory-service-surface-api.md` and support at least `query`, `capture`, `list`, `get`, and `forget`.

### Phase 2: Server Hydration Hook

Add a pre-run hydration step in the heartbeat service before adapter invocation. Store the operation log and attach the resulting markdown bundle to the adapter context.

### Phase 3: Post-Run Capture Hook

After heartbeat completion, submit a capture request with run output and issue/result provenance. Failures should be logged as memory operation failures and must not fail the heartbeat itself.

### Phase 4: UI And Tools

Add operator-facing memory browse/inspect surfaces and agent tools for explicit `memory.search` and `memory.note`.

## Guardrails

- Memory is advisory context. Current issue comments, documents, and wake payloads remain authoritative.
- Retrieval must be company-scoped and agent-aware.
- Silent broad capture should stay off until the operator enables it.
- Memory operation failures should degrade gracefully and never block core task execution.
- Prompt hydration must be capped to avoid hidden token burn.
