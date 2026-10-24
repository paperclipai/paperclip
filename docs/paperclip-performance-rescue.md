# Paperclip performance rescue

## Scope and provenance

This work continues the existing performance rescue on the `codex/paperclip-performance-fix` branch. The original checkout was `46330efe438a5d25e384e6dff7316ce1f54f51fe` on `codex/paperclip-task-exporter`. The saved patch at `C:\Users\NOverhead\AppData\Local\Temp\paperclip-performance-rescue.patch` matches the four pre-existing worktree changes and was already applied; it was not reapplied. The patch file remains the recovery copy until a repository commit contains the work.

## Changes carried forward

- `classifyIssueGraphLiveness` builds sets for active execution, pending interaction, approval, and recovery paths instead of scanning those full collections for every issue.
- Blocked inbox listing defers labels, active runs, comments, user context, blocker details, and secondary attention hydration until filtering, ordering, and pagination have selected the response page.
- Regression coverage includes a 10,000 issue dependency chain and a 10,000 unrelated active-run input.

## Benchmark instrumentation

The opt-in benchmark in `server/src/__tests__/issue-blocker-attention.test.ts` (`PAPERCLIP_RUN_ISSUE_PERF=1`) records data generation, company/issue/relation seeding, service-list elapsed time, SQL call count, aggregate SQL elapsed time, rows returned by SQL, application/service time outside SQL, and cleanup. SQL time is summed per driver call; concurrent calls can make this larger than wall-clock service time. The residual is an application/service overhead estimate and includes promise scheduling. It is not a standalone classifier timer. `PAPERCLIP_ISSUE_PERF_SIZES` accepts a comma-separated size list for focused runs.

## Findings and fix

The first service run exposed an N+1 blocker graph pass inside the blocked inbox candidate loop. At 100 issues, three identical graph queries each ran 765 times (2,904 total service queries, 4,587.7 ms). At 1,000 issues this grew to 29,928 queries and 40,246.6 ms. The graph map is now computed per bounded 500-candidate batch so the existing graph-node limit remains effective: final run results were 39 queries / 214.1 ms at 100 issues and 96 queries / 1,075.9 ms at 1,000.

The subsequent 10,000 issue run found a recursive `pathHasLiveWork` traversal that overflowed the stack. Converting it to iterative traversal avoided the overflow, but the service still took 64,417.8 ms with 228 queries. The measured SQL portion was 4,192.3 ms; the remaining ~60.2 s came from repeating a full graph walk per root when there were no live-work nodes. The empty-live-work fast path now skips those repeated traversals. Final service results were 4,360.0 ms for 10,000 issues (744 queries, 4,157.8 ms aggregate SQL, 51,482 returned SQL rows, 202.2 ms application/service overhead). Data generation took 15.5 ms, company setup/seeding 130.4 ms, issue seeding 8,946.2 ms, relation seeding 2,075.9 ms, and cleanup 28,132.7 ms. The final 10,000 issue run completed successfully. The benchmark enforces fewer than 1,000 SQL calls per service phase.

Run from the repository root with:

```powershell
$env:PAPERCLIP_RUN_ISSUE_PERF = '1'
pnpm --filter @paperclipai/server exec vitest run src/__tests__/issue-blocker-attention.test.ts -t 'profiles blocked issue listing'
```

The benchmark asserts returned rows and logs `blocked_issue_list` per size plus a separate cleanup record.

## Validation and outstanding blockers

- The prior session reported 46 passing tests and a fixed 10,000-task stack overflow; that is inherited evidence, not a rerun in this session.
- `pnpm --filter @paperclipai/paperclip-runner check:protocol-manifest` reports that the generated PRP contract manifest is stale. The manifest was not regenerated because doing so changes a shared protocol contract and needs its own impact review.
- Full `issue-blocker-attention.test.ts`: 26 passed, 1 opt-in benchmark skipped.
- Full `issue-liveness.test.ts`: 20 passed. Its 10,000 task in-memory chain classified in 75.1 ms.
- The 100/1,000/10,000 service benchmark passed with the metrics above.
- `pnpm --filter @paperclipai/server typecheck` stops in its Runner vendor prebuild at the stale PRP manifest. Running `tsc --noEmit` directly bypassed that prebuild but exposed missing `@paperclipai/paperclip-runner` modules and existing implicit-any errors from the unavailable generated Runner package; a constrained rerun reported no diagnostics in the four changed TypeScript files. Full typecheck remains blocked pending manifest impact review and Runner generation.

## Pull request draft

- Branch: `codex/paperclip-performance-fix`
- Base: `origin/master` (remote HEAD points to `master`)
- Title: `perf(server): batch blocked inbox blocker analysis`
- Summary: Batch blocked inbox blocker analysis, defer hydration until page selection, and avoid repeated or recursive graph walks. Add opt-in phase and SQL instrumentation for 100/1,000/10,000 issue service runs.
- Validation: 26 issue-blocker tests, 20 issue-liveness tests, and the full 100/1,000/10,000 service benchmark passed. Full typecheck is blocked by the stale generated PRP manifest.
