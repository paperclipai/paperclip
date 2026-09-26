# cracked-dev state

Repo: paperclipai/paperclip · default branch: `master` · fork remote: `fork` (trelmitt/paperclip)
Isolation: run in a git worktree off origin/master (main tree has concurrent activity).

## Done
- **run-classifier safety axis (TWE-182, partial)** — `server/src/services/run-liveness.ts`.
  Fixed the NEGATED_BLOCKER bypass (approval/manager now evaluated before the "not blocked"
  short-circuit) and routed `manager_review` to `needs_followup` before the concrete-evidence
  "advanced" path so risky productive runs escalate instead of auto-continuing. +4 adversarial
  tests. VERIFY: 18/18 tests, server typecheck, shared build — all green. Self-audit: CLEAN.

## Ruled out / deferred (this cycle)
- Persisting the `actionability` axis on `heartbeat_runs` (schema/migration) + wiring
  `manager_review` into the recovery escalation subsystem — RISKY (migration) and larger;
  left as the structured-run-self-report follow-up. Do not re-scope into this PR.

## Repo conventions learned
- Tests: `pnpm --filter @paperclipai/server exec vitest run <path>`; typecheck needs
  `@paperclipai/shared` built first. No `--state all` on `gh search prs`.
- PR template enforces a dedup-search checkbox (a bot fails `review` until it's checked with
  real linked PRs). `trelmitt` has no upstream write — PRs go via the `fork` remote.

## Next candidates (ranked)
1. heartbeat `setInterval` reentrancy guard (S, correctness).
2. Company memory table + recall tool (L, foundational).
3. Evals in CI + run-liveness golden corpus (M).
