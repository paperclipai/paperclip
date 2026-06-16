# BUG-006 — Plan-gate criteria test slices to EOF — section assertions pass vacuously

| | |
|---|---|
| **Severity** | MEDIUM |
| **Backlog item** | B4 — strengthen architect plan-gate with 3 adversarial criteria |
| **Origin commit** | `7dfe0db4` feat(server): strengthen architect plan-gate with 3 adversarial criteria (B4) |
| **Fix commit** | `a4aa4022` fix(test): scope B4 architect-criteria assertions to their own sections |
| **File** | `server/src/__tests__/architect-plan-gate-criteria.test.ts` |
| **Category** | Testing |
| **Status** | Fixed (by a concurrent session — see note) |

## Summary

The B4 test asserts that each of the three adversarial criteria marks its concern as `` `blocking` ``.
Each per-criterion test sliced the AGENTS.md content with `content.slice(content.indexOf(header))` —
which runs to **end of file**. Because every later section also contains the word `` `blocking` ``,
the projection and scalability assertions could pass *vacuously* from text in a later section rather
than the section under test. Three of the four assertions were unreliable: a criterion could lose its
`blocking` label and the test would still pass.

## Root cause

`slice(indexOf(header))` with no end bound — section isolation was not enforced.

## Fix

Each slice is now end-bounded at the next section header:

- projection → up to `Scalability and bounds`
- scalability → up to `Test-harness wiring`
- test-harness → up to the next `\n## ` heading

The same commit also corrected a stale gate-count expectation in `plan-gate-activation.test.ts`
(B1 + B2 added the 3-lens code-review and completeness gates; the old expectation of 5 predated B1;
correct is 11 for two leaves).

## Verification

- `npx vitest run src/__tests__/architect-plan-gate-criteria.test.ts` → **4 passed**.
- Full touched-test sweep (architect-criteria + session-rotation + teams-catalog) → **54 passed**.

## Note — concurrent session

This bug was fixed by commit `a4aa4022`, authored by a **second session working `pilot/b1-dogfood`
at the same time** (identical BUG-numbering and Co-Authored-By signature). The fix matches what this
review prescribed, so it is accepted as-is and documented here rather than re-done. The unaddressed
B4 limitation — the tests verify documentation strings, not runtime gate behavior — remains open as
intended (prompt-asset content tests; a behavioral test would need to drive a violating plan through
the architect gate).
