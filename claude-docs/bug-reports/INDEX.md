# Bug Reports — Pilot Backlog A3→A5 Review

Findings from a 9-dimension code review of backlog items **A3, A4/G, B4, A1a, A1b, A2, A5**
(commits `317035bc`, `8a6e9ed3`, `7dfe0db4`, `f6974dff`, `a1234a82`, `37ea5bcb`, `e004cac9`).

Review method: one reviewer per item applying the code-review skill (auth, injection, concurrency,
data integrity, error handling, API design, crypto, types, testing), then findings re-verified
against the real source before any fix.

## Reports

| ID | Item | Severity | Title | Status | Fix commit |
|----|------|----------|-------|--------|-----------|
| [BUG-001](BUG-001-a4g-silent-project-create-failure.md) | A4/G | HIGH | Silent project-create failure ships pilots without worktree isolation | Fixed | `bf1f7778` |
| [BUG-002](BUG-002-a3-silent-guards-patch-failure.md) | A3 | MEDIUM | Silent guards PATCH failure leaves stale budget cap | Fixed | `3b54202b` |
| [BUG-003](BUG-003-a5-prototype-unsafe-model-alias.md) | A5 | MEDIUM | Prototype-unsafe catalog model-alias lookup | Fixed | `69797e5d` |
| [BUG-004](BUG-004-a5-preview-install-divergence.md) | A5 | MEDIUM | Catalog import preview diverges from install (omits adapter/model defaults) | Fixed | `48801684` |
| [BUG-005](BUG-005-a1b-cold-rotation-comment-and-test-gap.md) | A1b/A1a | LOW | Cold-rotation comment contradicts outer threshold guard; missing rotation test coverage | Fixed | `d53332b7` (comment, concurrent) + `cd38b1e3` (tests) |
| [BUG-006](BUG-006-b4-test-slice-vacuous-assertions.md) | B4 | MEDIUM | Plan-gate criteria test slices to EOF — section assertions pass vacuously | Fixed | `a4aa4022` (concurrent session) |
| [BUG-007](BUG-007-a2-diff-only-reviewer-blind-spot.md) | A2 | LOW | Diff-only reviewer scope creates cross-file auth/concurrency blind spot | Fixed | `2a5de007` (code-reviewer, concurrent) + this commit (wiring-expert) |

> **Concurrent activity:** a second session was committing the same BUG-00x fixes to
> `pilot/b1-dogfood` during this work (BUG-005 comment, all of BUG-006, and the code-reviewer half of
> BUG-007). Their edits were byte-identical to the prescribed fixes, so they are accepted and credited
> above. This session completed the wiring-expert half of BUG-007, which the concurrent session left
> unfixed.

## Not fixed — working as intended

- **A1a-H1 / A1b cold-session rotation firing for age- or token-capped policies.** The reviewer
  flagged this as an unexpected behavior change. It is the *designed* behavior of A1b: any cold
  session (`>5min` gap, past the Anthropic prompt-cache TTL) rotates to avoid re-billing the full
  transcript on `--resume`, and the handoff/continuation summary preserves task continuity. Changing
  it would defeat the feature. See BUG-005 for the one genuine defect in this area (a stale comment).

## Severity legend

| Severity | Meaning |
|----------|---------|
| CRITICAL | Exploitable in production with minimal effort (data breach, auth bypass, corruption). None found. |
| HIGH | Exploitable under specific conditions; silent degradation of a safety/isolation feature. |
| MEDIUM | Will cause incidents under edge conditions; correctness/observability gaps. |
| LOW | Maintenance burden, doc drift, test-quality gaps. |
