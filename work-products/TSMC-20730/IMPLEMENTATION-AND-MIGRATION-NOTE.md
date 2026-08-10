# TSMC-20730 — Per-run token ledger + board exception guard

Scope: one deliverable only — persisted per-run input/cache/output token ledger,
plus an explicit board-exception record that gates the ≥1M raw-input guard, with
a soft warning at 250k total. Focused automated tests + this migration note.
Operating cap 200k tokens. Other guard domains (circuit breaker, unscoped-run
FinOps, concurrency, routine ceiling) were **not** touched — they are sibling
child issues of the parent `Fleet-class token and retry circuit breakers`.

Branch: `feat/tsmc-per-run-token-ledger-board-exception` (off `live`).

## What already existed on `live` (not re-done)

- Per-run token ledger: `cost_events` (`input_tokens` / `cached_input_tokens` /
  `output_tokens`, FK `heartbeat_run_id`) — the authoritative per-run row written
  by `updateRuntimeState` → `costs.createEvent` in `server/src/services/heartbeat.ts`.
- The ≥1M raw-input guard: `HIGH_INPUT_TOKEN_RUN_THRESHOLD`,
  `decideHighInputTokenRunGuard` (first oversized run → review, second → block),
  `totalInputTokensIncludingCache`, and `enforceHighInputTokenRunGuard` which sets
  the issue `in_review` (first) / `blocked` with a board `unblockDescriptor`
  (second).
- Raw usage (incl. `rawInputTokens`) persisted in `heartbeat_runs.usage_json`.

So deliverable #1's "persisted ledger" was already met by `cost_events`. The real
delta for this card was **(a)** the 250k soft warning and **(b)** a structured,
enforceable board-exception record (task / cap / reason / expiry).

## Changes in this branch

### 1. New table `board_token_exceptions` (the explicit board exception record)
- Schema: `packages/db/src/schema/board_token_exceptions.ts` (exported from
  `schema/index.ts`).
- Columns: `id`, `company_id`, `issue_id` (**task**), `agent_id` (optional scope,
  null = any agent on the task), `cap_tokens` (**cap**, bigint), `reason`
  (**reason**), `expires_at` (**expiry**), `created_by_user_id`,
  `created_by_agent_id`, `revoked_at`, `created_at`. Index on
  `(company_id, issue_id)`.
- This directly satisfies parent requirement #6: "the exception must name the
  task, cap, reason and expiry."

### 2. Soft 250k total-token warning (non-blocking)
- `TOKEN_LEDGER_WARN_THRESHOLD = 250_000` + pure `decideTokenLedgerWarning(...)`
  in `heartbeat.ts`. Total = input + cache + output. Fires **only** in the band
  below the ≥1M hard guard (the hard guard owns everything above it).
- Emission: one `warn` lifecycle run-event in `enforceHighInputTokenRunGuard`.
  It never changes issue status or continuation — observation only, so an
  operator sees a lane trending expensive before it hits the hard stop.

### 3. Board-exception gate on the ≥1M guard
- Pure `decideBoardTokenException({exception, totalInputTokens, now})` →
  `none | allow | expired | revoked | cap_exceeded` in `heartbeat.ts`
  (strict `expiresAt > now`; cap compared against total input incl. cache).
- In `enforceHighInputTokenRunGuard`, once a run is ≥1M and would be
  reviewed/blocked, it looks up the newest active exception for
  `(company_id, issue_id)` preferring an agent-scoped row over a task-wide one.
  - `allow` → the run is permitted; an `info` run-event + `issue.high_input_run_exception_allowed`
    activity record the consumed exception (id, cap, reason, expiry). No review/block.
  - Any other state → falls through to the existing review/block, and the system
    comment now states whether a board exception was on record and why it was not
    honoured (`expired` / `revoked` / `cap_exceeded` / `none`), telling the owner
    exactly what a valid exception must cover.
- Call site passes `outputTokens` so the warning total is complete.

### 4. Migration `9011_board_token_exceptions.sql`
- Creates the table + FKs + index. Idempotent (`IF NOT EXISTS`, `DO $$ ...
  EXCEPTION WHEN duplicate_object`). New empty table → `CREATE INDEX` without
  `CONCURRENTLY` is safe.
- Uses the active manual `9xxx` series. It follows the subsequently landed
  `9010_routine_cadence_budget_guards` migration, so this branch's migration is
  `9011` after rebasing onto `live`; journal entry idx 209 is registered in
  `packages/db/src/migrations/meta/_journal.json`. Manual `9xxx` migrations carry
  no Drizzle snapshot.

## Verification (worktree)
- `pnpm --filter @paperclipai/db run check:migrations` → pass (numbering + safety).
- `pnpm --filter @paperclipai/db run typecheck` → pass.
- Server `tsc --noEmit` → **0 errors**.
- `vitest run` on `token-ledger-board-exception-guard.test.ts` +
  `heartbeat-high-input-token-guard.test.ts` → **16 passed** (8 new, existing
  guard suite unregressed).

New tests (`server/src/__tests__/token-ledger-board-exception-guard.test.ts`)
cover every hard-stop/allow path: warn below/at 250k, output-driven warn,
warn deferral above 1M; exception none / allow / expired / exact-expiry-instant /
revoked / cap_exceeded / exact-cap boundary / ISO-string expiry parsing.

## How TSB (or any company) configures it without patching runtime code
Insert a `board_token_exceptions` row for the bounded task: `issue_id`,
`cap_tokens`, `reason`, `expires_at` (+ optional `agent_id`). While it is
unrevoked, unexpired, and its cap covers the run, that task may cross 1M; revoke
by setting `revoked_at`. No shared-runtime change needed per exception. (A thin
create/revoke API/UI over this table is a natural follow-up but is out of this
card's single-deliverable scope.)

## Not deployed
Per Gate VA1/WT1: this is worktree-green, committed on the feature branch, **not**
merged to `refs/heads/live` and **not** promoted. Merge-to-live + promote is the
gated deploy step and needs approval. Sibling guard domains remain open on their
own child issues.
