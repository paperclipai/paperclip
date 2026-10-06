# CRE-1348 Medium F1: effective hook preflight

SOURCE/MOCK only. No production caller, DB, listener, adapter or activation.

Owned canonical answer preflight now reads effective beforeResolveInTransaction
and afterResolveInTransaction values in addition to preserving own-enumerable
extra-key denial. Non-null inherited, non-enumerable and class prototype hooks
are rejected with 422 before transaction startup, reads or writes, rather than
silently discarded. Getter errors propagate before effects. Ordinary omitted
and false opt-in still execute inherited hooks. This is owned-entry only;
no supplied-entry protocol changes are claimed.

Six permanent representation controls initially failed with resolved answered
cards instead of 422: 6 FAIL / 34 skipped, 6.12s, exit 1. After source fix,
four explicit answer/withdrawal supplied/owned/native files: 100 PASS, 8.65s.
Added two getter error and two ordinary parity controls; final four files:
104 PASS, 8.86s, exit 0. No test timeout.

Command (server cwd):
env -u PAPERCLIP_API_KEY -u DATABASE_URL -u FORGEJO_TOKEN
TMPDIR=/Users/rpridal/.hermes/profiles/paperclip-infra/cache/scratch
/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run
--config vitest.config.ts src/__tests__/interaction-lifecycle-answer.test.ts
src/__tests__/interaction-lifecycle-withdraw.test.ts
src/__tests__/interaction-lifecycle-withdraw-owned.test.ts
src/__tests__/interaction-lifecycle-withdraw-native.test.ts
--pool=forks --maxWorkers=1 --testTimeout=15000
Initial focused RED uses only answer file and -t 'denies effective canonical owned hook'.

Actual canonical service with synthetic rows and SQL recording is not SQL
isolation, authority, concurrency, commit or rollback evidence. No typecheck,
build, full gates, original writer RED or route/listener replay. Original
missing-intent writer is not fixed. Restoration remains unwired; queue admission,
orphan expiry and live 15-minute acceptance remain outstanding. PR conflict
requires separate rebase and fresh-head validation/review. Existing human-only
DB scope stays pending; no merge/deploy grant. Independent exact-head review
must assess this delta before subsequent answer/native integration.
