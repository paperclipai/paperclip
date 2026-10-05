# Dark relation pre-write validation checkpoint

The opt-in canonical lifecycle update now validates `blockedByIssueIds` on its fenced preparation executor before entering `runUpdate`. Validation is extracted from the existing sync helper, preserving self-edge, company-membership, sorted row-lock and cycle checks. Sync still repeats that same validation before DELETE/INSERT on its transaction. There is deliberately no validation-bypass flag. Non-opt-in calls retain the previous late-validation path, including create's default root contract.

This is SOURCE/MOCK work only. The company advisory fence precedes preparation reads; a nonempty replacement takes the existing sorted issue locks before canonical row writes. Empty replacement still enters the fence and writes only the scoped relation DELETE. Actual SQL-builder params and row projections are recorded, not executed. Repeated validation does not close races with writers that do not participate in the lifecycle fence. The shared restoration wrapper remains dark/unwired.

## Executed evidence

Server cwd, environment without PAPERCLIP_API_KEY, DATABASE_URL and FORGEJO_TOKEN; TMPDIR points to the infra profile scratch. Runner: `/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts`, options `--pool=forks --maxWorkers=1 --testTimeout=15000`.

New `src/__tests__/issue-update-lifecycle-relations.test.ts`: initial six expected REDs, each accepted 422 but observed a canonical issue write before veto (4.95s, exit 1). After extraction/preflight, six PASS (4.53s). Final controls cover owned/supplied self/company/cycle veto, full/empty replacement, array/company mutation during suspended fence, exact DELETE/INSERT targets, sorted lock params and non-opt-in late-validation characterization. New suite contains 13 tests.

Nine-file regression (relations, compatibility, snapshot, workspaces, settings, ownership, validators, restoration-canonical and restoration): 160 PASS, 15.61s, exit 0. Separate ordinary writer-boundary/wakeups-routes/human-gates: 27 PASS / 2 unchanged diagnostic RED, 10.99s, exit 1. Route still dispatches while dependent is blocked; ordinary writer still returns without durable intent.

## Limits and next integration

No PostgreSQL/SQL execution, concurrency, rollback, authorization, server or adapter test. Settings/chat are explicit unrelated mocks; relation graph is synthetic. No typecheck/build/full gates, production wiring, merge, deployment or activation. A recording no-write veto is not rollback evidence. A sorted local lock list is not common graph serialization. No live cards, queue_hygiene, jobs, policy or permissions changed.

Still required: relation-removal restoration semantics (including last-edge clear), owner/reblock/tree/gate/delete/checkout/native/finalize participants, native statusVersion/effect ledger, real post-commit flush and legacy intents, queue admission/revalidation/orphan expiry and separately approved live 15-minute verification. Low caller-queue identity and JSON matrix barrier follow-ups from earlier reviews remain open. Pending human-only question about disposable offline PostgreSQL testing remains a separate scope gate; it does not block source/mock implementation and grants no merge/deploy permission.
