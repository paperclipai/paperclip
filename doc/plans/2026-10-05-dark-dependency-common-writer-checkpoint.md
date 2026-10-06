# Dark common dependency writer checkpoint

Source/mock-only. Not production activation, SQL execution, concurrency, rollback or acceptance evidence.

## Delivered boundary

`updateIssueWithDependencyRestorationInTransaction` calls the real canonical update with the root DB identity, supplied transaction, caller-owned publication/action queues and lifecycleFence opt-in. Canonical invocation snapshot happens before the first fence await. After a same-company done result, actual readiness discovers candidates; sorted candidates pass through the existing dark restoration coordinator in that same transaction. The coordinator revalidates blockers, dependent ownership, tree assessment and human gates, then writes canonical todo plus the cycle-bound durable intent. No detached wake is dispatched. Errors propagate to the transaction owner.

This is a dark common writer entry point, not a migration of existing REST/native/finalize/backstop callers. Neither new wrapper nor old coordinator has a production emitter caller. All graph/tree/gate/owner/reblock/delete/checkout participants must acquire the same fence before their first relevant read or lock before activation. Existing intent + blocked remains unresolved; conservative policy/descriptor/lease vetoes are still scaffolding. Native ledger/statusVersion/effects and post-commit flush are not proved here.

## Executed recording

The actual canonical writer, actual readiness and actual coordinator execute over distinct root/tx recording identities. The caller transaction callback return freezes a snapshot containing final blocker done, dependent todo and exact company/agent/issue/blocker/full-set/cycle intent. Terminal summary/status-card/interaction hooks, settings and chat completion are explicit unrelated mocks. Unknown table/target access fails.

Initial missing-entry-point RED: 1 FAIL / 22 skipped, TypeError missing function, 5.23s. After implementation: canonical 23 PASS, 4.54s. Expanded suite: 147 PASS, 8 files, 13.63s. Stronger outer-callback snapshot final standalone: 30 PASS, 5.68s.

Controls preserve pending human_only confirmation with continuationPolicy=none, pending/revision_requested approval, direct tree pause and unresolved second blocker without dependent or gate writes. Insert rejection propagates and prevents a caller-return snapshot; eager recording rows remain changed, so this is explicitly not rollback. Caller patch/issue/company mutation during the first real canonical fence await cannot retarget the result. No nested transaction is started by the common writer.

Original unchanged integration diagnostics remain 27 PASS / 2 known RED, 10.61s: route dispatch still observes blocked; ordinary canonical blocker update still has no durable intent. This new dark entry point does not make those production paths GREEN.

Commands (server cwd), profile scratch, no keys/DB:

`env -u PAPERCLIP_API_KEY -u DATABASE_URL -u FORGEJO_TOKEN TMPDIR=/Users/rpridal/.hermes/profiles/paperclip-infra/cache/scratch /opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/issue-dependency-restoration-canonical.test.ts --pool=forks --maxWorkers=1 --testTimeout=15000`

Expanded files: compatibility, snapshot, workspaces, settings, ownership, validators, restoration-canonical, restoration (issue-update-lifecycle-* / issue-dependency-*). Diagnostic files: writer-boundary, wakeups-routes, human-gates (issue-dependency-*).

## Remaining gates

Independent exact-head source/mock review of this new common writer delta. No upstream APPROVED/merge/deploy permission implied. Existing human-only decision about disposable offline PostgreSQL concurrency/rollback fixtures remains pending; it does not block further permitted source/mock work. No DB/server/adapter/typecheck/full gates executed. Queue admission/revalidation/orphan expiry and approved live 15-minute acceptance still absent. Keep queue_hygiene unchanged. Reviewer Low JSON matrix barrier sensitivity follow-up is recorded but not repaired in this boundary-focused slice.
