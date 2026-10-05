# Dark canonical snapshot compatibility checkpoint

This is source/recording work only, not production wiring or atomicity approval.

The opt-in invocation boundary now captures effective lifecycleFence and bindRuntimeSharedWorkspace values explicitly. Object spread previously lost inherited/non-enumerable options, allowing relation-clear to run without its fence. Options with getters are read once in the opt-in branch; root executor and caller queues retain identity.

JSON columns are selected from the actual issues schema (dataType=json), then round-tripped through their actual driver encoder/decoder before the remaining patch is structured-cloned. This preserves persistence-compatible toJSON inputs while materializing their output before transaction startup/fence suspension. Dates remain Date snapshots; null/undefined are not encoded. Non-opt-in data alias behavior remains unchanged. Invalid cyclic JSON rejects before transaction startup/domain writes.

The permanent compatibility recorder is adapted from independent review's attached adversarial probe. It executes the real canonical writer and JSON encoder; query results and transaction callbacks are synthetic. It does not execute SQL, prove rollback/company isolation/authorization, or cover all relation replacements and participant races. JSON normalization is observable to internal service callers: nested Date/undefined/custom values follow JSON persistence semantics before domain preparation. This requires independent review before expanding participants.

Verification from server cwd, with PAPERCLIP_API_KEY, DATABASE_URL and FORGEJO_TOKEN removed, TMPDIR explicitly set to the infra profile scratch:

    /opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/issue-update-lifecycle-compatibility.test.ts --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose

Initial import: ENOSPC, no tests. No host cleanup performed. Subsequent df reported 631Mi available; retry reached 5 expected failures / 4 passes (5.04s): lost inherited fence, root-read, DataCloneError, relation-clear without fence. After source fix, compatibility plus snapshot: 15 PASS (5.77s). Expanded compatibility controls plus snapshot/workspaces/settings/ownership/validators/restoration-canonical/restoration: 105 PASS (14.72s).

Route/writer/human-gate characterization: 27 PASS / 2 original known RED (12.98s), exit 1. Route still observes blocked; blocker writer still commits without a durable wake intent. No typecheck/full gates or DB/server/adapter run. No timeout in this checkpoint.

## JSON boundary follow-up (independent M1/M2)

The dark opt-in now rejects a non-null input whose driver output decodes to JSON null with 422 BEFORE transaction startup/fence/reads/writes/relation deletion. This is an explicit restricted-input contract, NOT preservation of exotic toJSON-null compatibility: decoding it to JS null would silently re-encode it as SQL NULL. Actual offline PgUpdateBuilder demonstrates params=["null"] for toJSON-null versus params=[null] for an explicit null. Explicit null remains supported as SQL NULL; explicit undefined keeps column-omission behavior. Ordinary non-opt-in callers are unchanged.

Absent/non-string encoder output is also rejected with 422 before any effects; a toJSON returning undefined is NOT an omitted caller field. The real encoder is invoked once; successful JSON text is decoded and detached before suspension. A parameterized recorder covers all six schema JSON columns, owned/supplied, null/undefined encoder results, plus throwing encoders, explicit null/undefined, and non-opt-in alias controls. SQL is compiled only, never executed. No server or DB is started.

M1 focused RED: 2 expected failures (resolved instead of rejected), 4.73s. An intermediate implementation mistakenly referenced an unimported badRequest helper; 2 failures were implementation error, NOT product RED. Fixed to existing unprocessable; focused 2 PASS (4.22s). M2 focused RED: 2 expected failures (resolved), 4.19s. After both source fixes initial expanded 109 PASS (13.47s); final expanded 8 files 139 PASS (14.48s), compatibility standalone 49 PASS (4.97s). Same command/env/cwd/pool as above. Final route/writer/human-gates: 27 PASS / 2 original known RED (10.97s), exit 1.

The materialization barrier test races fence entry against update settlement and releases in finally. A temporary throwing-encoder fixture mutation produced 2 immediate failures (barrier-early-rejection; 14ms tests, 4.54s total), no unhandled rejection or timeout; the mutation was removed before final expanded validation.

No timeout in this run. No typecheck/full gates, SQL execution, company isolation/authorization, rollback or concurrency proof. Coordinator remains UNWIRED; this follow-up is not approval to migrate participants, wire restoration, merge, deploy, or activate. Independent exact-head review is still required. Pending human-only DB scope and live queue/queue_hygiene/runtime/policy are unchanged.

Coordinator remains UNWIRED. Shared relation/tree/gate/native/finalize participants, ledger/statusVersion/effects/legacy intents, restoration integration and queue admission/revalidation/orphan expiry/live 15-minute evidence remain unfinished. Pending human-only DB scope and separate merge/deploy/activation gates are unchanged.
