# Phase 3 Research - Multica Execution Backbone

## Research Complete

Phase 3 can be implemented as a thin RealTycoon2 execution layer over the existing Paperclip-derived runtime substrate.

## Relevant Existing Substrate

- `rt2V33TaskProfiles` already gives RT2 tasks stable identity through issue IDs.
- To-dos are already child issues of RT2 tasks.
- `issueWorkProducts` already stores deliverables and execution outputs.
- `execution_workspaces` and `workspace_runtime_services` already model runtime context and local/adapter-managed execution infrastructure.
- `doc/execution-semantics.md` already defines ownership, issue status, checkout, heartbeat, and recovery semantics.

## Recommended First Slice

Implement a dedicated RT2 execution-attempt table and service:

- one row per execution attempt
- company-scoped
- linked to RT2 task issue and optional to-do issue
- optional links to execution workspace, runtime service, run, and work product
- lifecycle state: `queued`, `claimed`, `running`, `completed`, `failed`, `cancelled`, `blocked`
- claim/start/complete/fail/retry API operations

This avoids overloading issue status while preserving compatibility with existing control-plane state.

## Implementation Notes

- Atomic claim should only update `queued` attempts into `claimed`.
- Starting an attempt should require a claimed attempt and record `startedAt`.
- Completing an attempt should require `running` and either link a work product or explicitly mark the deliverable missing.
- Retrying should create a new queued attempt with `retryOfAttemptId`.
- Task summaries should include the latest execution attempt.
- To-do summaries should include their latest execution attempt.

## Validation Architecture

1. Shared contract tests:
   - validates lifecycle state enum
   - validates transition payloads
2. Server route tests:
   - enqueue -> claim -> start -> complete
   - duplicate claim conflict
   - retry creates a new queued attempt
   - task detail returns execution summaries
3. UI component test:
   - renders task and to-do execution state
4. Integration gates:
   - targeted Vitest suites
   - `pnpm -r typecheck`

## Risks

- Adding too much runtime orchestration in this phase would collide with existing heartbeat behavior.
- Tying completion only to process exit would violate deliverable-first RT2 semantics.
- UI must not expose raw Paperclip runtime terms as the primary product language.

