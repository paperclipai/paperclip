---
type: Verification Evidence
title: Phase 6 thin Paperclip adapter verification
description: Targeted package, database-port, finalization, security-boundary, feature-selection, and legacy fallback evidence.
tags: [native-runner, phase-6, verification, paperclip, replay, finalization]
status: stable
generated: { by: openai/gpt-5.6, at: 2026-08-09T07:42:08Z }
---

# Scope

This record verifies the default-off Phase 6 tracer at the approved
`ControlPlanePort`/`NativeSessionBackend` boundary. No browser surface changed,
so Phase 6 has command/database evidence rather than screenshots.

The counts below are from the remediation-7 final rerun on 2026-08-09.
“Internal canary” means the selected-task database test through the public
package session contract; it does not mean that a new live Codex provider task
was dispatched.

# Package contract and mock tracer

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/conformance/control-plane-port.test.ts \
  src/backends/harness-driver-backend.test.ts \
  src/contracts/native-execution.test.ts \
  src/native-session-runtime.test.ts

pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target mock --scenario happy-path
```

Result: four files and seven tests passed. The stable trace reported native
mode, `runStatus=succeeded`, three events, contiguous source sequence 3,
`workspaceFinalizeStatus=succeeded`, zero legacy invocations, and a server-owned
`done` decision with status version 0 -> 1. Restart recovery reused the bound
provider session checkpoint, opened no second session or turn, retained the
existing accepted result event, and appended only the missing terminal fact.

# Real Paperclip adapter and public-session task

The complete acceptance gate below passed 46 tests in thirteen files against
embedded PostgreSQL with zero skipped tests. Database-backed tests start their
own database instead of skipping when a developer `DATABASE_URL` is absent.
The same package conformance suite passed unchanged against
`PaperclipControlPlanePort`.
A selected task then ran end-to-end through `executeNativeSession`, the public
backend/port contracts, durable PRP events, immutable result ingestion,
workspace finalization, assessment, CAS status decision, and audit persistence.
The issue moved from `in_progress` version 0 to `done` version 1 only after its
criterion and verification cited an approved, issue-scoped durable work
product. A model-only result remained non-terminal and received a persisted
continuation wake.

The focused corpus also proved:

- global flag off and no agent opt-in both select legacy;
- an eligible explicit profile selects native;
- remote, non-standard, or non-Codex explicit profiles fail closed;
- company/run/agent/issue/source bindings reject mismatches;
- source gaps remain visible, identical retries deduplicate, and replay is
  exclusive and byte-stable; mutated identities, sequences, results, and
  bindings fail closed in the shared mock/real port suite;
- result-less transport loss dispatches the original persisted native run from
  its closed envelope/provider checkpoint after a database lease, including
  flag-off restart and active-turn recovery without a second run, provider
  session, or turn; the scripted provider boundary returns one result and the
  real heartbeat/finalizer path persists one assessment, decision/effect set,
  and terminal projection without invoking the legacy adapter;
- resolved confirmations and question answers enter the persisted native input
  only through the authorized issue-interaction service; governed, unresolved,
  unsupported, or self-approved paths fail closed without credentials;
- accepted package-result attention enters through `finalizeNativeRun` and the
  persisted-result router: same-company delegation uses `issueService`, human
  authority creates an issue-thread interaction, and cross-company targeting
  persists a rejection decision, recovery action, failed finalization, and
  audit receipt;
- valid duplicate and stale targets, including a mixed list, enter through
  `PaperclipControlPlanePort.completeRun -> finalizeNativeRun`, commit a
  replay-stable zero-decision coordinator, project a successful run, preserve
  issue status/version, create no wake or notification, and record the exact
  durable interaction target; missing and cross-company bindings fail closed;
- incomplete/review/yield/cancelled results receive a durable review,
  continuation, or recovery path;
- only a task-wide blocker with a named owner and action selects `blocked`;
- a completion decision writes immutable assessment/decision/effect records and
  an activity-log audit row;
- a failed workspace barrier preserves the accepted semantic result, leaves the
  issue status/version unchanged, commits the fact-based preserve decision and
  concrete recovery target, and records a leased `retryable_failure`;
- six injected failures prove governance binding, interactions, wakes, blocker
  bindings, recovery, status,
  decisions, and effects roll back together before retry ownership is recorded.

The acceptance-matrix entry points passed as one 13-file, 46-test gate:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-native-runner-cancellation.test.ts \
  src/__tests__/heartbeat-native-runner-selection.test.ts \
  src/__tests__/native-run-finalizer.test.ts \
  src/__tests__/native-runner-input-boundary.test.ts \
  src/__tests__/native-runner-phase6.integration.test.ts \
  src/__tests__/native-finalization-recovery.test.ts \
  src/__tests__/native-interaction-bridge.test.ts \
  src/__tests__/native-session-resumption.test.ts \
  src/__tests__/heartbeat-run-event-sequencing.test.ts \
  src/__tests__/legacy-finalization-regression.test.ts \
  src/__tests__/native-finalization-migration.test.ts \
  src/__tests__/native-status-arbiter-corpus.test.ts \
  src/services/native-runtime/native-session-executor.test.ts
```

This gate proves concurrent event allocation, duplicate-only migration repair,
bounded retry exhaustion, actual flag-off legacy execution, and executable
Section 18.13 fixture-to-consumer traceability. All 52 fixtures and 70 rows are
classified as either live operational proofs or explicit pure policy/read-model
checks. Cancellation persists its decision or audit-only receipt through
`cancelNativeSession`; attention enters from the accepted result through
`finalizeNativeRun`, which owns the persisted-result router, then resolves a
same-company eligible target through the issue service. The mapped duplicate
and stale fixtures require that finalizer receipt and fail sabotage that leaves
only the pure resolver/internal router. REC-04/06/07/08 enter the reconciler, with REC-04
recording an observed workspace operation and REC-06/07/08 writing a newly
classified append-only assessment before superseding the prior decision; and
MIG-08 is enforced by the production heartbeat selector using the global flag:
the persisted active run remains native, a fresh unresolved run selects legacy,
and the agent profile remains unchanged.

All eleven expected fields remain derived from entrypoint returns and durable
rows. Every required native effect is joined to its owning target state, each
decision replay retains one identity and one delivery attempt, and pending
replay verifies the original company/issue/decision target before acknowledging
it. Zero-decision audit replay retains the coordinator and named interaction
without another mutation. The negative suite removes each live action, changes the real global-flag
input, and deletes a replay target;
the mapped fixtures fail while the direct policy resolver still returns the
expected label. An unknown effect rolls the entire transaction back. No
test-owned scenario policy supplies an observation. The selected-task
and recovery canaries remain scripted only at the provider boundary, while the
production Paperclip persistence/finalization paths and the flag-off legacy
adapter/finalizer path execute for real.

# Remediation 7 rerun and call-graph self-review

The final rerun on 2026-08-09 produced:

- thirteen server files, 46 tests passed, zero skipped;
- Section 18.13 checker: 19 checks passed, zero failed;
- runner documentation validation: 58 links and the 25-concept/four-index OKF
  bundle passed;
- server TypeScript and runner TypeScript/protocol typechecks passed;
- the design's authoritative 89-file allowlist matched the Phase 6 diff exactly;
- `git diff --check` passed.

The exact-file claim is mechanically fail-closed. This comparison extracts the
authoritative fenced block, asserts its count, and then compares it with the
committed Phase 6 diff. Any missing or extra path makes `diff` return non-zero:

```sh
PHASE6_SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:-$(mktemp -d)}"
PHASE6_ALLOWLIST="$PHASE6_SCRATCH/phase6-allowlist.txt"
PHASE6_ACTUAL="$PHASE6_SCRATCH/phase6-actual.txt"

awk '
  /^### Remediation 7 authoritative exact-file reconciliation / { section = 1; next }
  section && /^```text$/ { block = 1; next }
  block && /^```$/ { exit }
  block { print }
' packages/paperclip-runner/docs/design/phase-6-thin-paperclip-adapter.md \
  | LC_ALL=C sort > "$PHASE6_ALLOWLIST"
git diff --name-only 3a38c8f931..HEAD \
  | LC_ALL=C sort > "$PHASE6_ACTUAL"
test "$(wc -l < "$PHASE6_ALLOWLIST")" -eq 89
test "$(wc -l < "$PHASE6_ACTUAL")" -eq 89
diff -u "$PHASE6_ALLOWLIST" "$PHASE6_ACTUAL"
```

Result: exit 0 with no diff output; 89 documented paths, 89 committed paths,
zero missing, and zero extra.

The final owner review traced the successful audit-only path as
`PaperclipControlPlanePort.completeRun -> native_run_results ->
finalizeNativeRun -> routePersistedNativeResultAttention ->
recordNativeAttentionAssessment -> routeNativeAttention ->
applyNativeAttentionStatusDecision -> native_run_finalizations/heartbeat_runs`.
The public port owns immutable result validation and persistence; the finalizer
owns coordinator lease/terminal projection; the internal router derives all
identity from persisted bindings; and the audit materializer requires the exact
same-company issue interaction. The finalizer accepts a null decision only when
every receipt is `attention_duplicate_suppressed` and names a durable target.
Committed replay validates those receipts before short-circuiting, so it cannot
create another assessment or mutate the interaction timestamp. Missing or
cross-company targets throw before the coordinator commits and enter named
retryable recovery with the issue status/version unchanged.

# Remediation 8 documentation self-review

The final documentation review confirmed that the exact allowlist is the same
89-path set as `git diff --name-only 3a38c8f931..HEAD`, the status header records
the remediation-8/final-gate state, this evidence identifies the remediation-7
final rerun, and the tutorial expects four package files and seven tests. The
reconciliation changes documentation only and does not alter runtime behavior.

# Compile and migration checks

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/db typecheck
```

Result: all checks passed. Migration numbering and safety passed. Migration
0211 preserves existing unique heartbeat cursors, deterministically moves only
duplicate rows above each run's former maximum, backfills the next allocator
value, and installs issue status-version tracking.

Focused migration, allocator, recovery, and legacy rehearsal:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/services/native-runtime/paperclip-control-plane-port.test.ts \
  src/__tests__/native-finalization-recovery.test.ts \
  src/__tests__/legacy-finalization-regression.test.ts \
  src/__tests__/native-finalization-migration.test.ts \
  src/__tests__/heartbeat-run-event-sequencing.test.ts
```

Result: five files and 11 tests passed with zero skips. The 0211 rehearsal
reconstructed a production-shaped pre-0211 schema, removed the 0211 journal
entry, seeded legacy event sequences `[1,5,5,9]`, and applied the complete
migration. It retained the
original unique cursors and first `5`, moved only the later duplicate to `10`,
seeded `next_event_seq=11`, preserved every non-sequence field byte-for-byte,
and enforced uniqueness. Thirty-two concurrent mixed event writers produced a
gap-free allocator stream. Invalid native finalization exhausted its
three-attempt budget into named recovery without touching issue status. An
actual flag-off heartbeat executed the legacy adapter/finalizer, remained
byte-equivalent across native reconciliation, and created zero native rows.

# Credential, governance, budget, and legacy boundaries

`native-execution.test.ts` rejects unknown top-level or nested launch fields and
proves the model envelope omits company/run/agent bindings and credential
references. The native branch never creates a local agent JWT, MCP gateway, raw
adapter environment, or legacy context. Runtime requests cannot auto-approve;
the native interaction bridge materializes supported typed responses through
the authorized service and rejects unsupported/governed/self-approved paths.

Explicit cancellation, agent pause, and budget hard-stop share
`cancelRunInternal`, which now invokes the run-scoped normalized native session
before existing process/resource cleanup. The default and kill-switch paths
execute the pre-existing adapter branch; no same-run native-to-legacy fallback
exists. Recovery queries persisted native mode/coordinator state rather than
the current flag. The kill switch does not mutate `agents.runtime_config` or
persist a per-agent disable bit.

No attention UI or public attention endpoint is claimed. The Codex v1 result
tool authors compact `kind`/`summary` requests; richer canonical PRP target
metadata is server-validated but does not yet have provider authoring UX.
External-system execution, credential delegation, and auto-approval remain
deferred.

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/services/native-runtime/native-session-executor.test.ts

pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-stale-queue-invalidation.test.ts \
  -t "daily cost cap"
```

Result: native cancellation reached the active normalized session exactly once
across duplicate cancellation requests and removed the handle afterward. The
daily cost hard stop cancelled a queued run before any adapter execution.

# Deferred live-provider checkpoint

The [Phase 6 tutorial](../../docs/tutorials/phase-06-thin-paperclip-adapter.md)
contains the exact board-authorized commands for enabling one local agent,
running and inspecting a live Codex task, disabling the flag, proving a fresh
legacy selection, and restoring the agent profile. Those commands intentionally
do not pass credentials to the package or model. They were not run during this
remediation because changing live instance and agent rollout state requires
operator approval; no new live-provider evidence is claimed here.
