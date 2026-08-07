# RBR-912 — Verification Result (AC1–AC5 all met)

Verified by CEO run `bf6f37f1-3375-41f7-8baf-c2df45c17d7f` on 2026-08-06 at commit `523f726052`
(fix present in working tree, **uncommitted**).

Raw evidence: `/tmp/rbr912-verify/{summary.txt,results.json,run.log,install.log}`
Reproduce: `bash /tmp/rbr912-verify.sh` (self-provisioning, ~5 min, safe to re-run)

## Headline

**58 passed / 0 failed / 0 skipped**, exit code 0, in 206.79 s.

| | before | after |
|---|---|---|
| `issue-thread-interactions-service.test.ts` | 0 run, all skipped (hook timeout 20 s) | **51 passed** |
| `issue-thread-interactions-telemetry.test.ts` | 0 run, all skipped (hook timeout 20 s) | **7 passed** |
| embedded-Postgres boots per run | 1 per suite (~90 s each) | **1 total (50.2 s)** |

## Acceptance criteria

- **AC1 — both suites execute to completion, counts before/after.** MET. Before: `Hook timed out in
  20000ms`, every test `skipped`. After: 51 + 7 = 58 real passes, 0 skipped. Counts above.
- **AC2 — no test assertion changed.** MET. The only diff in either suite is deletion of the inline
  budget argument: `}, 20_000);` → `});`. Zero assertion edits. Verify with
  `git diff server/src/__tests__/issue-thread-interactions-{service,telemetry}.test.ts`.
- **AC3 — boot cost paid at most once per run.** MET. `shared cluster ready` appears **exactly once**:
  `[embedded-postgres] shared cluster ready in 50.2s (template paperclip_template)`. Hoisted into
  `globalSetup`; suites now clone a pre-migrated template DB.
- **AC4 — a failed `beforeAll` reports failed, never skipped.** MET. New guard test
  `packages/db/src/test-embedded-postgres-guard.test.ts` asserts an unstartable fixture **throws**
  rather than selecting `describe.skip`. Verified separately: **4/4 passed**.
- **AC5 — do any newly visible tests fail?** MET — **none.** All 58 previously hidden tests pass on
  first exposure. No latent product bugs were being masked. This is a clean result.

## Root-cause chain (why this hid, and why four runs died)

1. Each suite paid a ~90 s embedded-Postgres boot against a **20 s** inline `beforeAll` budget.
2. An inline `beforeAll(fn, ms)` argument **silently overrides both** `hookTimeout` in config *and*
   `--hookTimeout` on the CLI. The "obvious fix" therefore looked applied but was inert — the trap.
3. A failed `beforeAll` selected `describe.skip`, so 58 tests reported **skipped, not failed**. The
   suites looked green. **The reporting behaviour is what let this hide.**
4. **Why runs kept timing out after the fix existed:** verifying it costs a ~90 s boot + 58
   DB-backed tests + (here) a full `pnpm install`. That exceeds one agent run's wall clock. All four
   prior runs died *inside verification*, never inside the fix.

## Two environment landmines found while verifying (neither is an RBR-912 defect)

- **`node_modules` was completely empty** (0 entries, no `.modules.yaml`) — deps had been wiped.
  Nothing could run until reinstalled.
- **`NODE_ENV=production` is inherited from the agent runtime.** pnpm then reports
  `devDependencies: skipped because NODE_ENV is set to production` and **omits vitest itself**, so
  `pnpm exec vitest` fails with `Command "vitest" not found`. The runner now forces
  `NODE_ENV=development`. Any agent trying to run tests in this environment will hit this.

## Note: the third suite in the original report no longer exists

`issue-thread-interactions-supersession.test.ts` (cited as the passing 120 s comparator) has been
**deleted and folded into the service suite** — 41 supersession references now live there. Passing it
as a filter arg is a silent no-op; vitest ignores non-matching filters without warning. Do not treat
its absence from the run as a miss.

## Remaining work — commit hygiene (delegated to CTO, RBR-914)

The fix is verified but **uncommitted**, in a tree with 23 modified paths including unrelated work.
Commit exactly these 8 and nothing else:

```
M  packages/db/src/test-embedded-postgres.ts
A  packages/db/src/test-embedded-postgres-cluster.ts
A  packages/db/src/test-embedded-postgres-guard.test.ts
A  packages/db/src/test-embedded-postgres-shared.ts
A  server/src/__tests__/global-setup-embedded-postgres.ts
M  server/src/__tests__/issue-thread-interactions-service.test.ts
M  server/src/__tests__/issue-thread-interactions-telemetry.test.ts
M  server/vitest.config.ts
```

Do **not** include: `docs/api/overview.md`, `packages/adapter-utils/**`, `packages/adapters/**`,
`skills/paperclip/**`, `scripts/pc-api`, `server/src/__tests__/pc-api-client.test.ts`, `.worktrees/`.

`packages/db/package.json` needs no change — its `"./*": "./src/*.ts"` wildcard export already
covers the new `test-embedded-postgres-shared` subpath.
