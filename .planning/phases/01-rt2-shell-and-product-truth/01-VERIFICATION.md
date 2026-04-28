---
status: passed
phase: 01-rt2-shell-and-product-truth
updated: 2026-04-24
---

# Phase 1 Verification - RT2 Shell and Product Truth

## Result

Phase goal is achieved.

- RT2-first shell cutover is present in the UI and matches the Phase 1 product-shape requirements.
- `pnpm -r typecheck` passes.
- `pnpm build` passes.
- `pnpm test:run` passes.

## Verified Must-Haves

1. Company landing defaults to `/:companyPrefix/one-liner`.
2. Top-level navigation exposes `One-Liner`, `Knowledge`, `Marketplace`, `P&L`, `Org`, and `Governance`.
3. Legacy Paperclip surfaces remain reachable under a secondary control-plane path.
4. Stub-only collaboration and quality routes were not promoted to first-class RT2 navigation.

## Gap Closure Notes

The previously recorded Windows runtime/worktree failures are closed:

- `server/src/__tests__/opencode-local-adapter-environment.test.ts`
- `server/src/__tests__/workspace-runtime.test.ts`
- `cli/src/__tests__/worktree.test.ts`

The main fixes were:

- Windows-safe direct execution for `node -e` runtime-service commands
- Windows-safe `pnpm` invocation inside workspace-runtime tests
- Bash provision env/path handling that stays truthful under Git Bash
- Assertion normalization for Windows path and line-ending differences

## Score

- Must-haves verified: 4/4
- Verification gates passed: 3/3
- Overall status: passed

## Recommended Next Step

```sh
$gsd-discuss-phase 2 --auto
```
