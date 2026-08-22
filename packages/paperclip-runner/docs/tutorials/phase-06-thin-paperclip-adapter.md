# Phase 6: Run the Thin Paperclip Adapter

Phase 6 connects one local, issue-bound `codex_local` task to the runner's
public `ControlPlanePort`/`NativeSessionBackend` contract. Selection is
default-off, explicit per agent, and persisted before provider execution. The
runner never receives a Paperclip API key, local JWT, managed MCP token, raw
environment, wake payload, or skill instructions.

## Prerequisites

- a local Paperclip instance built from this branch;
- a board/operator API key in `PAPERCLIP_API_KEY` (never print it);
- `PAPERCLIP_API_URL`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_TASK_ID`;
- an active `codex_local` agent, a standard issue assigned to it, and a
  realized local execution workspace;
- Codex already authenticated on the host.

Normalize the API base once:

```sh
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
PHASE6_SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:-$(mktemp -d)}"
```

## 1. Prove the mock package contract

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/conformance/control-plane-port.test.ts \
  src/backends/harness-driver-backend.test.ts \
  src/contracts/native-execution.test.ts \
  src/native-session-runtime.test.ts

pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target mock --scenario happy-path
```

Expected: four targeted files and seven tests pass, and the trace reports
`resolvedMode` as `native`, three replay-stable events, a successful workspace
barrier, and one mock server-owned `done` decision. This tracer does not connect
to Paperclip.

## 2. Prove the database-backed Paperclip port

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/native-runner-phase6.integration.test.ts \
  src/__tests__/heartbeat-native-runner-selection.test.ts \
  src/__tests__/heartbeat-native-runner-cancellation.test.ts \
  src/__tests__/heartbeat-run-event-sequencing.test.ts \
  src/__tests__/native-runner-input-boundary.test.ts \
  src/__tests__/native-run-finalizer.test.ts \
  src/__tests__/native-status-arbiter-corpus.test.ts \
  src/__tests__/native-interaction-bridge.test.ts \
  src/__tests__/native-session-resumption.test.ts \
  src/__tests__/native-finalization-recovery.test.ts \
  src/__tests__/native-finalization-migration.test.ts \
  src/__tests__/legacy-finalization-regression.test.ts \
  src/services/native-runtime/native-session-executor.test.ts
```

This runs the unchanged package conformance suite against the real Paperclip
port. Forty-six targeted tests check company binding, duplicate/gap replay,
checkpoint recovery, immutable result ingestion, durable-evidence authority,
workspace-gated finalization, atomic liveness rollback, status-version CAS,
migration repair, legacy byte equivalence, typed interaction materialization,
same-run pre-result resumption, lease races, and audit output. All database tests
start embedded PostgreSQL and do not skip when a developer database URL is
absent.

The corpus cases dispatch fixture-specific database shapes through live
cancellation, persisted-result attention, reconciliation, and heartbeat
selection entrypoints whenever an operational effect is claimed. Workspace
recovery records the actual operation result. Accepted attention is read back
from `native_run_results`, records a request-specific assessment, delegates an
eligible same-company agent through the issue service, routes human authority
through an issue-thread interaction, and rejects a cross-company target with a
durable decision/recovery/audit trail. The kill-switch case uses the global
instance flag: an active persisted native run remains native while a fresh run
for the same unchanged agent profile selects legacy. Pure resolver and
read-model calls remain useful policy tests but cannot satisfy these rows.
Each native effect must have a delivered, company-bound target or concrete
target-state mutation, and pending replay may only acknowledge its original
decision-scoped target. Sabotage tests remove each live action and the replay
target and require failure even while the pure resolver label remains correct.

Duplicate and stale audit-only cases start at
`PaperclipControlPlanePort.completeRun`, continue through `finalizeNativeRun`,
and commit the coordinator with no status decision. The run succeeds, the issue
status/version remains unchanged, and the receipt names the exact mutated
interaction. Replaying the finalizer does not create an assessment or update
the interaction again. A mixed duplicate/stale list has the same behavior;
missing and cross-company interaction bindings fail closed.

All eleven expected fields and all 70 matrix-row joins are still checked, and
an unknown-effect case proves the status transaction fails closed without
partial rows. The recovery case uses a scripted provider only at the backend
boundary while the real heartbeat reaper, lease claim, original run execution,
persistence port, finalizer, and terminal projection execute.

The command above is the repeatable scripted internal canary and actual
flag-off legacy-heartbeat proof. It is not a live-provider canary. The remaining
sections are an optional live-provider rollout procedure;
they were not run during remediation and require explicit operator authority to
change an instance flag and agent profile.

## 3. Enable one isolated agent

Save the agent's current runtime profile, merge the native profile, then enable
the instance flag. These endpoints require board/operator authority.

```sh
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/$PAPERCLIP_AGENT_ID" \
  | jq '.runtimeConfig' > "$PHASE6_SCRATCH/phase6-runtime-before.json"

jq -n \
  --slurpfile current "$PHASE6_SCRATCH/phase6-runtime-before.json" \
  '{runtimeConfig: ($current[0] * {nativeRunner: {mode: "native", backend: "codex_app_server", protocolVersion: 1}})}' \
  | curl -fsS -X PATCH \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "$PAPERCLIP_API_BASE/api/agents/$PAPERCLIP_AGENT_ID" >/dev/null

curl -fsS -X PATCH \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enableNativeRunner":true}' \
  "$PAPERCLIP_API_BASE/api/instance/settings/experimental" >/dev/null
```

## 4. Run one local native Paperclip task

```sh
PAPERCLIP_NATIVE_RUN_ID="$({
  curl -fsS -X POST \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"source\":\"on_demand\",\"triggerDetail\":\"manual\",\"payload\":{\"issueId\":\"$PAPERCLIP_TASK_ID\"},\"forceFreshSession\":true}" \
    "$PAPERCLIP_API_BASE/api/agents/$PAPERCLIP_AGENT_ID/wakeup"
} | jq -r '.id')"

while :; do
  PAPERCLIP_NATIVE_STATUS="$({
    curl -fsS \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_NATIVE_RUN_ID"
  } | jq -r '.status')"
  case "$PAPERCLIP_NATIVE_STATUS" in
    succeeded|failed|cancelled|timed_out) break ;;
  esac
  sleep 2
done
test "$PAPERCLIP_NATIVE_STATUS" = succeeded
```

The expected run has `runtimeMode=native`, a persisted completion contract and
runner instance, no legacy adapter invocation, and a typed terminal fact.

## 5. Inspect replay and finalization

```sh
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_NATIVE_RUN_ID/events?afterSeq=0&limit=200" \
  | jq '[.[] | select(.payload.prpEvent != null)] | {count: length, events: map({seq, sourceSeq, sourceEventId, eventType})}'

curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_NATIVE_RUN_ID" \
  | jq '{runtimeMode, nativePhase, runnerInstanceId, completionContractId, resultJson}'

curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID" \
  | jq '{status, statusVersion, lastStatusDecisionId, unblockDescriptor}'
```

Repeat the events request with `afterSeq=<seq>`. Replay is exclusive and stable;
native result/finalization rows remain authoritative even if the flag changes.

## 6. Exercise cancellation and budget hard-stop

Start a deliberately long native task, then use the existing cancellation API:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_NATIVE_RUN_ID/cancel" >/dev/null
```

The same run-scoped native cancel handle is invoked by explicit cancellation,
agent pause, and budget-pause enforcement. Resource, environment, scratch, and
workspace cleanup remain owned by the existing heartbeat path.

## 7. Disable the flag and prove legacy fallback

Set `PAPERCLIP_LEGACY_TASK_ID` to a fresh eligible issue assigned to the same
agent; the native proof issue may already be terminal.

```sh
curl -fsS -X PATCH \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enableNativeRunner":false}' \
  "$PAPERCLIP_API_BASE/api/instance/settings/experimental" >/dev/null

PAPERCLIP_LEGACY_RUN_ID="$({
  curl -fsS -X POST \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"source\":\"on_demand\",\"triggerDetail\":\"manual\",\"payload\":{\"issueId\":\"$PAPERCLIP_LEGACY_TASK_ID\"},\"forceFreshSession\":true}" \
    "$PAPERCLIP_API_BASE/api/agents/$PAPERCLIP_AGENT_ID/wakeup"
} | jq -r '.id')"

curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_LEGACY_RUN_ID" \
  | jq '{runtimeMode, runtimeModeReason}'
```

Expected: the new run reports `legacy` and `instance_flag_disabled`; an already
selected native run still reconciles from its persisted native coordinator and
never falls through to the legacy adapter. The agent's `nativeRunner` profile
must still say `mode=native`; flag-off must not persist a second per-agent
disable bit.

Restore the saved profile after the proof:

```sh
jq -n \
  --slurpfile saved "$PHASE6_SCRATCH/phase6-runtime-before.json" \
  '{runtimeConfig: $saved[0]}' \
  | curl -fsS -X PATCH \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "$PAPERCLIP_API_BASE/api/agents/$PAPERCLIP_AGENT_ID" >/dev/null
```

## Stop conditions

Stop if a native failure invokes legacy, credentials appear in model input or
stored PRP bytes, a workspace-finalization failure reports success, replay
changes bytes, a model-reported disposition bypasses the server arbiter, or
flag-off rewrites the agent profile.

This procedure does not exercise an attention UI or public attention endpoint;
neither exists in Phase 6. The Codex v1 result tool authors compact
`kind`/`summary` attention requests. Rich target metadata is a canonical PRP
input accepted and company-validated by the server, but provider authoring UX,
external-system action execution, credential delegation, and auto-approval are
deferred.
