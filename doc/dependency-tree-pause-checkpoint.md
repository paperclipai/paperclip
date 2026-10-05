# Dark supplied-transaction pause creation checkpoint

`createIssueTreePauseHoldInTransaction` captures company/root/reason/actor scalars synchronously, awaits the company lifecycle fence before actual canonical preview, then stores the hold and member snapshots on that supplied transaction. It owns no transaction or publication. Only pause with manual release policy is supported; arbitrary mode/releasePolicy/metadata extras are projected out. It does not authenticate actor fields or authorize live pause.

The canonical non-resume persistence block is extracted into private `persistIssueTreeHold`. Ordinary pause/cancel/restore keep their pre-transaction preview and owned transaction behavior; resume is not migrated. The dark participant uses the same persistence helper and actual preview. No production caller uses this entry. This is NOT common serialization, restoration wiring or atomicity acceptance.

## Executed evidence

Server cwd, credentials and DATABASE_URL unset, profile scratch TMPDIR. Runner: `/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts`, flags `--pool=forks --maxWorkers=1 --testTimeout=15000`.

Initial pause test: 1 expected missing-export FAIL (1.36s). Implementation: 1 PASS (1.41s). Expanded pause/release: 15 PASS (2.21s). Final twelve suites: 195 PASS (17.89s), including nine pause cases, eight release cases, one existing root guard and the existing dark canonical suites. Temporary missing-await mutant: routing suspension control 1 FAIL/8 skipped, preview issue reads escaped the pending fence; removed before delivery.

Synthetic SQL-builder projections only, no PostgreSQL/SQL execution/server/adapter. Controls record supplied-tx fence/order, hold/member linkage, actor/routing/reason containment, fence failure zero domain effects, terminal skipped snapshot, runtime extras exclusion, member insertion rejection propagation and ordinary pause/cancel/restore owned transaction behavior. The eager hold recorder remains written on member failure; that is explicitly NOT rollback evidence.

## Remaining prerequisites

Ordinary tree writers do not share this fence. Concurrent parent edits, hold insertion/release, all gates/owner/re-block/delete/checkout/native/finalize writers still need common pre-read participation. Preview is not a strict complete-ancestry proof, synthetic company projections do not execute predicates, and this fixture has only one root/no active run. No multi-level member exclusion, actor authorization, database lock/concurrency/rollback or native ledger/effect flush is established. Coordinator remains UNWIRED. Queue admission/revalidation/orphan expiry and approved live fifteen-minute bound remain missing. Retain queue_hygiene. Existing human-only DB question and separate merge/deploy/activation gates remain unchanged.
