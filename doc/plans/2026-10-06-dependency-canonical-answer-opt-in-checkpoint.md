# Canonical answer owned opt-in checkpoint

SOURCE/MOCK-only. No production caller, database, listener, adapter, merge or activation.

The canonical issueThreadInteractionService.answerQuestions now accepts a separate seventh lifecycleOptions argument. lifecycleFence=true delegates synchronously to the existing owned answer boundary before any domain read. Effective routing/input/audience capture occurs before transaction startup. Explicit suppliedTx and arbitrary mutation hooks are rejected before effects rather than nested or silently discarded. Omitted/false callers retain their existing read, owned write, touch and telemetry behavior. Supplied callers continue using the existing sixth-argument contract.

The service's db must be the actual root database: presence of transaction does not verify root identity. Never opt in a service(tx) under earlier locks. Delivery dispatch/touch/telemetry remain caller-owned in the dark branch. Receipt ordering is not SQL commit, rollback, provider settlement or authenticated authority.

Recording verification from server cwd with env -u PAPERCLIP_API_KEY -u DATABASE_URL -u FORGEJO_TOKEN, profile TMPDIR, /opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts, --pool=forks --maxWorkers=1 --testTimeout=15000:

Initial canonical owned opt-in test: 1 expected root-read FAIL / 26 skipped, 5.55s. After implementation standalone 27 PASS, 5.04s. Expanded answer plus supplied/owned/native withdrawal: four actual files, 94 PASS, 9.64s. Eight new controls include direct typed canonical entry, hooks/supplied-transaction denial, truly omitted/false parity, deferred startup with inherited audience veto and outer-rejection propagation. No new mutation sensitivity replay.

Fixture executes real canonical normalization/audience/writer with synthetic SQL rows; settings/chat/telemetry are mocked. Eager answered/delivery rows survive simulated outer rejection: explicitly not rollback evidence. Native answer/provider delivery, valid agent-run composition, common lifecycle serialization, restoration wiring, native ledger/effects/legacy intents, queue admission/orphan expiry and live 15-minute acceptance remain incomplete. Full typecheck/build/gates were not executed. Independent exact-head source/mock review and separate rebase/fresh-head validation remain necessary.
