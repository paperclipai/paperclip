# RBR-875 — Finding: AC2's escalation trigger is met

Commit under test: `ead66d0336` (`feat(RBR-875): flip supersedeOnUserComment default to false`)
Branch: `rbr-875-supersede-default`
Baseline: `1314723854` (tip of RBR-852 work)

## Summary

The flip is implemented and committed. It **cannot be completed without editing RBR-852's AC5
suite**, which AC2 defines as a stop-and-escalate condition, not a merge conflict to resolve.

AC1 is satisfied. AC3's premise is materially wrong (19 of 22 files are structurally blind to the
default). AC4 finds no load-bearing production call site. AC2 is violated and blocks the issue.

## The conflict (AC2)

Two tests in the RBR-852 AC5 suite assert the *opposite* of the RBR-875 objective. They are not
incidental churn — they were authored deliberately by the RBR-852 work
(`7232b98774`, "AC5 suite ... no-guess comment supersession") and are labelled as intentional.

1. `server/src/__tests__/issue-thread-interactions-supersession.test.ts:203`
   `case 1b: a single pending ask still expires on a user comment (historical behaviour intact)`

2. `server/src/__tests__/issue-thread-interactions-service.test.ts:3439`
   `AC5: a user comment still supersedes when it is the only pending ask on the issue`

Both create a `request_confirmation` **without** `supersedeOnUserComment`, then assert
`expect(expired).toHaveLength(1)`. That assertion only holds if the default is `true`.

### Verified test output

Gate suite at `ead66d0336` (default `false`):

```
❯ issue-thread-interactions-supersession.test.ts (8 tests | 1 failed)
  ✓ case 1: a single user comment does not expire the current ask when three are pending
  × case 1b: a single pending ask still expires on a user comment (historical behaviour intact)
  ✓ case 2 / case 3 / case 4 / case 5 / case 5b / case 5c
AssertionError: expected [] to have a length of 1 but got +0
  at issue-thread-interactions-supersession.test.ts:223:21
```

Same suite at baseline `1314723854` (default `true`): **8 passed (8)**.

So the single failure is caused by the flip and by nothing else.

## Why this is a genuine disagreement, not churn

RBR-852's design intent is documented in its own source comment
(`issue-thread-interactions.ts`, `selectCommentSupersededRows`):

> - Exactly one pending supersedable candidate: the comment supersedes it. A comment posted
>   instead of answering the only open card is a reply to that card. **This is the historical
>   behaviour and the only one that survives unchanged.**

RBR-852 deliberately *preserved* single-candidate expiry-by-comment and scoped its fix to the
multi-candidate case. RBR-875 removes single-candidate expiry-by-comment entirely. These are
incompatible specifications of the same behaviour, written three commits apart.

The two issues disagree on one question:

> When exactly one ask is pending and a human comments instead of answering it, is that comment
> a reply to the card (RBR-852: expire it) or unrelated (RBR-875: leave it pending)?

RBR-823 — the shared parent — only ever alleged harm in the **multi**-candidate case
("contradictory irreversible asks coexist"). The single-candidate case is not part of the reported
defect. RBR-852 already fixed the defect RBR-823 reported.

## AC3's premise is materially wrong — 21 files is an overcount

The issue states "21 server test files exercise ... load-bearing in comment-wakeup, telemetry,
activity-events, dependency-wakeups and document-restore suites." That evidence does not survive
inspection. 22 files reference the expiry methods; **19 of them only ever reference them as
`vi.fn()` mock declarations** and never construct an interaction or observe the default:

```
MOCK-ONLY  (19)  document-annotation-routes, environment-selection-route-guards,
                 issue-activity-events-routes, issue-agent-mutation-ownership-routes,
                 issue-assigned-backlog-contract-routes, issue-assignee-invokability-routes,
                 issue-attachment-routes, issue-closed-workspace-routes,
                 issue-comment-cancel-routes, issue-comment-reopen-routes,
                 issue-dependency-wakeups-routes, issue-document-restore-routes,
                 issue-execution-policy-routes, issue-feedback-routes,
                 issue-telemetry-routes, issue-thread-interaction-routes,
                 issue-update-comment-wakeup-routes, issue-workspace-command-authz,
                 issues-goal-context-routes
REAL-SERVICE (3) issue-thread-interactions-service, issue-thread-interactions-supersession,
                 issue-thread-interactions-telemetry
```

Named examples, all pure mock stubs returning `[]`:
`issue-dependency-wakeups-routes.test.ts:77`, `issue-document-restore-routes.test.ts:50`,
`issue-telemetry-routes.test.ts:101`, `issue-activity-events-routes.test.ts:117`.
Four of the five suites the ruling calls "load-bearing" (comment-wakeup, activity-events,
dependency-wakeups, document-restore) mock the service and cannot observe this default at all.

**Consequence: the test churn this issue was separated from RBR-852 to contain does not exist.**
The real blast radius is ~4 assertions in 2 files. The original reason for splitting RBR-875 out
of RBR-852 — "a large, mostly-unrelated test rewrite in front of the gate" — was based on a
grep count of mock declarations.

## AC4 — no load-bearing production call site

`grep -rn "supersedeOnUserComment" server/src packages/` outside the service file and its tests
returns **no production caller** that sets the flag. Every in-tree producer relied on the default
implicitly; none passes `true` deliberately. Nothing needs `supersedeOnUserComment: true` added.

There is exactly one default, at `issue-thread-interactions.ts:474`, consumed at four sites in
`normalizeCreateInteractionInput` (one per supersedable kind). Validators in
`packages/shared/src/validators/issue.ts` leave the field `.optional()` with no `.default()`, so
there is no second source of truth to keep in sync.

## Pre-existing infra failure, unrelated to this change

`issue-thread-interactions-telemetry.test.ts` and `issue-thread-interactions-service.test.ts` both
fail at `beforeAll` with `Hook timed out in 20000ms` — all tests reported `skipped`, so they never
reach the default. Their inline hook budget is `20_000` ms while embedded Postgres takes ~80-95 s
to import and start on this machine. The passing supersession suite uses `120_000`. The CLI
`--hookTimeout=180000` does not override the inline argument.

This is a pre-existing harness defect, present at baseline, not caused by the flip. It is also why
prior runs on this issue timed out. Worth its own issue; it currently hides ~56 service-suite tests.

## Recommendation

Prefer **Option A**: accept the flip and retire the two contradicting assertions, replacing them
with the inverse assertion (a lone pending ask survives a user comment unless it opted in), plus a
new case proving opt-in `supersedeOnUserComment: true` still expires. Rationale: RBR-823's reported
harm is fully covered by RBR-852's multi-candidate fix; the single-candidate carve-out is the last
remaining path by which a comment silently retires an irreversible ask nobody answered, and
`supersedesInteractionIds` is the supported replacement. But AC2 reserves this call for the CEO,
so it is not mine to make and nothing further is edited until ruled on.

Option B: keep RBR-852's single-candidate behaviour and narrow RBR-875 to "default `false` only
when 2+ candidates are pending". This weakens RBR-875 to a no-op — `selectCommentSupersededRows`
already expires nothing in the multi-candidate case, so there would be no change left to make.

## Also found: RBR-877 is a byte-identical duplicate of RBR-875

`RBR-877` (`fd6e4979-83a7-4146-9d52-e0e40cd950c7`, `todo`) and `RBR-875`
(`48881e42-d52b-4ee0-ba45-eb025e5a5675`, `in_progress`) carry the same title and the same
description, and both are assigned to the CTO. Neither has any blocker edge
(`blockerIssueIds: null` on both), so the `blockedBy: [RBR-852]` edge that RBR-877 was created to
carry does not actually exist on it. Only one should stay open; RBR-875 is the one with the work
and the commit. Recommend cancelling RBR-877 as the duplicate.
