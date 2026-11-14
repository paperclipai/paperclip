# Restart chaos ledger

Companion to `2026-11-06-control-plane-restart-chaos.md`. One section per wave.
Classes: P product · Q agent quality · T test/harness · E unrelated environment.

## Phase 0 — 2026-11-06

Master: `6cafcaf89b`. Host: macOS, local runner (Daytona image pending a CI build).

| Check | Result |
| --- | --- |
| `controller-replacement-smoke.ts` (no agent) | PASS, 39 s, Postgres survived replacement |
| Local restart cells, first run | 0/7 — **T**: worktree `node_modules` older than lockfile (UI missing `mdast-util-from-markdown`). Not counted. |
| Local restart cells, rerun | **2/7** (below) |
| Daytona runner image | Blocked. Local build failed: stale Dockerfile lock pin, then the Docker VM ran out of disk. Moved to CI (`runner-full-stack-e2e.yml`, manual dispatch) after PR #19467. |

### Local baseline rerun (`local-2026-11-06T14-27-42-229Z`)

| Cell | Result | First error | Fixer |
| --- | --- | --- | --- |
| stock-harness · Codex · continuity-restart | PASS | — | — |
| stock-harness · ACPX Claude · continuity-restart | PASS | — | — |
| everyday-workflows · Codex · recover-controller | FAIL (cleanup_failure) | `kill EPERM` during owned-tree cleanup at the restart | subagent: EPERM |
| everyday-workflows · ACPX Claude · recover-controller | FAIL | Timed out waiting for an active run with saved source | subagent: Claude recover |
| stock-harness · OpenCode · continuity-restart | FAIL | Timed out waiting for the chat turn to settle to waiting | subagent: OpenCode |
| local-session-integrity · OpenCode · question-restart-resume | FAIL | Timed out waiting for the pending user question | subagent: OpenCode |
| completion-updates · Codex · handoff-completion-restart | FAIL | Timed out waiting for the worker to wait while the originating chat is idle | subagent: handoff |

#### Signatures found

| ID | Class | Signature | Status |
| --- | --- | --- | --- |
| RC-01 | T | Harness looked for saved source only at the workspace root; ACPX Claude saved `slugify-tool/slugify.py`, so the restart never fired | PR #19471 (open) |
| RC-02 | **P** | ACPX turn active at restart: runner closes it with `acpx_active_turn_recovery_closed` and no error, the control plane reports a generic "Provider turn failed", no continuation, queued follow-up unconsumed (fails R1). Codex has had this handled since #15297; ACPX is excluded by `provider.kind === "codex"` and `driverKind === "codex_app_server"` gates | fixer running |

| RC-03 | T | macOS `killpg` returns EPERM (not ESRCH) on a zombie-only group; the supervisor rethrew it and aborted the restart. Fixed cell passed 2/2, and native Codex recovery itself works | PR #19470 (open) |
| RC-04 | P (latency) | Graceful shutdown always waits the full 30 s heartbeat finalizer drain when a native run is restart-suspended (`server/src/index.ts` ~L2032, `drainActiveRunExecutions`). Every graceful restart (K2) or deploy takes ≥30 s and, under the harness, escalates to SIGKILL | queued for a fixer |

| RC-05 | **P** | Dead Retry after restart (fails R3): Retry accepted but no run for >15 min, stuck at `retryWait.reason=execution_recovery`. After the next restart the Retry vanished (`waiting_for_user`, `canRetry=false`). OpenCode t01, Claude t02 | fixer running (with RC-06) |
| RC-06 | **P** | False over-budget stop after restarts: a new issue was blocked "original recovery target is over budget" at 22¢ of 500¢, then a company `hard_stop` with `pendingRunCount=1`, `reservationCents=0`, `unpricedUsagePolicy=block` (`recovery/service.ts` ~L4826). Codex t03 never ran | fixer running (with RC-05) |
| RC-02b | **P** | OpenCode mid-turn kill also ends as a provider failure (t01). Sent to the RC-02 fixer | with RC-02 |

### Harness smoke `w-20261106T144559-s7` (seed 7, K1 ×3, local, concurrency 2)

0/3 pass. The harness worked: every failure is product-side (RC-02b, RC-05, RC-06). Branch `worktree-agent-a826af5179b88689b` @ `e864139cec`, not yet a PR.

Setup note: fresh worktrees need `pnpm install --frozen-lockfile` and a built `paperclip-runnerd` (`pnpm --filter @paperclipai/paperclip-runner build`) before native cells can run. The chaos harness must check this before starting a wave.

Classification of the remaining cells is pending each fixer's diagnosis. A timeout before the restart point counts against setup or the agent, not restart robustness.

### Side findings

- Nightly Runner Full-Stack E2E never builds a Daytona image. Its operating-overhead allowance (`RUNNER_E2E_OPERATING_OVERHEAD_JSON`) expired 2026-11-03, and the nightly sets `needs_daytona=false` anyway. PR #19467 (merged, 7e6d882558) names the error and removes the stale Dockerfile lock default. The nightly stays red until the allowance is renewed (Dotta's call).
- Image build moved to CI: manual dispatch run 42240434011 (`core-compatibility.runner-codex.daytona.message-marker`), 2026-11-06 15:09Z.
- `tests/runner-e2e/workflow-security.test.ts` has 5 local failures in `pr-trusted.yml` and `chat-catalog-testops-case.yml`. Not investigated.
