# Comandero Review Queue Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore QA throughput in Comandero quickly by first fixing the hot-path gate failures that prevent valid QA verdicts from closing work, then hardening workflow-lane and ownership-repair behavior so the queue stays truthful.

**Architecture:** Preserve the current company-level release-gate QA resolver (`configured -> canonical -> single_fallback`) and the rule that only the authorized release-gate QA owner can close delivery work. Execute in two phases. Phase 1 is the incident hot path: parser/selection plus standalone closeout alignment so valid canonical QA verdicts can ship immediately. Phase 2 is follow-up hardening: workflow-lane blocker clarity, ownership-drift repair, and docs so the board state stays truthful and the problem does not recur silently.

**Tech Stack:** TypeScript, Express, Drizzle/Postgres, shared issue/workflow contracts, Vitest.

---

## Scope Check

This plan addresses the live runtime problems visible in Comandero on April 21, 2026:

1. `in_review` issues are being evaluated against stale canonical QA comments because newer comments from another QA agent are ignored after release-gate ownership resolves back to `QA and Release Engineer`.
2. Several canonical QA comments are semantically valid but fail parsing because the gate only understands a narrow set of summary and verification formats.
3. Workflow QA lanes can have a valid verdict comment but still remain open because the authorized owner or `qa-verdict` document contract is not satisfied in a way the gate can see.
4. The queue mixes runnable review work and policy-blocked review work, which makes the company look underfilled even when the COO refill logic is working.

This plan intentionally does **not** change:

- company-level release-gate resolver precedence
- the rule that `TESTS:na` / `BUILD:na` do not satisfy ship verification
- the workflow lane graph
- force-done / board override behavior

## Best Execution Order

This document is the best **full** plan, but the best **incident-response** execution order is narrower:

1. Task 1: capture the live regressions as tests
2. Task 2: broaden QA verdict parsing without weakening the gate
3. Task 3: align standalone QA gate evaluation and auto-close
4. Restart/redeploy the running server and re-check live Comandero behavior
5. Only then continue with Task 5 and Task 4 as follow-up hardening, depending on what still blocks the queue
6. Finish with Task 6 docs

Why this ordering:

- `COMA-1290` and `COMA-1303` are currently blocked by parser/finalization issues on the hot path
- `COMA-1178` and `COMA-1293` should stay blocked even after the hotfix
- workflow QA lane clarity (`COMA-1322`) matters, but it is not the first throughput bottleneck
- ownership-drift refill is recurrence prevention; the currently highest-value standalone issues are already assigned to the current authorized release-gate QA owner

## Live Regression Cases To Preserve

Use these live cases as the source-of-truth fixtures for the plan:

- `COMA-1178`
  - current authorized QA owner is `156e5dcf-8027-4b85-9609-719a5caab88f`
  - selected canonical comment starts with `[RELEASE CONFIRMED] ...`
  - gate result should remain blocked until a real `[QA PASS]` verdict exists
- `COMA-1290`
  - selected canonical comment has valid release markers and summary, but verification is written as prose/equality tokens
  - target result: gate accepts the latest canonical verification evidence and no longer reports `qa_gate_missing_verification`
- `COMA-1303`
  - selected canonical comment has valid release markers and Smart Review prose, but verification is still written in non-canonical token form
  - target result: same as `COMA-1290`
- `COMA-1293`
  - selected canonical comment is marker-only and should remain blocked until a real summary + verification exists
  - the plan must not weaken the gate enough to let this ship
- `COMA-1322`
  - workflow QA lane has a valid authorized verdict comment
  - lane still blocks because ownership/doc requirements are unresolved
  - target result: workflow gate reports the real blocker clearly and completes once the owner/doc contract is actually satisfied

## Working Rules

- Use `@test-driven-development` throughout.
- Use the live Comandero comment shapes above as regression fixtures, but redact them down to the minimum text needed for tests.
- Keep changes company-scoped and preserve same-issue recovery semantics.
- Do not relax release-gate ownership so that arbitrary QA comments become shippable.
- Prefer additive parsing and clearer ownership repair over schema changes.
- Update `doc/PRODUCT.md` and `doc/SPEC-implementation.md` in the same change.

## File Structure

### QA gate parsing and selection

- Modify `server/src/services/qa-gate.ts`
  - expand accepted summary/verification formats for heartbeat-produced verdicts
  - keep aspirational prose and partial markers rejected
- Modify `server/src/__tests__/qa-gate.test.ts`
  - add fixtures for the live `COMA-1178`, `COMA-1290`, `COMA-1303`, and `COMA-1293` comment shapes

### Standalone issue gate and auto-close alignment

- Modify `server/src/routes/issues.ts`
  - ensure issue QA gate evaluation surfaces ownership mismatch and parser results consistently
- Modify `server/src/services/issue-qa-finalization.ts`
  - keep auto-close behavior aligned with the same authorized-owner + selected-comment rules
- Modify `server/src/__tests__/issue-qa-finalization.test.ts`
  - add close/no-close coverage for canonical-owner prose verdicts and foreign-owner verdicts
- Modify `server/src/__tests__/issue-qa-gate-routes.test.ts`
  - cover API-visible gate reasons for the same fixtures

### Review ownership repair and refill

- Modify `server/src/services/heartbeat.ts`
  - ensure review ownership mismatch is treated as actionable refill/correction state, not silent backlog
  - prefer waking or reassigning the authorized QA owner when review work is blocked only by stale/foreign ownership
- Modify `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
  - add regression coverage for reassignment + refill when the latest completion truth belongs to a now-non-authorized QA

### Workflow QA lane artifact clarity

- Modify `server/src/services/workflow-qa-lane-gate.ts`
  - keep comment-marker evaluation and `qa-verdict` document evaluation explicit and separately debuggable
- Modify `server/src/services/issue-workflows.ts`
  - align QA lane ownership correction and completion checks with the shared release-gate resolver
- Modify `server/src/__tests__/issue-workflows.test.ts`
  - cover `COMA-1322`-style lane ownership mismatch and missing-`qa-verdict` behavior

### Docs

- Modify `doc/PRODUCT.md`
  - document that review queues can contain blocked review work and what blocks count as runnable vs non-runnable
- Modify `doc/SPEC-implementation.md`
  - align standalone/workflow QA close semantics with the implemented parser and ownership repair
- Modify `docs/api/issues.md`
  - document the gate reasons and workflow QA lane blockers returned by the API

## Product Decision For This Plan

Keep the current release-gate ownership model and make it coherent.

Concretely:

- only the current authorized release-gate QA owner can produce the verdict that closes delivery work
- comments from another QA agent may still be useful operationally, but they must not count as the shipping verdict
- when ownership changes, the system must repair/re-wake the issue clearly enough that the queue does not look idle for mysterious reasons
- parser breadth may increase, but the ship gate must still require both review and verification evidence

## Task 1: Capture The Live Regressions As Tests

**Files:**
- Modify: `server/src/__tests__/qa-gate.test.ts`
- Modify: `server/src/__tests__/issue-qa-finalization.test.ts`
- Modify: `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Modify: `server/src/__tests__/issue-workflows.test.ts`

- [ ] **Step 1: Add failing parser fixtures for the live Comandero comment shapes**

Add reduced fixtures that model:
- release-confirmed-only comment for `COMA-1178`
- canonical QA comment with prose/equality verification for `COMA-1290`
- canonical QA comment with Smart Review prose plus non-bracket verification for `COMA-1303`
- marker-only canonical comment for `COMA-1293`

- [ ] **Step 2: Add failing closeout tests for authorized-owner vs foreign-owner verdicts**

Cover:
- canonical authorized owner verdict should close once parser recognizes it
- foreign-owner verdict must not close even if the prose looks valid
- marker-only canonical verdict must stay blocked

- [ ] **Step 3: Add failing workflow lane tests for comment-valid / doc-missing / owner-mismatch**

Cover:
- valid authorized comment but missing `qa-verdict` document stays blocked
- QA lane assigned to the wrong QA agent surfaces ownership blocker
- valid comment plus valid document plus authorized owner can complete

- [ ] **Step 4: Run the focused tests to confirm current failures**

Run:

```bash
pnpm vitest run server/src/__tests__/qa-gate.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts
```

Expected:
- FAIL on the new regression cases before implementation starts.

- [ ] **Step 5: Commit the failing-test checkpoint**

```bash
git add server/src/__tests__/qa-gate.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts
git commit -m "test: capture comandero qa gate regressions"
```

## Task 2: Broaden QA Verdict Parsing Without Weakening The Gate

**Files:**
- Modify: `server/src/services/qa-gate.ts`
- Modify: `server/src/__tests__/qa-gate.test.ts`

- [ ] **Step 1: Teach summary parsing to understand existing heartbeat prose**

Accept the reduced forms already seen in production comments, including:
- `Smart Review Summary: codeQuality=good, errorHandling=good, ...`
- `Code Quality: pass` / `Error Handling: pass` style lines when paired with real release markers

Do **not** treat generic “looks good” prose as a summary.

- [ ] **Step 2: Teach verification parsing to understand equality/prose tokens**

Accept forms such as:
- `TYPECHECK=pass`
- `TYPECHECK: pass`
- `SMOKE/NA=pass`

Map them onto the existing verification model without changing the rule that required checks must resolve to `pass`.

- [ ] **Step 3: Keep malformed or incomplete verdicts rejected**

Preserve negative coverage for:
- release-confirmed-only comments
- marker-only comments
- comments with `TESTS:na` or `BUILD:na`
- aspirational “next step: QA PASS later” prose

- [ ] **Step 4: Re-run the focused parser tests**

Run:

```bash
pnpm vitest run server/src/__tests__/qa-gate.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts
```

Expected:
- PASS for `COMA-1290` and `COMA-1303`-style fixtures
- PASS for the preserved negative cases

- [ ] **Step 5: Commit the parser slice**

```bash
git add server/src/services/qa-gate.ts server/src/__tests__/qa-gate.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts
git commit -m "fix: parse live qa verdict formats"
```

## Task 3: Align Standalone QA Gate Evaluation And Auto-Close

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/services/issue-qa-finalization.ts`
- Modify: `server/src/__tests__/issue-qa-finalization.test.ts`
- Modify: `server/src/__tests__/issue-qa-gate-routes.test.ts`

- [ ] **Step 1: Make route-level gate evaluation report ownership and content failures deterministically**

Ensure the route-level `qaGate` result is built from:
- comments authored by the current authorized release-gate QA owner
- the current issue assignee match check
- the broadened parser from Task 2

The result should not silently rely on comments from another QA agent.

- [ ] **Step 2: Keep auto-close and route gate on the same selected-comment rule**

Refactor or share logic as needed so:
- `computeIssueQaGate(...)`
- `finalizeQaValidatedIssueFromComment(...)`

both make the same author and selected-comment decision.

- [ ] **Step 3: Add regression coverage for live standalone cases**

Cover:
- `COMA-1290` closes once canonical verification prose parses
- `COMA-1303` closes once canonical verification prose parses
- `COMA-1178` stays blocked
- `COMA-1293` stays blocked
- foreign-owner comments still do not close the issue

- [ ] **Step 4: Run the standalone QA test set**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts
```

Expected:
- PASS for the new close/no-close cases.

- [ ] **Step 5: Commit the standalone alignment slice**

```bash
git add server/src/routes/issues.ts server/src/services/issue-qa-finalization.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts
git commit -m "fix: align standalone qa gate and auto close"
```

## Task 4: Make Ownership Drift Actionable In Heartbeat Refill

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`

- [ ] **Step 1: Write failing refill tests for ownership-drift review items**

Cover:
- an `in_review` issue whose latest visible completion truth came from a now-non-authorized QA agent
- reassignment to the current authorized QA owner
- immediate refill/wake once the issue is back under the authorized owner

- [ ] **Step 2: Update heartbeat review correction logic**

Requirements:
- ownership drift on release-gate review work is explicit correction state
- same-issue reassignment remains the default
- once corrected, spare-slot refill should wake the authorized owner instead of leaving the issue to age in `in_review`

- [ ] **Step 3: Preserve the recent refill fixes**

Re-run the recent QA refill regressions so this slice does not re-break:
- completion truth still refills open `in_review` delivery work
- skipped-live-limit wakes still bypass cooldown correctly

- [ ] **Step 4: Run the targeted heartbeat suite**

Run:

```bash
pnpm vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts
```

Expected:
- PASS, including the new ownership-drift coverage.

- [ ] **Step 5: Commit the heartbeat correction slice**

```bash
git add server/src/services/heartbeat.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts
git commit -m "fix: requeue review work after qa ownership drift"
```

## Task 5: Make Workflow QA Lane Blockers Truthful

**Files:**
- Modify: `server/src/services/workflow-qa-lane-gate.ts`
- Modify: `server/src/services/issue-workflows.ts`
- Modify: `server/src/__tests__/issue-workflows.test.ts`

- [ ] **Step 1: Write failing workflow QA lane tests from the `COMA-1322` pattern**

Cover:
- valid authorized verdict comment + missing `qa-verdict` document
- valid authorized verdict comment + wrong assignee
- valid authorized verdict comment + valid `qa-verdict` document + authorized owner

- [ ] **Step 2: Keep comment blockers and document blockers separate**

Refactor `evaluateWorkflowQaLaneGate(...)` so the failure reason is explicit:
- owner mismatch
- missing `qa-verdict` document
- missing Smart Review summary
- missing verification evidence

The lane should not read as a generic QA failure when the only problem is artifact persistence.

- [ ] **Step 3: Align workflow QA assignment repair with the same release-gate resolver**

In `issue-workflows.ts`, make sure QA lane creation/unblock/correction continues to use the same authorized owner rule that heartbeat and standalone issues use.

- [ ] **Step 4: Run workflow-focused tests**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-workflows.test.ts
```

Expected:
- PASS for the `COMA-1322`-style owner/doc cases.

- [ ] **Step 5: Commit the workflow slice**

```bash
git add server/src/services/workflow-qa-lane-gate.ts server/src/services/issue-workflows.ts server/src/__tests__/issue-workflows.test.ts
git commit -m "fix: clarify workflow qa lane blockers"
```

## Task 6: Document The New Review-Queue Semantics

**Files:**
- Modify: `doc/PRODUCT.md`
- Modify: `doc/SPEC-implementation.md`
- Modify: `docs/api/issues.md`

- [ ] **Step 1: Document runnable vs blocked review work**

Update docs so they explain:
- why `in_review` does not automatically mean “should consume another thread now”
- which QA blockers are parser/content blockers vs ownership blockers vs workflow artifact blockers

- [ ] **Step 2: Document the accepted QA verdict formats**

List the accepted marker/token forms that the gate now recognizes, including the broadened equality/prose variants.

- [ ] **Step 3: Document workflow QA lane artifact requirements**

Be explicit that workflow QA completion requires:
- authorized QA owner
- valid QA verdict comment
- `qa-verdict` issue document

- [ ] **Step 4: Run docs-adjacent verification**

Run:

```bash
pnpm -r typecheck
pnpm build
```

Expected:
- PASS.

- [ ] **Step 5: Commit the docs slice**

```bash
git add doc/PRODUCT.md doc/SPEC-implementation.md docs/api/issues.md
git commit -m "docs: clarify review queue and workflow qa blockers"
```

## Verification Checklist

After all tasks, run:

```bash
pnpm vitest run server/src/__tests__/qa-gate.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/__tests__/issue-workflows.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected end state:

- `COMA-1290`-style and `COMA-1303`-style canonical comments are parseable and shippable
- `COMA-1178`-style and `COMA-1293`-style incomplete comments remain blocked
- ownership drift causes explicit correction/refill instead of silent queue aging
- workflow QA lanes report real owner/doc blockers instead of generic QA confusion
- docs explain why a review queue can look full without implying all items are runnable

## Open Question To Resolve During Execution

If the `qa-verdict` artifact problem on workflow lanes turns out to be a real persistence bug rather than an instruction/usage mismatch, stop after reproducing it and decide explicitly whether to:

1. map a generated QA work product into the required `qa-verdict` issue document automatically, or
2. keep the contract strict and improve agent instructions plus operator-visible error reporting

Do not silently loosen the workflow artifact contract without making that product decision explicit.
