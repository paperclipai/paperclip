# Avoid self-contention during accepted-response recovery

Baseline: `82c033ed127d07862e6765aa4b69a3cf339bde81`. This change prevents the response-presentation worker from recovering different tasks on a shared chat endpoint or principal at the same time. It preserves task order, current transactional authorization, company boundaries, NOWAIT locks, and retry/drain behavior. Endpoint and principal IDs are scheduling hints from a company-scoped wake-action join. Missing hints retain task order and every eligibility check.

## Evidence and limits

A staging log from the captured host showed `native-response-presentation could not settle` → DrizzleQueryError → PostgresError `could not obtain lock on row in relation "chat_endpoints"`. The retained hosted sample did not include SQLSTATE. Repeated presentation errors establish activity, not its CPU share. Most SQL-construction samples in the fresh profile lack application ancestors. This change makes no claim to resolve all main-loop CPU.

The real PostgreSQL regression uses four accepted historical responses for distinct tasks and principals on one actual chat endpoint. It uses the live source-authority implementation. The baseline worker produced three endpoint NOWAIT failures in one pass without external ingress. The new admission settles all four responses exactly once. An owned advisory gate holds a real comment transaction in the correctness test. An independent endpoint must publish before that gate is released.

Other controls cover external-lock failure and rollback, recovery after release, paused-endpoint refusal despite a forged hint, transitive task/endpoint groups, duplicate and missing hints, shutdown, drain/resume, and an in-flight rescope with exactly-once newcomer admission. All authorization locks remain in their owners. Ingress, direct finalization/reconciliation, and other workers can still cause legitimate retries. Provider network sends are not asserted to hold these locks. Open PR #17714 fixes a complementary publication-commit lock order. PR #18686 changes run-list JSON/index work, not this worker.

## Initial endpoint-only comparison

Five alternating pairs compared the actual archived baseline worker/query with the initial endpoint-only treatment on source base `82c033ed`. This study preceded the principal-hint review fix below. It measures the earlier candidate, not final-head CPU. The final endpoint fixture has four distinct principals, so the added principal key does not change its groups; its constant extra hint processing was not CPU-measured. Each used fresh equivalent four-response fixtures and real PostgreSQL. No artificial database sleep or advisory gate was used in this comparison. Validation checked one comment per run, the exact accepted text, and one publication with the matching text/company/task/conversation/comment association. Validation ran after timing and capture counters stopped.

The actual Vitest child recorded Node **v24.22.2** and executable `/Users/dotta/.npm/_npx/387698761821791d/node_modules/node/bin/node`. This is a shared-host measurement: the coordinator reported 18 logical CPUs and about 10.5 one-minute load, with unrelated Node/VM work. Other campaign agents paused heavy jobs. No unrelated process was stopped.

CPU/wall measurement covers worker start through settlement. It excludes imports, fixture creation, and output validation. Existing capture hooks count product driver calls, returned rows, and errors before Drizzle decoding. Completion observation reads only in-memory idle state; it issues **no SQL**. CPU includes capture hooks, timer processing, and the unequal number of observer checks shown below. It is instrumented Vitest-process CPU, not pure product CPU or PostgreSQL CPU. The outlier is retained.

Retry timers and Date were advanced together. **Measured wall time excludes real retry waits** and is not a hosted latency claim. Baseline virtual elapsed time was 92–211 seconds, with two or three retry deadlines replayed. Treatment replayed none. Raw driver calls include transaction-control statements. These results demonstrate avoided local retry work; no hosted CPU percentage reduction is claimed.

| Round | Variant | CPU ms | Measured wall ms | Driver calls | Rows | Query errors | Retry deadlines | Memory checks | Virtual elapsed ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | before | 169.487 | 4263.348 | 393 | 276 | 4 | 2 | 202 | 92082 |
| 1 | after | 80.695 | 1058.891 | 293 | 200 | 0 | 0 | 45 | 1020 |
| 2 | after | 121.239 | 1066.592 | 293 | 200 | 0 | 0 | 45 | 1020 |
| 2 | before | 141.654 | 4261.701 | 443 | 314 | 6 | 3 | 205 | 211063 |
| 3 | before | 945.351 | 4321.276 | 443 | 314 | 6 | 3 | 205 | 211083 |
| 3 | after | 100.563 | 1075.898 | 293 | 200 | 0 | 0 | 44 | 1020 |
| 4 | after | 83.766 | 1076.359 | 293 | 200 | 0 | 0 | 44 | 1020 |
| 4 | before | 534.683 | 4304.004 | 443 | 314 | 6 | 3 | 205 | 211083 |
| 5 | before | 177.157 | 4377.283 | 393 | 276 | 4 | 2 | 201 | 92102 |
| 5 | after | 98.164 | 1072.052 | 293 | 200 | 0 | 0 | 40 | 1020 |

Median instrumented process CPU was 177.157 → 98.164 ms, with ranges 141.654–945.351 and 80.695–121.239 ms. Median product driver calls were 443 → 293; rows were 314 → 200; query errors were 6 → 0. Each failed endpoint attempt added exactly 25 product calls and 19 returned rows. All variants completed the same four responses. The observer performed 201–205 memory checks before and 40–45 after; its CPU contribution is included and is not subtracted.

## Final shared-principal work-count comparison

Review identified a second shared lock: the source-authority path takes a company/principal try-advisory lock before endpoint checks. Two valid Slack bot endpoints in the same workspace can share one external-principal row. The final code also groups that principal hint from the same company-scoped wake-action join. The hint never grants authority.

A real PostgreSQL regression asserts distinct endpoints and identical source principal IDs. Before the fix, one response completed on the first pass and the other failed with `NativeChatReviewPresentationContentionError`. The advisory SQL itself returned successfully, so query-error count was zero. After the fix, both exact responses and their correctly associated publications completed on the first pass. This counts-only experiment used a short real comment-transaction hold to reproduce overlap. It measured no CPU or wall-time benefit.

| Stage | Admission | Responses | Product calls | Rows | Outer contention failures | Query errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| First pass | Task + endpoint | 1 | 91 | 65 | 1 | 0 |
| First pass | Task + endpoint + principal | 2 | 145 | 100 | 0 | 0 |
| Same completed work, after retry | Task + endpoint | 2 | 165 | 114 | 1 | 0 |
| Same completed work, settled | Task + endpoint + principal | 2 | 147 | 100 | 0 | 0 |

The final independent-resource control retains parallel progress when task, endpoint and principal keys differ. Existing endpoint-lock and current-authority controls remain. The original five-pair table is retained as historical evidence; no final-code CPU percentage is inferred from it.

## Reproduction and failure accounting

```sh
pnpm exec vitest run --project @paperclipai/server server/src/__tests__/scoped-deadline-work.test.ts
pnpm exec vitest run --project @paperclipai/server server/src/__tests__/chat-channels.integration.test.ts -t 'shared-endpoint accepted-response|different endpoints for one principal|endpoint scheduling hint|contended accepted response'
```

The committed helper materializes the pinned baseline with `git show`; it does not ship a clone of old production code. Run it with Node 24.22.2 and pnpm 9.15.4 from a clean, isolated checkout of this PR:

```sh
git worktree add --detach /tmp/presentation-repro HEAD
cd /tmp/presentation-repro
pnpm install --frozen-lockfile
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
node server/scripts/benchmark-response-presentation.mjs /tmp/presentation-results
```

The helper checks the actual child runtime, writes each pair immediately, and restores temporary fixture/baseline files in `finally`. Its output includes the baseline/treatment revisions, exact benchmark fragment, baseline modules, child preflight, JSONL and Vitest log. Review `server/scripts/benchmark-response-presentation.mjs` for the measurement boundary. Initial study artifacts remain under `/private/tmp/paperclip-perf-batch-20261102/campaign-10h/presentation-benchmark/`; the table above makes all ten measured runs (five pairs) inspectable without that workspace.

Initial offline install lacked a cached tarball; frozen network install passed. The first test import lacked built plugin-sdk; its existing build helper resolved that. The intentionally failing same-endpoint regression is retained. A Date-only benchmark clock failed to settle. A corrected run passed but lost console metrics, so it supplies no numbers. The next retained run used inherited Node 26; it is superseded and is not the table above. The final run checked the actual Node 24 child, verified its file sink, and retained each pair immediately. An early broad check inherited global pnpm 11 and failed its version-switch signature fetch; the corrected checks use the pinned Node 24/pnpm 9 PATH. These setup failures are not reported as verification passes.

The first full typecheck found an existing direct-worker fixture that omits the endpoint hint. The hint type now explicitly permits omission, and dispatch falls back to the existing task key. A sandbox IPC restriction required rerunning the pinned typecheck with local socket access.
