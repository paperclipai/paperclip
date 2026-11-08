# Continuation accounting: tests before product changes

Requested September 22, 2026. Worktree: `codex/lifecycle-behavior-baseline-20260921`.
This slice adds executable expectations and records current behavior. It does not
change production scheduling, limits, or authority. Failed expectations remain
visible; they are not new accepted product contracts.

## Rules under test

Productive continuation, missing-disposition repair, and infrastructure failure
have separate allowances. A typed wait is not a failed attempt. Comments, confident
wording, raw tool counts and stale liveness labels cannot refill any allowance.
Stop, durable approvals/questions, ownership, pause and spending gates remain
binding at dispatch. Persisted causal receipts and consumed attempts survive
restart and duplicate handlers.

The previous legacy repair fix already guarantees many of these rules. This
slice must distinguish that from remaining cross-lane counter bugs. The existing
native `same_agent` compatibility probes are not reachable model contracts;
new paid productive cases use public questions and responses instead.

## Scenario matrix

| Scenario | Cheap executable coverage | Real provider/browser coverage |
|---|---|---|
| Five productive turns, beyond repair/failure allowances | Existing response delivery and retry suites; failure count excludes max-turn continuations | Five separately gated document steps on legacy/native, quiet/noisy pair |
| Infrastructure failure during a repair | Actual scheduler tests at immediate repair 1 and delayed repair 2; episode preserved; replay same successor | Deliberate provider/network failure stays deterministic rather than a nondeterministic paid fault |
| Productive max-turn continuation after infrastructure retries | Actual scheduler with prior failure counter at cap; expect first productive allowance | Productive five-step case proves normal public continuation, not max-turn exhaustion |
| Repeated missing disposition | Existing repair episode unit/DB tests; complete sweep after exhaustion | Initial turn plus exactly two legacy repairs; visible board recovery, blocked task |
| Comments/confident prose/tool calls without state change | Quiet/noisy exhausted repair and failure variants; native event replay | Quiet versus three distinct attributed misleading comments per run; no extra allowance |
| Late approval/pause/spending/ownership gate | Second repair delayed, new gate, service restart, same debit; existing admission tests cover both runtimes | Approval created by first repair owns wait; acceptance causes one completion; Stop before second repair dispatch |
| Restart while a repair is scheduled | Actual delayed-retry promotion as well as the repair gate; retain episode and debit | Controller restart before delayed repair; identical run IDs and episode counters; fail with the persisted cancellation reason if promotion cancels it |
| Duplicate/out-of-order handling | Concurrent retry/recovery tests and native consumed-repair replay with commentary/tool events | Exact run counts, document revisions and retained IDs; exhaustive races stay deterministic |
| No reset after exhaustion; legitimate new request | Existing heartbeat exhausted failure versus actual new user request | No user message during exhaustion; a real approval resumes its owned path |
| Missing or misleading evidence | Calibrated oracle rejects missing state, wrong documents, overwritten steps, fabricated progress, extra runs, lost receipts, decline, executed Stop | Every live result uses that oracle and existing screenshot/evidence/billing pipeline |

## Layers and commands

- Pure contract: `tests/lifecycle-baseline/accounting.test.ts`.
- Server/database: ACCT cases in `heartbeat-retry-scheduling.test.ts` and
  `legacy-continuation-authority.test.ts`, reusing their isolated embedded databases.
- Runner: consumed disposition-repair replay in `native-session-runtime.test.ts`,
  with silent, commentary and tool-event histories.
- Product E2E: explicit-only `continuation-accounting` suite; eight cells,
  current qualified Codex profiles, local Chromium/server/database/real provider.
  Native repair injection is intentionally absent: native bounded repair is
  exercised at its actual runner layer, not through an invented public tool.
- Grader: `tests/runner-e2e/accounting.test.ts`, positive recordings and adverse
  mutations; missing evidence cannot pass.

`pnpm test:lifecycle-baseline` records all deterministic lanes and the inventory.
`pnpm test:e2e:runner -- --list --suite continuation-accounting` discovers the
paid cells. Run their typecheck and support tests before the existing trusted
GitHub Actions workflow, targeting this branch by immutable resolved revision.
Provider failures retain their original grade; fixture corrections are new
measurements. This is not full provider/model/environment qualification.

## Known boundaries retained

This suite checks orchestration and budget accounting, not whether arbitrary
agent work is useful. Productive checkpoints verify concrete saved records and
real answers; event/comment counts alone are never the oracle. Resource waits,
spending gates and timing races use deterministic fixtures rather than artificially
spending money or hoping for a real outage. The original native compatibility
probes, blank-route reload finding and duplicate-response finding remain in the
[retained backlog](2026-09-22-legacy-continuation-authority.md).

## Recorded baseline

The [measurement report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-2026-09-22.md)
retains the deterministic inventory and each paid campaign without regrading.
The new suite exposes shared allowance accounting in both directions and a
delayed-repair promotion mismatch. These are production follow-ups; the test
slice leaves their intended-behavior assertions enabled and failing.
