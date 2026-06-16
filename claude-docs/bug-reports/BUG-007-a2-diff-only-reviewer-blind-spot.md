# BUG-007 — Diff-only reviewer scope creates cross-file auth/concurrency blind spot

| | |
|---|---|
| **Severity** | LOW |
| **Backlog item** | A2 — diff-first code review scope |
| **Origin commit** | `37ea5bcb` feat(agents): A2 diff-first code review scope |
| **File** | `server/src/onboarding-assets/code-reviewer/AGENTS.md` |
| **Category** | Testing Gaps / Instruction gap |
| **Status** | Fixed |

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

## Notes

- The catalog `AGENTS.md` (`packages/teams-catalog/.../code-reviewer/AGENTS.md`) delegates to the
  `code-review` skill rather than inlining dimensions — it is not affected.
- No test added: this is an instruction text change. Coverage would require an LLM-in-the-loop test.
