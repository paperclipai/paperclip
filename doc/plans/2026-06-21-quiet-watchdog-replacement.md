# Quiet watchdog replacement for CPS/local-worker/market-data routines

Date: 2026-06-21
Issue: MIC-143
Owner: CPS Compute Orchestrator
Status: design only / do not re-enable old routines yet

## Executive decision

Replace the paused disposable watchdog routines with an incident-first pattern:

1. each recurring check computes a stable `incidentKey` for the routine plus failure fingerprint;
2. if the check is healthy, it stays silent except for optional run telemetry;
3. if the check is degraded, it appends a compact update to one durable incident issue for that key;
4. if no incident exists, it creates exactly one incident issue and stores the incident mapping;
5. it never creates a new issue while a matching non-terminal incident exists;
6. it marks the incident ready to close only after a sustained green window, not after one transient pass.

The old noisy routines must stay paused until this behavior is tested in dry-run against the current three incident families:

- MIC-135 — Operational incident: Market data feed liveness check
- MIC-136 — Operational incident: Local worker liveness check
- MIC-137 — Operational incident: CPS active job and worker check

## Problem observed

Paperclip issue inventory shows repeated liveness issues before the pause:

| Routine family | Historical disposable issues | Current durable incident |
|---|---:|---|
| Local worker liveness check | 37 | MIC-136 |
| Market data feed liveness check | 37 | MIC-135 |
| CPS active job and worker check | 29 | MIC-137 |

The current routine rows are already paused and their triggers disabled:

| Routine | Routine ID | Trigger cadence | Current status |
|---|---|---|---|
| CPS active job and worker check | `37ca870a-7022-4a58-831a-b930f6a457bf` | `17,47 * * * *` | paused; trigger disabled |
| Local worker liveness check | `4ed352b4-cf8b-4bfe-9889-23aadf6e1896` | `7,37 * * * *` | paused; trigger disabled |
| Market data feed liveness check | `b8bffc19-e6eb-4b52-ae3b-b8deb6ead831` | `12,42 * * * *` | paused; trigger disabled |

Representative current incident states:

- MIC-135 remains degraded: Hyperliquid/Binance/Coinbase fresh, but IC Markets on-disk data stale and IBKR recorder absent/stale.
- MIC-136 remains partly degraded: local agents/listeners are healthy, but `finance-1` remains offline/unreachable.
- MIC-137 remains degraded: CPS job registry has 48 stale/suspect running rows, worker registry is empty, and CPS API listener is present but HTTP health endpoints time out.

## Non-goals / safety boundaries

This design does not authorize:

- re-enabling old routines as-is;
- creating new cron/routine schedules in this issue;
- CPS worker `reap`, `prune`, `drop`, registry cleanup, job cancellation, job requeue, or service restart;
- Vast/GPU/cloud paid compute;
- broker APIs, paper/demo orders, live orders, trading, secret changes, or model promotion.

## Incident key contract

A routine must derive a stable incident key before it writes anything:

```text
incidentKey = sha256(companyId + routineId + normalizedFailureClass + normalizedScope)
```

Recommended normalized failure classes:

| Routine | Failure class examples | Fingerprint inputs |
|---|---|---|
| CPS active job and worker check | `cps_registry_stale_running_rows`, `cps_api_listener_http_unresponsive`, `cps_worker_heartbeat_stale` | stale running count bucket, API health state, worker heartbeat age bucket |
| Local worker liveness check | `remote_worker_offline`, `paperclip_agent_heartbeat_stale`, `wrapper_probe_failed` | target host/agent name, offline age bucket, wrapper path |
| Market data feed liveness check | `feed_file_stale`, `recorder_process_absent`, `recorder_heartbeat_without_data` | venue, symbol family, freshness threshold, process state |

The key should be coarse enough to aggregate repeat failures, but specific enough that unrelated failures do not hide each other. Example: `market-data:icmarkets:file_stale:300s` and `market-data:ibkr:process_absent` may live under one MIC-135 incident if the incident tracks multiple child fingerprints, but the update payload should retain both fingerprints separately.

## Proposed data shape

Minimum viable implementation can use existing issue fields and metadata; a later schema can formalize it.

### Option A — no schema migration, issue metadata/document mapping

Create or update a machine-owned incident index document/work product with entries like:

```json
{
  "companyId": "c0af1e45-87d5-458f-93d0-996582bcf7b0",
  "routineId": "37ca870a-7022-4a58-831a-b930f6a457bf",
  "incidentKey": "cps-active-job:cps_registry_stale_running_rows:v1",
  "issueId": "...MIC-137 uuid...",
  "issueIdentifier": "MIC-137",
  "status": "open",
  "lastObservedAt": "2026-06-21T09:10:25Z",
  "lastHealthyAt": null,
  "consecutiveHealthy": 0,
  "lastFingerprint": {
    "staleRunningRows": 48,
    "workerRows": 0,
    "cpsApiHttp": "timeout"
  }
}
```

Pros: fast to ship. Cons: concurrent writers need compare/reload discipline.

### Option B — preferred first code change: incident table or routine incident table

Add a company-scoped `routine_incidents` table:

| Column | Purpose |
|---|---|
| `id` | UUID primary key |
| `company_id` | company boundary |
| `routine_id` | source routine |
| `incident_key` | stable idempotency key; unique with company/routine while open |
| `issue_id` | durable Paperclip issue |
| `state` | `open`, `recovering`, `resolved`, `suppressed` |
| `severity` | `info`, `warning`, `critical` |
| `first_seen_at` / `last_seen_at` / `last_healthy_at` | recovery logic |
| `consecutive_failures` / `consecutive_healthy` | debounce |
| `fingerprint` | redacted latest state summary |
| `summary` | short human summary |

Unique index:

```text
(company_id, routine_id, incident_key, state in open/recovering)
```

Use a transaction or upsert so concurrent routine runs cannot create duplicate incidents.

## Routine output contract

Each watchdog should produce a normalized result envelope before any Paperclip mutation:

```json
{
  "status": "healthy | degraded | blocked | error",
  "routineId": "...",
  "routineTitle": "CPS active job and worker check",
  "incidentKey": "...",
  "severity": "warning",
  "observedAt": "2026-06-21T11:13:10Z",
  "summary": "48 stale/suspect CPS running rows; CPS API listener present but HTTP health timeouts",
  "fingerprints": [
    {"key": "cps_registry_stale_running_rows", "value": "48"},
    {"key": "cps_api_http", "value": "timeout"}
  ],
  "metrics": {
    "staleRunningRows": 48,
    "completedArtifactsPresent": "20/20"
  },
  "artifactMarkdown": "...compact markdown report...",
  "safety": {
    "mutatedCpsRegistry": false,
    "startedCompute": false,
    "touchedBroker": false
  }
}
```

The Paperclip mutation layer should refuse to proceed if safety booleans are missing or not false for these routines.

## Mutation algorithm

Pseudocode:

```text
run check read-only
normalize result

if result.status == healthy:
    incident = find_open_incident(companyId, routineId, incidentKey)
    if no incident:
        record routine run healthy only; do not create issue/comment
        exit silently
    update incident counters: consecutiveHealthy += 1, lastHealthyAt = now
    if consecutiveHealthy >= closeThreshold and ageSinceLastFailure >= quietWindow:
        append one recovery comment
        set incident state = recovering or ready_for_board_close
        optionally move issue from blocked to in_progress/todo with clear recovery note
    else:
        no user-facing comment unless previous state was degraded and this is first green
    exit

if result.status in degraded|blocked|error:
    incident = upsert_open_incident(companyId, routineId, incidentKey)
    if incident was created:
        create one high-signal incident issue assigned to owner
        attach first artifact/report
        create primary work product
    else:
        update lastSeenAt, consecutiveFailures, reset consecutiveHealthy
        append compact comment only if:
          - fingerprint materially changed; or
          - severity escalated; or
          - minimum update interval elapsed (recommend 2h); or
          - operator explicitly requested a check
        attach full artifact only at lower cadence (recommend every 6h) or on material change
    never create a disposable duplicate issue
```

## Comment/update rate limits

To keep incidents useful and quiet:

- Healthy/no incident: zero comments/issues.
- Degraded/no existing incident: create one incident issue.
- Degraded/existing incident, unchanged fingerprint: update metadata/run log silently; comment at most every 2 hours.
- Degraded/existing incident, material change: comment immediately, attach artifact.
- Recovery first green: one short comment, then wait for sustained green.
- Sustained recovery: one recovery-ready comment; do not auto-close if human action is required.

Material change examples:

- stale running CPS jobs drop from 48 to 0;
- CPS API `/health` stops timing out;
- a new venue becomes stale or a stale venue becomes fresh;
- a previously offline Tailscale node becomes reachable;
- severity changes warning -> critical.

## Re-enable criteria

Do not re-enable the three paused routines until all criteria pass in a dry-run branch/run:

1. **Idempotency test:** two degraded invocations with same incidentKey create exactly one incident issue and append/update only that issue.
2. **Concurrency test:** two simultaneous degraded invocations cannot create duplicate incidents.
3. **Healthy silence test:** a healthy invocation with no open incident creates no issue and no user-facing comment.
4. **Open incident healthy test:** first healthy check on an open incident records recovery state without closing prematurely.
5. **Sustained recovery test:** incident becomes ready to close only after the configured green window, recommended 3 consecutive healthy checks over at least 60 minutes.
6. **Rate-limit test:** unchanged degraded checks within the 2h update window do not append repetitive comments or artifacts.
7. **Safety test:** CPS routine never runs `worker reap` except verified dry-run in explicit code tests; no check can mutate CPS registry, restart services, launch compute, or touch broker paths.
8. **Backfill mapping:** MIC-135, MIC-136, and MIC-137 are registered as the current open incidents so re-enabled routines append there instead of creating MIC-144+ duplicates.
9. **Operator acceptance:** board/operator explicitly approves reactivation after reviewing a dry-run transcript and the incident index.

## Recommended implementation phases

### Phase 1 — design-only acceptance (this issue)

- Keep routines paused.
- Record this design as the replacement contract.
- Do not mutate CPS registries or routines.

### Phase 2 — build incident writer behind a disabled feature flag

- Add `routine_incidents` table or equivalent durable mapping.
- Add service functions:
  - `normalizeWatchdogResult()`
  - `findOrCreateRoutineIncident()`
  - `appendIncidentUpdateIfNeeded()`
  - `recordRoutineHealthySilently()`
- Add unit tests for idempotency, concurrency, quiet healthy state, rate limiting, and sustained recovery.

### Phase 3 — migrate the three routines to dry-run incident mode

- Existing checks keep read-only diagnostics.
- Instead of creating completion-only liveness issues, each check calls the incident writer in dry-run and logs what would happen.
- Confirm current failures would map to MIC-135/MIC-136/MIC-137.

### Phase 4 — operator-approved re-enable

- Enable only one routine first, preferably Local worker liveness, because it is the least likely to mutate trading/CPS state.
- Observe for 24h.
- Then enable market data, then CPS active job/worker.
- Keep CPS routine last because stale registry rows and dry-run safety have the highest blast radius.

## Current incident-specific desired behavior

### MIC-135 market data

Append to MIC-135 only when venue freshness materially changes. Current unchanged state should not produce a new issue every cadence. Full artifact cadence: at most every 6h unless a venue flips healthy/degraded.

### MIC-136 local worker

Append to MIC-136 only when a host/agent changes liveness class. Current finance-1 offline state should not spam. A single recovery comment is enough when finance-1 returns, followed by sustained-green tracking.

### MIC-137 CPS active jobs/workers

Append to MIC-137 only when stale running count, worker registry, CPS API HTTP health, or process liveness materially changes. Never summarize stale rows as healthy live compute. Never run non-dry `worker reap`, registry cleanup, job cancellation, or service restart from the watchdog.

## Verification performed for this design

Read-only checks only:

- Listed assigned Paperclip issues with localhost `curl`.
- Read MIC-143 details.
- Queried related issue inventory and counted historical liveness floods.
- Read current incident summaries for MIC-135, MIC-136, MIC-137 and prior safety issues MIC-130/MIC-131.
- Queried routine status and confirmed the three noisy routines are paused with disabled schedule triggers.
- Queried agent registry heartbeat state.

No old routine was re-enabled and no registry/service/trading mutation was performed.
