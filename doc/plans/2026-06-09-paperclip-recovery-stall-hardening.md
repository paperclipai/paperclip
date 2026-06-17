# Paperclip Recovery Stall Hardening Handoff

Date: 2026-06-09

## Scope

Hardened the recovery path that was creating more blocked recovery work than source project work. The change keeps recovery/meta issues visible, but prevents issue-graph liveness from treating recovery issues as source issues that need another supervisor recovery.

## Implemented

- Added a centralized recovery-origin classifier for harness liveness, productivity review, stranded issue recovery, and stale active-run evaluation origins.
- Updated issue-graph liveness classification to skip recovery/meta origin issues and to treat them as explicit waiting paths when evaluating source issue blockers.
- Updated recovery service queries so source issue scanning excludes recovery/meta origins while still mapping open recovery issues as waiting paths.
- Broadened closed-recovery blocker reconciliation so `done` or `cancelled` recovery/meta issues are pruned from source issue blocker relations, including `stranded_issue_recovery` blockers.
- Added focused classifier and embedded-service tests for the recovery-of-recovery guard.
- Added regression coverage for the live RAY-631/RAY-689 class where a cancelled recovery issue remained attached as a source blocker.
- Added `/RAY/ai-os` cockpit view for runtime status, blocked source work, recovery blocks, approval choices, model/recovery route state, next action, and recent runs.
- Added a no-wake audit-comment path: `POST /issues/:id/comments` with `reopen: false` no longer reopens a closed issue, resumes scheduled retries, or wakes an assignee.
- Added Codex usage-limit detection so GPT-5.3-Codex-Spark quota errors are recorded as `codex_usage_limit`, not transient upstream failures that should be retried immediately.
- Corrected the local Paperclip LaunchAgent goal-mode profile to keep only `route-preview`, `dry-run`, and one allowlisted `run-next` smoke request. It still does not enable run-all.

## Live Cleanup

Cleaned stale recovery/meta blocks and cancelled stale recovery runs on the local goal-mode Paperclip instance now served by the persistent LaunchAgent at `http://127.0.0.1:3101`.

Final observed cockpit state:

- Runtime restart state: clean
- Pending migrations: 0
- Live runs: 0
- Recovery blocks: 0
- Retry automation: off
- Run-next: allowlisted only
- Remaining blocked source work: RAY-632, the Health Exercise schedule/reminder issue
- Source issues repaired during cleanup: RAY-631, RAY-692, RAY-696, and RAY-698 are done with no stale blockers.
- Duplicate supervisor wrappers cancelled during cleanup: RAY-697 and RAY-699.
- Follow-up source workflow bug found by goal mode: RAY-689, stale cancelled recovery blockers. Code fix is implemented and the live DB has been reconciled.

## Verification

- `pnpm vitest run server/src/__tests__/recovery-classifiers.test.ts server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts`
- `pnpm vitest run server/src/__tests__/recovery-classifiers.test.ts server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts server/src/__tests__/health.test.ts server/src/__tests__/dev-server-status.test.ts`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm vitest run server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts server/src/__tests__/recovery-classifiers.test.ts`
- `pnpm vitest run server/src/__tests__/issue-comment-reopen-routes.test.ts server/src/__tests__/recovery-classifiers.test.ts server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts packages/adapters/codex-local/src/server/parse.test.ts server/src/__tests__/codex-local-execute.test.ts`
- `pnpm vitest run server/src/__tests__/issues-service.test.ts -t "cancelled blocker|clearCancelledBlockers|stranded_issue_recovery|closing recovery issue"`
- `pnpm vitest run server/src/__tests__/heartbeat-process-recovery.test.ts -t "transient continuation|mixed-cause continuation|non-retryable continuation|Codex usage-limit|productive-but-stranded|productive continuation|blocked after a productive continuation"`
- `pnpm --filter @paperclipai/adapter-codex-local typecheck`
- Playwright render check for `http://127.0.0.1:3101/RAY/ai-os`: HTTP 200, title `AI OS • Ray • Paperclip`, `runtime clean`, no console errors, screenshot at `/tmp/paperclip-ai-os-cockpit.png`.

## Follow-Up

Keep retry automation disabled until the controlled run-next path proves itself on several harmless goals. If another recovery cascade appears, check issue `originKind` first; recovery/meta origins should remain visible in AI OS but should not generate new supervisor-recovery work.
