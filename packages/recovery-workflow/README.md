# @paperclipai/recovery-workflow

Cloudflare Worker hosting `RecoveryWorkflow` — a durable, per-recovery-action orchestration
that replaces the server's full-table poll cadence with one workflow instance per action
(`instance_id = actionId`). Phase 1 of the Cloudflare-Workflows migration for paperclip
dispatch.

- **What it does:** loops `step.do("attempt-N")` → server internal API (`/internal/recovery/:actionId/attempt`, dry or active) → `step.sleep(nextIntervalMs)`, exiting when the server reports the action is no longer active. Durable, retryable, crash-surviving.
- **Headless:** plain Cloudflare Workflow (not `AgentWorkflow`) — no WebSocket/Agent layer.
- **Server is the single Postgres writer;** this Worker only orchestrates and calls the server's authenticated internal API (`x-internal-secret`).

## Develop / test
```bash
pnpm --filter @paperclipai/recovery-workflow exec tsc --noEmit   # typecheck
pnpm --filter @paperclipai/recovery-workflow exec vitest run     # unit tests (hand-mocked step + client)
```
> The loop logic lives in `src/loop.ts` (no `cloudflare:workers` import) so it's unit-testable
> under plain vitest. `vitest.pool.config.ts` (`@cloudflare/vitest-pool-workers`) is committed
> for future workerd-level tests; the current suite uses the hand-mock path.

## Deploy & go-live
See the runbook: `docs/superpowers/runbooks/2026-06-21-recovery-workflow-golive.md`
(requires Cloudflare account, `wrangler login`, and secrets; do the go-live prerequisites first).

## Design
See `docs/superpowers/specs/2026-06-21-cloudflare-workflows-recovery-design.md`.
