# Dark approval revision participant checkpoint

This is source/mock-only work, not activation, authority or database acceptance.

The canonical requestRevision entry supports an optional lifecycleFence/companyId
contract. The owned path starts a root transaction before domain reads and
captures the company before deferred startup. The supplied-tx participant captures
company/approval/user/note scalars before awaiting the existing company fence.
It reuses private canonical revision persistence: company-scoped approval read,
pending-only veto, revision_requested update on the supplied executor. Dark update
includes company and pending predicates and rejects an empty RETURNING result.
Ordinary omitted/false callers retain the non-owning ID-only read/update shape
and null decision-note default. No production caller opts in.

A revision request retains the human gate; it is not approve/reject, agent side
effects, resubmission or dependent restoration. Caller identity capture is not
an authenticated decision-authority check. Unmigrated approval decisions/create/
cancel/resubmit/interactions and other lifecycle writers remain prerequisites.
The restoration coordinator is still unwired; queue admission/revalidation,
orphan expiry and the live 15-minute bound are not delivered.

Verification from server cwd, production keys/DB removed and profile TMPDIR set:
/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts
src/__tests__/approval-lifecycle-revision.test.ts --pool=forks --maxWorkers=1 --testTimeout=15000
Initial focused contract: 1 expected failure (no owned tx/fence), 2.54s.
First implementation + approvals-service: 7 passed, 3.06s.
Expanded approval regression before final six outcome controls: 100 passed, 7.68s.
Temporary missing-await mutant: 1 failed/24 skipped, 2.08s; removed.
Final eighteen targeted participant suites: 387 passed, 20.49s.

New recording controls cover owned/supplied fence ordering and rejection, missing
company, missing/foreign/non-pending rows, update-error/empty-RETURNING propagation,
supplied routing/user/note containment, deferred owned startup and ordinary defaults.
SQL-builder predicates are recorded, not executed. An empty RETURNING fixture is
not a demonstrated database CAS race. Promise callback completion is not a real
commit, rollback or publication oracle. There is no PostgreSQL/server/adapter run,
SQL concurrency, authenticated authority, full typecheck/build or full CI proof.
The existing human-only PostgreSQL test-scope question stays pending; it does not
block further source/mock work and does not grant merge/deploy/activation.
