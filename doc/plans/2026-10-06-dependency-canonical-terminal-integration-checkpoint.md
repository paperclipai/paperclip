# Dark canonical terminal expiry integration checkpoint

SOURCE/MOCK only. The canonical lifecycleFence update now calls the supplied terminal-expiry participant on its current transaction, forwarding its existing activity queue. Preparation acquires the same-company lifecycle fence before any domain read/row lock; the terminal hook re-enters only under that precondition. No owned service(tx) wrapper is called in this branch. Ordinary omitted/false callers retain the previous per-row owning hook.

The canonical issue.thread_interaction_expired activity is also queued only in the dark branch. Canonical root ownership already controls commit/flush; supplied callers must discard transaction-local queues on transaction or commit rejection. No production caller is switched on. This is not common graph serialization, restoration wiring or authorization.

## Execution

Cwd server; env -u PAPERCLIP_API_KEY -u DATABASE_URL -u FORGEJO_TOKEN TMPDIR=<profile scratch> /opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts <explicit files> --pool=forks --maxWorkers=1 --testTimeout=15000.

New actual canonical/terminal/activity-logger recorder: initial 2 expected FAIL, nested-transaction (4.52s). Supplied entry fix exposed 2 further no-live FAIL on the canonical audit event (4.13s). Deferring that event closes those assertions. Unrelated ownership/restoration mocks needed an explicit empty supplied export; the intermediate missing-export failures were fixture errors, not product RED.

Five focused files: 95 PASS/9.74s. Final 29 explicit participant files: 660 PASS/36.20s. New suite has eight controls, including outer commit rejection, second-fence suspension/rejection, activity storage error, supplied queue flush and ordinary omitted/false behavior. Actual service, supplied expiry and activity logger execute; settings, summary/status hooks, chat enqueue, telemetry and live sink are mocked.

## Supplied missing-queue follow-up

Independent review found that a supplied terminal update without a caller queue silently accumulated activity in an inaccessible private fallback. The dark canonical entry now rejects requested done/cancelled updates with HTTP 422 before fence/read/write when the supplied caller did not pass an ActivityPublication array. Owned callers still allocate and flush their private queue; supplied callers with an explicit empty array retain and flush it after their own successful commit. Ordinary omitted/false behavior and nonterminal dark preparation are unchanged. This is a deliberately terminal-only preflight, not a general validation of every possible supplied update's effects.

Clean focused RED: done/cancelled without queue resolved instead of rejecting (2 FAIL/8 skipped, 4.40s). After fix five focused suites: 97 PASS/10.20s. Added no-pending-card veto, truly omitted/false ordinary no-queue defaults and nonterminal control. Final same 29 explicit participant suites: 666 PASS/31.25s. Writer-boundary/human-gates: 19 PASS/1 original known RED/5.97s; ordinary blocker update still writes no durable intent. All runs use the command/environment above. No route/listener replay, database, SQL execution, adapter, typecheck/build/full gates or activation. These controls execute real canonical writer/expiry/logger with synthetic eager rows, not SQL commit/rollback. The ownership suite distinguishes the new early dark denial from the existing ordinary human-completion guard.

## Limits

Rows and predicates are synthetic. Eager recorded status/card writes survive rejection: not SQL rollback evidence. Outer-resolve is a Promise, not a real commit. No SQL filtering/isolation/concurrency/authorization or native ledger/effect proof. New fixture uses a confirmation without linked secret/OAuth; separate linked-secret tests are not end-to-end canonical cleanup proof. No route/listener, DB/embedded PG/server/adapter, typecheck/build/full gates or deployment. Existing human DB-scope question remains pending. Restoration is unwired; queue admission, orphan expiry and live 15-minute acceptance remain missing. PR conflict needs separate rebase and fresh-head tests/review.
