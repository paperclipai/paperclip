# Dark supplied question-answer checkpoint

No production caller, database, listener, adapter, rollout or approval change.
The answerQuestionsInTransaction participant captures issue/input/consumed actor
and effective inherited resolver restriction before suspension, awaits the company
fence, re-reads and locks authoritative issue then scoped card, and reuses actual
canonical answer normalization, pending CAS and question-response delivery INSERT
on the supplied transaction. Root caller owns commit/discard, delivery dispatch,
touch and telemetry; arbitrary mutation hooks are refused. Ordinary answer callers
retain owned transaction and postcommit touch/telemetry. No owned opt-in is added.

Initial missing-entry test: 1 expected failure, 4.42s. First implementation: 1 PASS
4.24s after fixing a fixture answer that incorrectly used value instead of
optionIds/otherText. Expanded fixture first expected invalid-agent 403 incorrectly;
actual canonical admission is 422. Inherited restriction fixture initially used
nonexistent agent_only policy; corrected to actual issue_review not_creator with
excluded user, and persisted effectiveResolverPolicy fields.

Command (server cwd): env -u PAPERCLIP_API_KEY -u DATABASE_URL -u FORGEJO_TOKEN
TMPDIR=/Users/rpridal/.hermes/profiles/paperclip-infra/cache/scratch
/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts
src/__tests__/interaction-lifecycle-answer.test.ts
src/__tests__/interaction-lifecycle-withdraw.test.ts
src/__tests__/interaction-lifecycle-withdraw-owned.test.ts
src/__tests__/interaction-lifecycle-withdraw-native.test.ts
--pool=forks --maxWorkers=1 --testTimeout=15000
Final: 4 files, 70 PASS, exit 0, 7.92s. New answer suite: 10 controls.
No new mutant or full participant replay. No typecheck/build/full gates.
Existing question-response-delivery and chat-interaction-publications suites use
embedded PostgreSQL; deliberately NOT run under the current mock-only scope.

Recording executes actual service/normalizer/parser/audience evaluator and SQL
predicate builder; chat publication/settings/telemetry mocked. Delivery failure
leaves eager recorded answered card: NOT rollback. No SQL filtering/isolation,
concurrency/commit/rollback or authority proof. Actual authenticated agent-run
writer, ordinary question path parity, unknown/foreign/absent card, lost CAS,
chat-provider settlement, effective-field clone compatibility and lock-order with
other participants require exact-head review/next verification before wiring.
Restoration remains unwired; queue admission/orphan/live 15min acceptance missing.
Pending human-only DB question remains unchanged. Separate rebase and fresh-head
validation needed for the existing upstream conflict.

## Effective resolver restriction follow-up

Dark supplied answer now captures effective policy/source and nested excludedActor
 type/id before suspension, preserving inherited/non-enumerable/getter-backed
narrowing fields. String restrictions and explicit null/undefined remain intact.
Ordinary non-opt-in branch unchanged. No production opt-in or authority claim.

Actual canonical/evaluator recording covers inherited policy/nested identity veto,
different-user positives, getter-backed identity mutation across fence, null
excluded identity, string not_creator and null/undefined/anyone/human_only positives.
Initial inherited-field focused run failed. Intermediate string projection regression
caught as one expected FAIL / twelve skipped (5.13s), then fixed.
Final explicit four-file replay: 81 PASS / 8.60s / exit 0, same env/node/config/pool
as above. A nonexistent fifth resolution filename was not selected or counted.
Writer-boundary + human-gates: 19 PASS / one original missing-intent RED / 6.25s /
exit 1. No DB/server/listener, typecheck/build/full gates or full participant replay.
Synthetic rows and predicates are not SQL filtering/isolation/authority/rollback.
