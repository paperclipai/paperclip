# Dark canonical reassignment expiry integration

The lifecycleFence opt-in of the real canonical issue update now calls the supplied-transaction connection-intent ownership-expiry participant. The preparation boundary already acquires the same company lifecycle fence before reads and row locks. The expiry participant re-enters that fence on the same transaction, after the canonical assignment update. It does not open a nested transaction. Ordinary omitted/false callers retain the existing ordinary hook. No production opt-in is enabled.

Recording regressions execute actual canonical update, user membership validator and connection-intent expiry. Settings and chat completion remain explicit unrelated mocks. Owned and supplied controls suspend the second fence: user-direction cancellation and assignment write have occurred, but interaction expiry and caller return have not. Fence rejection propagates without interaction expiry or callback return. Eager assignment recording survives rejection: this is not rollback evidence. Missing membership remains a no-write veto. Ordinary omitted/false behavior and unchanged ownership are controls.

Verification from server cwd, with PAPERCLIP_API_KEY, DATABASE_URL and FORGEJO_TOKEN removed and TMPDIR set to profile scratch:

/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/issue-update-lifecycle-validators.test.ts --pool=forks --maxWorkers=1 --testTimeout=15000

Initial: 4 expected FAIL / 4 PASS, returned rather than entered the supplied expiry fence (4.83s). After source integration and count-oracle adjustment: validator plus ownership-expiry suites 29 PASS (5.88s). Expanded defaults/unchanged-owner controls: 35 PASS (6.16s). Final explicit 26 participant suites: 619 PASS (29.32s), exit 0. Validator suite now has 14 controls, ten added. No new temporary mutant used in this slice.

These are SQL-builder/row/Promise recording tests, not executed SQL, exclusion, authenticated authority, common serialization, concurrency, commit or rollback. No DB, embedded PostgreSQL, server, listener, adapter, typecheck, build or full gates were run. Restoration remains unwired, other lifecycle participants remain unfenced by default, and queue admission/revalidation/orphan expiry/live 15-minute acceptance remain incomplete. Pending human-only offline database scope is unchanged. No merge, deployment, queue hygiene or live evidence mutation. The PR conflict requires separate rebase and fresh-head validation/review.
