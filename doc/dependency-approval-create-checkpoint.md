# Dark pending approval creation participant checkpoint

This SOURCE/MOCK checkpoint extends the company lifecycle protocol to canonical
approval creation, not production callers or authenticated request authority.

The dark owned `approvalService.create(companyId, data, { lifecycleFence: true })`
captures the request before starting its transaction. The supplied
`createApprovalInTransaction` captures company/request scalars and the actual
schema-driver JSON snapshot before awaiting the company fence. Shared canonical
INSERT persistence executes only after that fence and uses the captured company.
An absent insertion result rejects rather than reporting a created approval.

The dark input deliberately permits only type, payload, requester IDs and optional
pending status. Other own keys (including IDs, company, decision or timestamps),
non-pending status, nullish payload, encoded JSON null or absent output reject
before effects. Effective requester values are explicitly projected. This is a
narrow contract, not arbitrary create-input compatibility. Requester IDs and type
are not authenticated authority or policy validation. Ordinary omitted/false
callers retain spread values, company override, payload identity, non-owning
execution, undefined empty result and synchronous builder errors.

## Recording evidence

From server cwd, unset PAPERCLIP_API_KEY, DATABASE_URL, FORGEJO_TOKEN and set
TMPDIR to the infra profile scratch. Run /opt/homebrew/bin/node
../node_modules/vitest/vitest.mjs run --config vitest.config.ts <explicit files>
--pool=forks --maxWorkers=1 --testTimeout=15000.

New approval-lifecycle-create.test.ts: first root-write-before-transaction RED,
then 7 PASS including existing service tests. Added capture/extra/payload cases:
20 expected FAIL / 1 PASS, then 27 PASS including service. Empty insertion result:
2 expected FAIL / 35 skipped, fixed with dark-only rejection. Final suite has
43 controls. Approval creation/resubmit/cancel/revision/service/route-idempotency:
151 PASS / 9.47s. Missing-await temporary mutant: both owned and supplied order
assertions FAIL, 41 skipped / 2.10s. Mutant removed before final verification.

Final 21 explicit participant suites: 496 PASS / 24.68s. Original writer boundary,
route recovery and human-gate characterization: 27 PASS / 2 known RED / 13.33s.
Ordinary route still leaves dependent blocked; ordinary writer lacks durable
intent. No typecheck, build or full gates executed. No command timed out.

## Remaining boundaries

This fixture records actual service and JSON driver behavior with synthetic
INSERT rows and SQL-builder fence parameters. It does not execute SQL, foreign
keys, filtering, database concurrency, rollback, request authorization or common
serialization. Rejection propagation and Promise return order are not DB commit.
No production caller opts in. Approve/reject effects, interactions and other
lifecycle writers, native ledger/statusVersion/publication/legacy intent handling
and restoration wiring remain. Queue admission/revalidation/orphan expiry and
live 15-minute acceptance remain unimplemented. Human-only DB test scope is
still pending; no merge, deployment, runtime activation or queue_hygiene change.
