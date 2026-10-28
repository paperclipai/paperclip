# 2026-10-12 native status corpus preservation map

The native status-authority corpus keeps one complete execution of its 53 real fixtures. The comparison-negative loop uses those same actual observations. It no longer creates another set of issues, runs, decisions, effects, and wakes only to change expected comparison fields.

The change is stacked on public PR #16076 at parent commit `9abd9b23bde1da5fa1f11bfb9ce9a0d5d4c5a8dd`. The dedicated branch is `codex/test-audit-r11-corpus`.

## Change and retained proof

| Item | Before | After |
|---|---:|---:|
| Full real-corpus passes in the two affected declarations | 2 | 1 |
| Real fixture executions in those passes | 106 | 53 |
| Corpus fixture definitions | 53 | 53 |
| Joined contract matrix rows | 70 | 70 |
| Negative comparison field categories | 11 | 11 |
| Registered owner and sibling cases | 62 | 61 |
| Corpus test source lines | 2,981 | 2,976 |

No production source changes. All later live-entrypoint negative controls and storage, status-lock, lineage, reviewer, child-delivery, and monitor tests remain. Those controls still run their targeted scenarios separately.

The first declaration at `server/src/__tests__/native-status-arbiter-corpus.test.ts:1821` keeps all real consumer execution and matrix checks. It absorbs the pure negative-comparison loop from the former declaration at line 1870. The loop body is byte-identical. The two original full passes had identical fixture lists and `executeFixture` calls. The moved loop changes expected fields and local comparison objects. It does not write to the database or change the original observations.

All 53 fixture behavior rows are distinct when comparing mode, given facts, and expected behavior. No fixture definitions were removed.

## Exact-parent verification

| Phase | Result |
|---|---|
| Baseline at the parent head | 62/62 passed |
| Candidate | 61/61 passed |
| Comparator owner mutation | Keeper failed inside the moved negative assertion |
| Comparator restored to candidate bytes | 61/61 passed |

Mutation: remove the `reasonCode` comparison from the test-local `comparisonFailures` owner at original line 358. Correct production results still satisfy the positive comparison. The moved negative check fails with `native-mechanical-completion:reasonCode: expected [] to not deeply equal []` at mutated candidate line 1889. This is a comparator/harness-owner regression, not a production status-policy mutation. The comparator was restored byte for byte before the final full owner and sibling replay.

Run from `server/`:

```sh
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/native-status-arbiter-corpus.test.ts src/services/native-runtime/status-arbiter.test.ts
```

The mutation replay selects the merged keeper with `-t 'executes all 53 fixtures, joins all 70 matrix rows'`.

Repo-wide typecheck, the full Vitest suite, and build were not run locally for this narrow test-only change. The draft PR checks must pass before a merge-ready handoff.

## Source identity and local cost

- Baseline corpus SHA-256: `1dffa2f852ff2a9c5c6b174cfb3ef21746b65d124e4593d00401588923bbdcf0`.
- Candidate corpus SHA-256: `e4974c65b704ea3aac7887cddf2707f53c686578fe5c0b1b2aeab42fa10c9d38`.
- Local fixture-test subtotals: baseline `1897.437 ms`; candidate `967.448 ms`; comparator-restored candidate `985.561 ms`.

These are local Vitest replay samples, not CI timings or a controlled benchmark. The evidence supports removal of the repeated pass. It does not claim a fixed CI time reduction.

## Declaration ledger

The full-file review covers the corpus test (31 declarations) and the sibling policy test (17 declarations). Each table row below records one declaration. All parameter rows stay unless the ledger says otherwise.

| File | Parent line | Test declaration | Mark and retained contract |
|---|---:|---|---|
| native-status-arbiter-corpus.test.ts | 1821 | executes all 53 fixtures in their production consumers and joins all 70 matrix rows | R: Primary real-consumer receipt owner; catches incorrect decisions/effects, missing persisted targets, replay duplication, and incomplete matrix joins. Absorbs the comparator-negative loop. |
| native-status-arbiter-corpus.test.ts | 1870 | fails independently when any asserted field category is mutated | C: Keep every comparison-negative assertion, but use the first declaration’s 53 real observations; this declaration currently executes exactly the same fixture list a second time. |
| native-status-arbiter-corpus.test.ts | 1900 | fails mapped fixtures when live entrypoints or owning actions are removed despite matching policy labels | R: Distinct live-entrypoint negative controls; policy labels alone must not masquerade as cancellation, attention, workspace reconciliation, rollout, or effect delivery. |
| native-status-arbiter-corpus.test.ts | 2066 | retires a proven automatic review and applies the current successful completion exactly once | R: Automatic-review retirement must produce exactly one superseding completion and remain idempotent. |
| native-status-arbiter-corpus.test.ts | 2081 | automatic review reconciliation preserves unread child results (%s); rows: queued, claimed, deferred_issue_execution, current_run, current_intent, consumed | R: Distinct six durable wake delivery states govern whether unread child results hold completion; preserve all rows. |
| native-status-arbiter-corpus.test.ts | 2113 | rechecks child delivery under the status lock during automatic review reconciliation | R: A child wake arriving between initial assessment and status lock must block a stale completion commit. |
| native-status-arbiter-corpus.test.ts | 2138 | new evidence cannot complete reconciliation before a pending child result is consumed | R: Reconciliation policy must prioritize pending child results and emit the release-checkout effect, which the storage-level sibling does not assert. |
| native-status-arbiter-corpus.test.ts | 2146 | new-evidence reconciliation respects %s child delivery; rows: queued, consumed | R: Actual queued/consumed wake rows must select the new-evidence reconciliation path and persisted task status; preserve both rows. |
| native-status-arbiter-corpus.test.ts | 2164 | completes a new merge run after an old CI review and bounds repeated incomplete results | R: New merge runs may retire old CI reviews, while repeated incomplete reports must terminate bounded repair without manufacturing approvals. |
| native-status-arbiter-corpus.test.ts | 2195 | rejects wrong, missing, and duplicate criterion IDs before accepting completion | R: Completion feedback validates exact criterion ID membership/cardinality and remains read-only. |
| native-status-arbiter-corpus.test.ts | 2206 | keeps genuine approval actionable in the finish response and in finalization | R: Genuine human approval remains pending; finish feedback escapes prompt-injection titles and rejects failed verification. |
| native-status-arbiter-corpus.test.ts | 2231 | preserves answered cards, explicit attention, stronger authority, and later task edits | R: Six independent guard facts prevent unsafe automatic review retirement: resolved response, explicit attention, authority, later status, newer contract, failed workspace. |
| native-status-arbiter-corpus.test.ts | 2251 | rejects an empty needs_review report with actionable feedback without inventing an approval | R: Empty needs-review reports fail with actionable feedback and leave review retirement to its owning reconciler. |
| native-status-arbiter-corpus.test.ts | 2262 | withdraws obsolete policy reviews, restores the prior status, and is idempotent | R: Obsolete-policy cleanup restores prior status/version while retaining decision history, then becomes idempotent. |
| native-status-arbiter-corpus.test.ts | 2276 | leaves an already %s review untouched; rows: accepted, rejected | R: Accepted and rejected interactions are both authoritative responses and must remain untouched; preserve both rows. |
| native-status-arbiter-corpus.test.ts | 2286 | preserves real completion reviews and limits cleanup to the requested runs | R: Genuine reviews and unrelated run-scoped cards must not be retired. |
| native-status-arbiter-corpus.test.ts | 2296 | dismisses the obsolete card without undoing a later %s status; rows: blocked, done, cancelled | R: Blocked, done, and cancelled later states have distinct cancellation/expiry behavior and must not be overwritten; preserve all rows. |
| native-status-arbiter-corpus.test.ts | 2306 | does not restore status after a newer decision or a status change back to review | R: Changed decision pointer and a round-trip status edit independently invalidate restoration authority. |
| native-status-arbiter-corpus.test.ts | 2321 | keeps review status when a separate request still needs a response | R: Another pending interaction retains review liveness even after obsolete-card retirement. |
| native-status-arbiter-corpus.test.ts | 2332 | isolates a failed cleanup candidate and retries it on the next pass | R: One failed cleanup transaction must not stop other candidates; a later pass retries the failed candidate. |
| native-status-arbiter-corpus.test.ts | 2354 | keeps committed cleanup and continues publication after a live event fails | R: Live-event publication failure must not roll back committed cleanup or prevent later publication. |
| native-status-arbiter-corpus.test.ts | 2374 | continues native finalization when the obsolete-card lookup fails | R: Obsolete-card lookup failure must not halt native finalization. |
| native-status-arbiter-corpus.test.ts | 2388 | preserves a later authoritative status during reconciliation | R: Reconciliation reducer preserves externally advanced blocked state and its explicit authority reason. |
| native-status-arbiter-corpus.test.ts | 2399 | supersedes the exact committed coordinator decision and sequences preserve decisions independently of issue status versions | R: Semantic decision sequencing is independent of statusVersion changes and supersedes the exact committed coordinator decision. |
| native-status-arbiter-corpus.test.ts | 2469 | keeps assessment lineage run-local while superseding an issue decision from another run | R: Cross-run issue decision supersession must preserve current-run assessment ancestry and durable effect payload linkage. |
| native-status-arbiter-corpus.test.ts | 2634 | preserves an intermediate same-run assessment when the issue decision points to an older ancestor | R: An intermediate same-run assessment must not be replaced with the older issue-decision ancestor. |
| native-status-arbiter-corpus.test.ts | 2741 | ignores historical committed finalizations superseded by a newer authoritative decision | R: Historical committed finalization must remain untouched after a newer authoritative decision wins. |
| native-status-arbiter-corpus.test.ts | 2811 | records run-scoped superseding assessment lineage with %s predecessor; rows: none, same_run, other_run | R: No predecessor, same-run predecessor, and other-run predecessor must all preserve run-local assessment lineage; preserve all rows. |
| native-status-arbiter-corpus.test.ts | 2893 | binds a tools-refresh continuation to its existing durable wake without a duplicate | R: Tools-refresh continuation must bind its existing wake exactly once, rather than insert a duplicate. |
| native-status-arbiter-corpus.test.ts | 2910 | revalidates a %s monitor under the final disposition lock; rows: scheduled, cleared, replaced, reassigned | R: Scheduled, cleared, replaced, and reassigned monitor authority is rechecked under the status lock; preserve all rows. |
| native-status-arbiter-corpus.test.ts | 2943 | fails the transaction closed for an unknown status effect | R: Unknown effect kinds fail the complete transaction closed, leaving no decision/effect/status/coordinator mutation. |
| status-arbiter.test.ts | 47 | keeps a verified accepted Cursor plan passive without completing or replaying work | R: Accepted plan wait is passive only with verified authority and still yields to failed terminals, cancelled issues, and governance. |
| status-arbiter.test.ts | 68 | a reviewer finishes its decision without completing rejected or still-reviewed work | R: A resolved reviewer action must preserve worker/review task status and avoid retrying the worker assignment. |
| status-arbiter.test.ts | 76 | routes an unfinished reviewer action to bounded recovery instead of retrying the worker task | R: Pending reviewer actions require bounded reviewer recovery without generic continuation/retry. |
| status-arbiter.test.ts | 85 | treats only the authorized Board response_wake as passive and preserves governance | R: Board response-wait authority, origin, governance, and non-response continuations select distinct policy branches. |
| status-arbiter.test.ts | 138 | repairs unfinished response waits once using the server continuation budget | R: Unfinished response waits must use bounded server repair while preserving pause, dependency, governance, external-chat, and conversation authority. |
| status-arbiter.test.ts | 172 | marks done only from successful finalization and complete durable evidence | R: Durable evidence and accepted low-risk policy are separate completion authorities; missing evidence alone cannot complete standard work. |
| status-arbiter.test.ts | 245 | creates explicit liveness paths for review, continuation, cancellation, and governance | R: Reviewless needs-review reports, retry continuations, external-chat authority, run cancellation, and governance have distinct liveness/effect contracts. |
| status-arbiter.test.ts | 379 | accepts low-risk completion claims with unrun verification caveats | R: Explicit unrun-verification caveats are permitted under accepted low-risk completion policy without treating them as failed verification. |
| status-arbiter.test.ts | 424 | keeps failed verification with the agent and routes explicit attention to its owner | R: Failed verification overrides low-risk claim acceptance; explicit attention separately creates review authority. |
| status-arbiter.test.ts | 485 | blocks only for a task-wide blocker with a named owner and action | R: Task-wide blockers bind named unblock ownership and send the required owner notification. |
| status-arbiter.test.ts | 513 | waits for an explicit unblock instead of inventing another productive track | R: Current-track blockers bind explicit unblock actions without inventing a runnable alternate track; policy version is independently guarded. |
| status-arbiter.test.ts | 554 | blocks a current-track result when a durable dependency already gates the issue | R: Existing durable dependencies override provider current-track labels without an immediate wake. |
| status-arbiter.test.ts | 581 | lets a durable dependency override an optimistic done result | R: Durable dependency blockers also override an optimistic done report with policy claim acceptance. |
| status-arbiter.test.ts | 598 | does not create a duplicate review after this run's review was already accepted | R: Accepted human review authority suppresses a second review card for needs-review disposition. |
| status-arbiter.test.ts | 626 | does not create a duplicate review after this run's planning confirmation was already accepted | R: Accepted planning approval must also suppress a second card when disposition is blocked; this exercises a distinct allowed disposition. |
| status-arbiter.test.ts | 654 | preserves authoritative terminal statuses | R: Authoritative done task status must not be overwritten or produce new liveness effects. |
| status-arbiter.test.ts | 663 | routes each explicit request to its own reviewer | R: Mixed human/agent attention requests preserve separate reviewer routing and ownership. |

## History and stopping point

The executable corpus and comparison-negative control arrived in #12616. The corpus grew to 53 fixtures in #13038. The empty-effect forbidden-effects negative was corrected in #13266; this change keeps that correction verbatim.

The remaining declarations protect distinct policy, lifecycle, storage, atomicity, routing, and authority contracts. No further cuts are proposed in this lane.
