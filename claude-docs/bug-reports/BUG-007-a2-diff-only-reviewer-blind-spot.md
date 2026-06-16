# BUG-007 — Diff-only reviewer scope creates cross-file auth/concurrency blind spot

| | |
|---|---|
| **Severity** | LOW |
| **Backlog item** | A2 — diff-first code review scope |
| **Origin commit** | `37ea5bcb` feat(agents): A2 diff-first code review scope |
| **Files** | `server/src/onboarding-assets/code-reviewer/AGENTS.md`, `server/src/onboarding-assets/wiring-expert/AGENTS.md` |
| **Category** | Testing Gaps / Instruction gap |
| **Status** | Fixed (two sessions — see Wiring-expert section) |

## Summary

A2 instructs the code reviewer to "read only the touched files for context — do not crawl the full
codebase." This is correct for most dimensions: wasted tokens on untouched files produce no signal.

But for **Authentication & Authorization** (dimension 1) and **Concurrency & Race Conditions**
(dimension 3), cross-file context is essential. A touched function may be missing an ownership
check that was only present in the caller, or it may break a lock invariant established in a
calling module. Neither issue is visible from the diff or the touched files alone.

## Root cause

The blanket "touched files only" restriction in step 2 of "How you operate" had no exception for
dimensions where one-hop neighbors (callers, imported dependencies) hold the missing guard.

## Fix

Added a scoped cross-file exception after step 2:

> **Cross-file exception for auth/concurrency (BUG-007).** For dimension 1
> (Authentication & Authorization) and dimension 3 (Concurrency & Race Conditions)
> only: also read the immediate callers of any touched exported function, and the
> files directly imported by the touched files, where those one-hop neighbors could
> hold a missing auth guard, ownership check, or lock that the diff alone won't
> reveal. Cap the trace at one hop — do not crawl the full codebase.

The one-hop cap preserves the intent of A2 (token discipline) while covering the structural gap.

## Wiring-expert side (added separately)

The code-reviewer fix above was authored by a concurrent session (`2a5de007`). It left the
**wiring-expert** prompt with the same over-restriction, which is worse there because cross-file
tracing *is* the wiring-expert's job: "Do not trace paths the diff never touches … following only
what the diff introduces or modifies" breaks the import-completeness and dead-code checks, since a
trace to the terminal effect routinely crosses untouched routers, DI/registration, and imported
helpers.

Reworded `wiring-expert/AGENTS.md` step 1–2 so the trace **starts** in the diff but then follows the
call chain through whatever files it traverses, stopping at the terminal effect — not at the first
untouched file. Unrelated files are still not crawled. Verified: `default-agent-instructions`,
`gate-instruction-backfill`, `review-gate-lens` tests → 27 passed.

## Notes

- The catalog `AGENTS.md` (`packages/teams-catalog/.../code-reviewer/AGENTS.md`) delegates to the
  `code-review` skill rather than inlining dimensions — it is not affected.
- No test added: this is an instruction text change. Coverage would require an LLM-in-the-loop test.
