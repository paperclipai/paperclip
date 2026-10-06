# Dark bulk approval-link participant checkpoint

Scope: source plus mock-only recording. No production route opts in; no database,
server, adapter, live queue, approval decision, merge, rollout or activation.

The canonical linkManyForApproval entry now accepts a dark lifecycleFence/companyId
option. It captures the effective company, copies the issue-ID array and actor
scalars before owned transaction startup. The supplied-tx entry captures the same
inputs, awaits the company lifecycle fence before any domain read, then uses the
same private canonical persistence as ordinary callers. Approval and issue reads
are company-scoped in the dark path; endpoint completeness/company validation
precedes a deduplicated batch INSERT with onConflictDoNothing. Pending approvals
are not decided and dependent issue statuses are not restored by this participant.

Ordinary omitted/false callers retain non-owning reads and their original unscoped
ID predicates, same-company checks, duplicate elimination, actor defaults and
empty-array no-effect behavior. Valid empty dark batches acquire the fence but
perform no domain reads/writes; missing company rejects even for empty batches.

Verification from server/ with PAPERCLIP_API_KEY, DATABASE_URL and FORGEJO_TOKEN
removed and TMPDIR set to the infra profile scratch:
/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts
src/__tests__/issue-approval-lifecycle-bulk.test.ts --pool=forks --maxWorkers=1
--testTimeout=15000

Initial owned ordering RED: 1 expected FAIL (no tx/fence), 864ms, exit 1. First
implementation combined with link/unlink/approvals-service/approval-routes-idempotency:
57 PASS, 6.91s. Expanded bulk has 25 recording controls; five approval suites:
81 PASS, 6.68s. Temporary missing-await mutant: 1 FAIL/24 skipped, 1.11s; removed.
Pristine 17 targeted participant suites: 362 PASS, 20.97s, exit 0.
Original writer-boundary/wakeups-routes/human-gates suites: 27 PASS/2 known RED,
10.62s, exit 1. Ordinary route still dispatches while dependent blocked; ordinary
blocker writer still lacks a durable restoration intent.

Limits: synthetic rows and SQL-builder expressions do not execute SQL predicates,
isolation, conflicts, locks or rollback. Insert rejection propagation is not a
rollback proof. Actor containment is not authenticated authority. Common protocol
participation, approval decisions/interactions and the remaining lifecycle writers,
ledger/statusVersion/effects/flush/legacy intents, production restoration wiring,
queue admission/revalidation/orphan expiry and approved live 15-minute measurement
remain prerequisites. Restoration remains unwired. Typecheck/build/full gates not
run; no final acceptance or safety/atomicity approval claimed. Existing pending
human-only test-scope question is unchanged and is not a merge/deploy grant.
