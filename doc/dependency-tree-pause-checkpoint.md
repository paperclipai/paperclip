# Dark supplied-transaction pause creation checkpoint

`createIssueTreePauseHoldInTransaction` captures company/root/reason/actor scalars synchronously, awaits the company lifecycle fence before actual canonical preview, then stores the hold and member snapshots on that supplied transaction. It owns no transaction or publication. Only pause with manual release policy is supported; arbitrary mode/releasePolicy/metadata extras are projected out. It does not authenticate actor fields or authorize live pause.

The canonical non-resume persistence block is extracted into private `persistIssueTreeHold`. Ordinary pause/cancel/restore keep their pre-transaction preview and owned transaction behavior; resume is not migrated. The dark participant uses the same persistence helper and actual preview. No production caller uses this entry. This is NOT common serialization, restoration wiring or atomicity acceptance.

## Executed evidence

Server cwd, credentials and DATABASE_URL unset, profile scratch TMPDIR. Runner: `/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts`, flags `--pool=forks --maxWorkers=1 --testTimeout=15000`.

Initial pause test: 1 expected missing-export FAIL (1.36s). Implementation: 1 PASS (1.41s). Expanded pause/release: 15 PASS (2.21s). Final twelve suites: 195 PASS (17.89s), including nine pause cases, eight release cases, one existing root guard and the existing dark canonical suites. Temporary missing-await mutant: routing suspension control 1 FAIL/8 skipped, preview issue reads escaped the pending fence; removed before delivery.

Synthetic SQL-builder projections only, no PostgreSQL/SQL execution/server/adapter. Controls record supplied-tx fence/order, hold/member linkage, actor/routing/reason containment, fence failure zero domain effects, terminal skipped snapshot, runtime extras exclusion, member insertion rejection propagation and ordinary pause/cancel/restore owned transaction behavior. The eager hold recorder remains written on member failure; that is explicitly NOT rollback evidence.

## Dark owning-transaction opt-in

Canonical `createHold` now accepts the internal `lifecycleFence` opt-in. Before any domain read, it captures reason and actor scalars and starts the root-owned transaction; its callback delegates to the existing supplied-transaction pause participant. No production callsite opts in. Ordinary callers retain their old path. This is pre-read ownership integration, NOT common serialization or production restoration wiring.

The restricted opt-in supports only `mode=pause` with absent/null releasePolicy (default manual). It rejects cancel/restore/resume and every explicit policy, including explicit manual, with 422 before transaction startup or domain effects. This is a deliberately narrower dark contract, not preservation of arbitrary policy input. Actor fields are caller data, not authenticated authority.

Executed server runner with the same environment/flags above: initial owned entry root-read sentinel 1 expected FAIL/9 skipped (1.38s); implementation 10 PASS (1.53s). Expanded pause/release/unit 26 PASS (2.50s). Eight new controls record root-owned transaction before fence/preview, deferred-startup scalar containment, pending fence and rejection, unsupported mode/policy no-effect veto and delayed transaction-return publication. This delayed-return control does NOT establish database commit or rollback semantics. Actor-reference mutant 1 FAIL/16 skipped (1.26s); guard-removal mutant 4 FAIL/13 skipped (1.27s). Both removed. Final twelve suites 203 PASS (18.11s), exit 0. Typecheck/build/full gates not executed.

## Remaining prerequisites

Ordinary tree writers do not share this fence. Concurrent parent edits, hold insertion/release, all gates/owner/re-block/delete/checkout/native/finalize writers still need common pre-read participation. Preview is not a strict complete-ancestry proof, synthetic company projections do not execute predicates, and this fixture has only one root/no active run. No multi-level member exclusion, actor authorization, database lock/concurrency/rollback or native ledger/effect flush is established. Coordinator remains UNWIRED. Queue admission/revalidation/orphan expiry and approved live fifteen-minute bound remain missing. Retain queue_hygiene. Existing human-only DB question and separate merge/deploy/activation gates remain unchanged.
